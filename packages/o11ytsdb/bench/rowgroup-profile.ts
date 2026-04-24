import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  initWasmCodecs,
  RowGroupStore,
  ScanEngine,
  type Labels,
  type QueryOpts,
  type ValuesCodec,
} from "../dist/index.js";
import { loadBenchWasmModule, summarizeTimings } from "./common.js";

const NUM_SERIES = 32;
const CHUNK_SIZE = 256;
const NUM_CHUNKS = 1024;
const POINTS_PER_SERIES = CHUNK_SIZE * NUM_CHUNKS;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const INTERVAL = 1_000n;
const COARSE_STEP = BigInt(CHUNK_SIZE) * INTERVAL;
const HALF_CHUNK_STEP = COARSE_STEP / 2n;
const NARROW_START = 32n * INTERVAL;
const NARROW_END = 96n * INTERVAL;
const ENABLE_RANGE_HOOK = process.env.DISABLE_RANGE_HOOK !== "1";
const ENABLE_RANGE_VIEW = process.env.DISABLE_RANGE_VIEW !== "1";
const ENABLE_DECODE_VIEW = process.env.DISABLE_DECODE_VIEW !== "1";
const USE_WASM_ALP = process.env.USE_WASM_ALP === "1";

type QueryCaseName =
  | "sum-coarse"
  | "sum-half-chunk"
  | "sum-narrow-step"
  | "count-half-chunk"
  | "raw-full-read"
  | "raw-narrow-read";

const identityValuesCodec: ValuesCodec = {
  name: "identity",
  encodeValues(values: Float64Array): Uint8Array {
    return new Uint8Array(
      values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength)
    );
  },
  decodeValues(buf: Uint8Array): Float64Array {
    return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  },
};

if (ENABLE_RANGE_HOOK) {
  identityValuesCodec.decodeValuesRange = (
    buf: Uint8Array,
    startIndex: number,
    endIndex: number
  ): Float64Array => {
    if (endIndex <= startIndex) return new Float64Array(0);
    const values = new Float64Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 8));
    return values.slice(startIndex, endIndex);
  };
}

const QUERY_CASES: Record<QueryCaseName, Omit<QueryOpts, "metric" | "start" | "end">> = {
  "sum-coarse": { agg: "sum", step: COARSE_STEP },
  "sum-half-chunk": { agg: "sum", step: HALF_CHUNK_STEP },
  "sum-narrow-step": { agg: "sum", step: INTERVAL },
  "count-half-chunk": { agg: "count", step: HALF_CHUNK_STEP },
  "raw-full-read": {},
  "raw-narrow-read": {},
};

function makeLabels(seriesIndex: number): Labels {
  return new Map([
    ["__name__", "cpu_usage"],
    ["host", `host-${seriesIndex.toString().padStart(2, "0")}`],
    ["region", seriesIndex % 2 === 0 ? "us" : "eu"],
  ]);
}

function makeSeriesData(seriesIndex: number): {
  timestamps: BigInt64Array;
  values: Float64Array;
} {
  const timestamps = new BigInt64Array(POINTS_PER_SERIES);
  const values = new Float64Array(POINTS_PER_SERIES);
  const base = 100 + seriesIndex * 10;
  for (let i = 0; i < POINTS_PER_SERIES; i++) {
    timestamps[i] = BigInt(i) * INTERVAL;
    values[i] = base + (i % 10_000);
  }
  return { timestamps, values };
}

function fingerprintResult(result: {
  scannedSeries: number;
  scannedSamples: number;
  series: Array<{
    labels: ReadonlyMap<string, string>;
    timestamps: BigInt64Array;
    values: Float64Array;
  }>;
}): string {
  let out = `${result.scannedSeries}:${result.scannedSamples}:${result.series.length}`;
  for (const series of result.series) {
    const firstTs = series.timestamps[0] ?? 0n;
    const lastTs = series.timestamps[series.timestamps.length - 1] ?? 0n;
    const firstV = series.values[0] ?? 0;
    const lastV = series.values[series.values.length - 1] ?? 0;
    out += `|${series.labels.get("host") ?? "all"}:${series.timestamps.length}:${firstTs}:${lastTs}:${firstV}:${lastV}`;
  }
  return out;
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function sessionPost<T>(session: Session, method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (error, result) => {
      if (error) reject(error);
      else resolve(result as T);
    });
  });
}

