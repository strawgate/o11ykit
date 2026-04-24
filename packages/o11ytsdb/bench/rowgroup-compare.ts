import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

type QueryOpts = {
  metric: string;
  start: bigint;
  end: bigint;
  agg?: string;
  step?: bigint;
};

type QueryCase = {
  name: string;
  opts: Partial<QueryOpts>;
};

type BenchStats = {
  medianMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];
  fingerprint: string;
};

type VersionResult = {
  version: string;
  results: Record<string, BenchStats>;
};

type QueryModule = {
  ScanEngine: new () => {
    query: (
      storage: unknown,
      opts: QueryOpts
    ) => {
      scannedSeries: number;
      scannedSamples: number;
      series: Array<{
        labels: ReadonlyMap<string, string>;
        timestamps: BigInt64Array;
        values: Float64Array;
      }>;
    };
  };
};

type RowGroupModule = {
  RowGroupStore: new (
    valuesCodec: {
      name: string;
      encodeValues(values: Float64Array): Uint8Array;
      decodeValues(buf: Uint8Array): Float64Array;
      decodeValuesRange?(buf: Uint8Array, startIndex: number, endIndex: number): Float64Array;
    },
    chunkSize?: number,
    groupResolver?: (labels: ReadonlyMap<string, string>) => number,
    maxSeriesPerLane?: number
  ) => {
    getOrCreateSeries(labels: ReadonlyMap<string, string>): number;
    appendBatch(id: number, timestamps: BigInt64Array, values: Float64Array): void;
  };
};

const identityValuesCodec = {
  name: "identity",
  encodeValues(values: Float64Array): Uint8Array {
    return new Uint8Array(
      values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength)
    );
  },
  decodeValues(buf: Uint8Array): Float64Array {
    return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  },
  decodeValuesRange(buf: Uint8Array, startIndex: number, endIndex: number): Float64Array {
    if (endIndex <= startIndex) return new Float64Array(0);
    const values = new Float64Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 8));
    return values.slice(startIndex, endIndex);
  },
};

const NUM_SERIES = 8;
const CHUNK_SIZE = 256;
const NUM_CHUNKS = 128;
const TOTAL_POINTS = CHUNK_SIZE * NUM_CHUNKS;
const INTERVAL = 1_000n;
const CHUNK_SPAN = BigInt(CHUNK_SIZE) * INTERVAL;
const NARROW_START = 32n * INTERVAL;
const NARROW_END = 95n * INTERVAL;

const QUERY_CASES: QueryCase[] = [
  { name: "sum/coarse-step", opts: { agg: "sum", step: CHUNK_SPAN } },
  { name: "avg/coarse-step", opts: { agg: "avg", step: CHUNK_SPAN } },
  { name: "count/coarse-step", opts: { agg: "count", step: CHUNK_SPAN } },
  { name: "last/coarse-step", opts: { agg: "last", step: CHUNK_SPAN } },
  { name: "sum/half-chunk-step", opts: { agg: "sum", step: CHUNK_SPAN / 2n } },
  { name: "count/half-chunk-step", opts: { agg: "count", step: CHUNK_SPAN / 2n } },
  { name: "rate/coarse-step", opts: { agg: "rate", step: CHUNK_SPAN } },
  { name: "raw/full-read", opts: {} },
  { name: "raw/narrow-read", opts: { start: NARROW_START, end: NARROW_END } },
];

function makeLabels(seriesIndex: number): ReadonlyMap<string, string> {
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
  const timestamps = new BigInt64Array(TOTAL_POINTS);
  const values = new Float64Array(TOTAL_POINTS);
  const base = 100 + seriesIndex * 10;
  for (let i = 0; i < TOTAL_POINTS; i++) {
    timestamps[i] = BigInt(i) * INTERVAL;
    values[i] = base + i;
  }
  return { timestamps, values };
}

function summarize(samples: number[]): Omit<BenchStats, "fingerprint"> {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
        ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
        : (sorted[mid] ?? 0);
  const avgMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    medianMs,
    avgMs,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    samples,
  };
}

