import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BenchReport } from "./harness.js";
import { printReport, Suite } from "./harness.js";
import { loadWasm, makeCodecImpl } from "./wasm-loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

type Codec = import("./types.js").Codec;
type StorageBackend = import("./types.js").StorageBackend;

const NUM_SERIES = 1_000;
const POINTS_PER_SERIES = 1_024;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const CHUNK_SIZE = 640;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n;
const STEP_1M = 60_000n;
const STEP_4H = 14_400_000n;
const REGIONS = ["us-east", "us-west", "eu-west", "ap-south"] as const;

async function loadStore(): Promise<StorageBackend> {
  try {
    const { ChunkedStore } = await import(pkgPath("dist/chunked-store.js"));
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const rustImpl = makeCodecImpl(wasm, "rust", "Rust→WASM");
    const codec: Codec = {
      name: "rust-wasm",
      encode: rustImpl.encode,
      decode: rustImpl.decode,
    };
    return new ChunkedStore(codec, CHUNK_SIZE);
  } catch {
    const { FlatStore } = await import(pkgPath("dist/flat-store.js"));
    return new FlatStore();
  }
}

function makeTimestamps(): BigInt64Array {
  const ts = new BigInt64Array(POINTS_PER_SERIES);
  for (let i = 0; i < POINTS_PER_SERIES; i++) {
    ts[i] = T0 + BigInt(i) * INTERVAL;
  }
  return ts;
}

function makeValues(seriesIndex: number): Float64Array {
  const values = new Float64Array(POINTS_PER_SERIES);
  let v = 1_000 + seriesIndex * 10;
  for (let i = 0; i < POINTS_PER_SERIES; i++) {
    v += 1 + (seriesIndex % 7) + (i % 3);
    if ((i + 1) % 400 === 0 && seriesIndex % 11 === 0) {
      v = 100 + seriesIndex;
    }
    values[i] = v;
  }
  return values;
}

async function populateStore(store: StorageBackend): Promise<void> {
  const sharedTs = makeTimestamps();
  for (let s = 0; s < NUM_SERIES; s++) {
    const labels = new Map<string, string>();
    labels.set("__name__", "cpu");
    labels.set("host", `host-${String(s).padStart(4, "0")}`);
    labels.set("region", REGIONS[s % REGIONS.length]!);
    labels.set("shard", `s${s % 10}`);
    const id = store.getOrCreateSeries(labels);
    store.appendBatch(id, sharedTs, makeValues(s));
  }
}

export default async function (): Promise<BenchReport> {
  const suite = new Suite("query");
  const store = await loadStore();
  const { query } = await import(pkgPath("dist/query-builder.js"));

  await populateStore(store);

  const end = T0 + BigInt(POINTS_PER_SERIES - 1) * INTERVAL;

  console.log(
    `  Configuration: ${NUM_SERIES.toLocaleString()} series × ${POINTS_PER_SERIES.toLocaleString()} pts = ${TOTAL_SAMPLES.toLocaleString()} total`
  );
  console.log(`  Store: ${store.name}`);
  console.log();

  const runtime = store.name;

  suite.add(
    "raw-single",
    runtime,
    () => {
      query().metric("cpu").where("host", "=", "host-0000").range(T0, end).exec(store);
    },
    { warmup: 5, iterations: 20, itemsPerCall: POINTS_PER_SERIES, unit: "samples/sec" }
  );

  suite.add(
    "raw-100",
    runtime,
    () => {
      query().metric("cpu").where("shard", "=", "s0").range(T0, end).exec(store);
    },
    { warmup: 5, iterations: 15, itemsPerCall: 100 * POINTS_PER_SERIES, unit: "samples/sec" }
  );

  suite.add(
    "sum-1m-100",
    runtime,
    () => {
      query().metric("cpu").where("shard", "=", "s0").range(T0, end).step(STEP_1M).sum().exec(store);
    },
    { warmup: 5, iterations: 15, itemsPerCall: 100 * POINTS_PER_SERIES, unit: "samples/sec" }
  );

  suite.add(
    "sum-4h-100",
    runtime,
    () => {
      query().metric("cpu").where("shard", "=", "s0").range(T0, end).step(STEP_4H).sum().exec(store);
    },
    { warmup: 5, iterations: 15, itemsPerCall: 100 * POINTS_PER_SERIES, unit: "samples/sec" }
  );

  suite.add(
    "avg-1m-1k",
    runtime,
    () => {
      query().metric("cpu").range(T0, end).step(STEP_1M).avg().exec(store);
    },
    { warmup: 5, iterations: 10, itemsPerCall: TOTAL_SAMPLES, unit: "samples/sec" }
  );

  suite.add(
    "rate-1m-100",
    runtime,
    () => {
      query().metric("cpu").where("shard", "=", "s0").range(T0, end).rate().step(STEP_1M).exec(store);
    },
    { warmup: 5, iterations: 15, itemsPerCall: 100 * POINTS_PER_SERIES, unit: "samples/sec" }
  );

  suite.add(
    "rate-sumBy-1m-100",
    runtime,
    () => {
      query()
        .metric("cpu")
        .where("shard", "=", "s0")
        .range(T0, end)
        .step(STEP_1M)
        .rate()
        .sumBy("region")
        .exec(store);
    },
    { warmup: 5, iterations: 15, itemsPerCall: 100 * POINTS_PER_SERIES, unit: "samples/sec" }
  );

  suite.add(
    "p50-1m-100",
    runtime,
    () => {
      query().metric("cpu").where("shard", "=", "s0").range(T0, end).step(STEP_1M).p50().exec(store);
    },
    { warmup: 5, iterations: 10, itemsPerCall: 100 * POINTS_PER_SERIES, unit: "samples/sec" }
  );

  suite.add(
    "p99-1m-100",
    runtime,
    () => {
      query().metric("cpu").where("shard", "=", "s0").range(T0, end).step(STEP_1M).p99().exec(store);
    },
    { warmup: 5, iterations: 10, itemsPerCall: 100 * POINTS_PER_SERIES, unit: "samples/sec" }
  );

  suite.add(
    "regex-match-1k",
    runtime,
    () => {
      query().metric("cpu").where("host", "=~", "host-0[0-9]{3}").range(T0, end).exec(store);
    },
    { warmup: 5, iterations: 10, itemsPerCall: TOTAL_SAMPLES, unit: "samples/sec" }
  );

  const report = suite.run();
  printReport(report);
  return report;
}