async function main() {
  const queryName = (process.argv[2] ?? "sum-coarse") as QueryCaseName;
  const outDir = path.resolve(process.argv[3] ?? "bench/results/profiles");
  const iterations = Number.parseInt(process.argv[4] ?? "6", 10);
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`iterations must be an integer >= 1, got ${process.argv[4] ?? "6"}`);
  }
  if (!Object.hasOwn(QUERY_CASES, queryName)) {
    throw new Error(`unknown query case: ${queryName}`);
  }

  await mkdir(outDir, { recursive: true });

  const codecs = USE_WASM_ALP
      ? await initWasmCodecs(loadBenchWasmModule())
    : null;
  const baseValuesCodec = codecs?.valuesCodec ?? identityValuesCodec;
  const valuesCodec: ValuesCodec = {
    ...baseValuesCodec,
    decodeValuesRange: ENABLE_RANGE_HOOK ? baseValuesCodec.decodeValuesRange : undefined,
    decodeValuesRangeView: ENABLE_RANGE_VIEW ? baseValuesCodec.decodeValuesRangeView : undefined,
    decodeValuesView: ENABLE_DECODE_VIEW ? baseValuesCodec.decodeValuesView : undefined,
  };
  const tsCodec = codecs?.tsCodec;
  const store = new RowGroupStore(valuesCodec, CHUNK_SIZE, () => 0, 8, undefined, tsCodec);
  for (let s = 0; s < NUM_SERIES; s++) {
    const id = store.getOrCreateSeries(makeLabels(s));
    const { timestamps, values } = makeSeriesData(s);
    store.appendBatch(id, timestamps, values);
  }

  const engine = new ScanEngine();
  const queryOpts: QueryOpts = {
    metric: "cpu_usage",
    start: queryName === "raw-narrow-read" || queryName === "sum-narrow-step" ? NARROW_START : 0n,
    end:
      queryName === "raw-narrow-read" || queryName === "sum-narrow-step"
        ? NARROW_END
        : BigInt(POINTS_PER_SERIES) * INTERVAL,
    ...QUERY_CASES[queryName],
  };

  const warmResult = engine.query(store, queryOpts);
  const warmFingerprint = fingerprintResult(warmResult);

  const session = new Session();
  session.connect();
  await sessionPost(session, "Profiler.enable");
  await sessionPost(session, "HeapProfiler.enable");
  await sessionPost(session, "HeapProfiler.startSampling", { samplingInterval: 32 * 1024 });
  await sessionPost(session, "Profiler.start");

  const beforeMemory = memorySnapshot();
  const samples: number[] = [];
  let fingerprintStable = true;
  let finalFingerprint = warmFingerprint;
  let finalStats = {
    scannedSeries: warmResult.scannedSeries,
    scannedSamples: warmResult.scannedSamples,
    resultSeries: warmResult.series.length,
  };

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const result = engine.query(store, queryOpts);
    samples.push(performance.now() - t0);
    const thisFingerprint = fingerprintResult(result);
    if (thisFingerprint !== warmFingerprint) {
      fingerprintStable = false;
    }
    finalFingerprint = thisFingerprint;
    finalStats = {
      scannedSeries: result.scannedSeries,
      scannedSamples: result.scannedSamples,
      resultSeries: result.series.length,
    };
  }

  const afterMemory = memorySnapshot();
  const cpuProfile = await sessionPost<{ profile: unknown }>(session, "Profiler.stop");
  const heapProfile = await sessionPost<{ profile: unknown }>(session, "HeapProfiler.stopSampling");
  session.disconnect();

  const runtimeConfig = [
    queryName,
    USE_WASM_ALP ? "wasm-alp" : "identity",
    ENABLE_RANGE_HOOK ? "range" : "no-range",
    ENABLE_RANGE_VIEW ? "range-view" : "no-range-view",
    ENABLE_DECODE_VIEW ? "decode-view" : "no-decode-view",
  ].join(".");
  const cpuProfilePath = path.join(outDir, `${runtimeConfig}.cpuprofile.json`);
  const heapProfilePath = path.join(outDir, `${runtimeConfig}.heapprofile.json`);
  await writeFile(cpuProfilePath, JSON.stringify(cpuProfile.profile));
  await writeFile(heapProfilePath, JSON.stringify(heapProfile.profile));

  const summary = {
    queryName,
    runtimeConfig,
    codec: valuesCodec.name,
    toggles: {
      useWasmAlp: USE_WASM_ALP,
      enableRangeHook: ENABLE_RANGE_HOOK,
      enableRangeView: ENABLE_RANGE_VIEW,
      enableDecodeView: ENABLE_DECODE_VIEW,
    },
    dataset: {
      series: NUM_SERIES,
      pointsPerSeries: POINTS_PER_SERIES,
      totalSamples: TOTAL_SAMPLES,
      chunkSize: CHUNK_SIZE,
      chunksPerSeries: NUM_CHUNKS,
    },
    query: {
      metric: queryOpts.metric,
      agg: queryOpts.agg ?? null,
      step: queryOpts.step?.toString() ?? null,
      start: queryOpts.start.toString(),
      end: queryOpts.end.toString(),
    },
    timing: summarizeTimings(samples),
    memory: {
      before: beforeMemory,
      after: afterMemory,
      delta: {
        rss: afterMemory.rss - beforeMemory.rss,
        heapTotal: afterMemory.heapTotal - beforeMemory.heapTotal,
        heapUsed: afterMemory.heapUsed - beforeMemory.heapUsed,
        external: afterMemory.external - beforeMemory.external,
        arrayBuffers: afterMemory.arrayBuffers - beforeMemory.arrayBuffers,
      },
    },
    result: {
      warmFingerprint,
      finalFingerprint,
      fingerprintStable,
      ...finalStats,
    },
    profiles: {
      cpuProfilePath,
      heapProfilePath,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