function labelsKey(labels: ReadonlyMap<string, string>): string {
  return [...labels.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
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
  let acc = `${result.scannedSeries}:${result.scannedSamples}:${result.series.length}`;
  for (const series of result.series) {
    const firstTs = series.timestamps[0] ?? 0n;
    const lastTs = series.timestamps[series.timestamps.length - 1] ?? 0n;
    const firstV = series.values[0] ?? 0;
    const lastV = series.values[series.values.length - 1] ?? 0;
    const midV = series.values[Math.floor(series.values.length / 2)] ?? 0;
    acc += `|${labelsKey(series.labels)}:${series.timestamps.length}:${firstTs}:${lastTs}:${firstV}:${midV}:${lastV}`;
  }
  return acc;
}

async function importVersion<T>(srcDir: string, fileName: string): Promise<T> {
  const ref = pathToFileURL(path.join(srcDir, fileName)).href;
  return import(`${ref}?t=${Date.now()}-${Math.random()}`) as Promise<T>;
}

async function loadModules(srcDir: string): Promise<{
  query: QueryModule;
  rowGroup: RowGroupModule;
}> {
  const [query, rowGroup] = await Promise.all([
    importVersion<QueryModule>(srcDir, "query.ts"),
    importVersion<RowGroupModule>(srcDir, "row-group-store.ts"),
  ]);
  return { query, rowGroup };
}

async function runVersion(version: string, srcDir: string): Promise<VersionResult> {
  const { query, rowGroup } = await loadModules(srcDir);
  const engine = new query.ScanEngine();
  const store = new rowGroup.RowGroupStore(identityValuesCodec, CHUNK_SIZE, () => 0, 4);

  for (let s = 0; s < NUM_SERIES; s++) {
    const id = store.getOrCreateSeries(makeLabels(s));
    const { timestamps, values } = makeSeriesData(s);
    store.appendBatch(id, timestamps, values);
  }

  const baseOpts = {
    metric: "cpu_usage",
    start: 0n,
    end: BigInt(TOTAL_POINTS - 1) * INTERVAL,
  };

  const results: Record<string, BenchStats> = {};

  for (const queryCase of QUERY_CASES) {
    const opts = { ...baseOpts, ...queryCase.opts };
    const baseline = engine.query(store, opts);
    const baselineFingerprint = fingerprintResult(baseline);

    for (let i = 0; i < 2; i++) {
      engine.query(store, opts);
    }

    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      const result = engine.query(store, opts);
      samples.push(performance.now() - t0);
      if (fingerprintResult(result) !== baselineFingerprint) {
        throw new Error(`fingerprint mismatch for ${version} / ${queryCase.name}`);
      }
    }

    results[queryCase.name] = {
      ...summarize(samples),
      fingerprint: baselineFingerprint,
    };
  }

  return { version, results };
}

function printComparison(before: VersionResult, after: VersionResult): void {
  console.log(
    JSON.stringify(
      {
        dataset: {
          series: NUM_SERIES,
          pointsPerSeries: TOTAL_POINTS,
          totalSamples: NUM_SERIES * TOTAL_POINTS,
          chunkSize: CHUNK_SIZE,
          chunksPerSeries: NUM_CHUNKS,
        },
        queries: QUERY_CASES.map((queryCase) => {
          const beforeStats = before.results[queryCase.name];
          const afterStats = after.results[queryCase.name];
          if (!beforeStats || !afterStats) {
            throw new Error(`missing results for ${queryCase.name}`);
          }
          return {
            name: queryCase.name,
            beforeMedianMs: beforeStats.medianMs,
            afterMedianMs: afterStats.medianMs,
            deltaPct: ((afterStats.medianMs - beforeStats.medianMs) / beforeStats.medianMs) * 100,
            speedup: beforeStats.medianMs / afterStats.medianMs,
            beforeAvgMs: beforeStats.avgMs,
            afterAvgMs: afterStats.avgMs,
            fingerprintStable: beforeStats.fingerprint === afterStats.fingerprint,
            beforeSamples: beforeStats.samples,
            afterSamples: afterStats.samples,
          };
        }),
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const beforeArg = process.argv[2];
  const afterArg = process.argv[3];
  if (!beforeArg || !afterArg) {
    throw new Error("usage: rowgroup-compare.ts <before-src-dir> <after-src-dir>");
  }
  const beforeSrc = path.resolve(beforeArg);
  const afterSrc = path.resolve(afterArg);

  const before = await runVersion("before", beforeSrc);
  const after = await runVersion("after", afterSrc);
  printComparison(before, after);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
