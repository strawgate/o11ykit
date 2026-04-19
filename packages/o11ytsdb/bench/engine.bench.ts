/**
 * Engine benchmark — end-to-end experimentation bench.
 *
 * Compares storage backends × codec configurations across:
 *   1. Ingest throughput (samples/sec)
 *   2. Query throughput (single-series, multi-series, aggregated)
 *   3. Memory at rest (bytes/sample, compression ratio)
 *
 * This is the experimentation framework: add a new StorageBackend or
 * Codec, it automatically gets benchmarked against all others.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchReport } from "./harness.js";
import { fmt, fmtBytes, printReport, Suite } from "./harness.js";
import { generateLabelSets, Rng } from "./vectors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

// ── Types (import from compiled src) ─────────────────────────────────

type StorageBackend = import("../dist/types.js").StorageBackend;
type Codec = import("../dist/types.js").Codec;
type Labels = import("../dist/types.js").Labels;
type QueryEngine = import("../dist/types.js").QueryEngine;

// ── Configuration ────────────────────────────────────────────────────

const NUM_SERIES = 100;
const POINTS_PER_SERIES = 10_000;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const CHUNK_SIZE = 640;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n; // 15s

// ── Load implementations ─────────────────────────────────────────────

async function loadBackends(): Promise<StorageBackend[]> {
  const backends: StorageBackend[] = [];

  // FlatStore (baseline — no compression).
  try {
    const { FlatStore } = await import(pkgPath("dist/flat-store.js"));
    backends.push(new FlatStore());
  } catch (_e) {
    console.log("  ⚠ FlatStore not built — skipping");
  }

  // ChunkedStore with XOR-delta (Gorilla) codec.
  try {
    const { ChunkedStore } = await import(pkgPath("dist/chunked-store.js"));
    const { loadWasm, makeCodecImpl } = await import("./wasm-loader.js");
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const rustImpl = makeCodecImpl(wasm, "rust", "Rust→WASM");
    const rustCodec: Codec = {
      name: "rust-wasm",
      encode: rustImpl.encode,
      decode: rustImpl.decode,
    };
    backends.push(new ChunkedStore(rustCodec, CHUNK_SIZE));
  } catch (e) {
    console.log(`  ⚠ Rust WASM codec not available — skipping (${(e as Error).message})`);
  }

  // ColumnStore with XOR-delta values (shared timestamps, uncompressed ts).
  try {
    const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
    const { loadWasm, makeValuesCodec } = await import("./wasm-loader.js");
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const wasmVals = makeValuesCodec(wasm);
    backends.push(
      new ColumnStore(
        {
          name: "rust-wasm-values",
          encodeValues: wasmVals.encodeValues,
          decodeValues: wasmVals.decodeValues,
          encodeValuesWithStats: wasmVals.encodeValuesWithStats,
        },
        CHUNK_SIZE,
        () => 0
      )
    );
  } catch (e) {
    console.log(`  ⚠ ColumnStore/XOR not available — skipping (${(e as Error).message})`);
  }

  // ColumnStore with XOR values + delta-of-delta timestamp compression.
  try {
    const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
    const { loadWasm, makeValuesCodec, makeTimestampCodec } = await import("./wasm-loader.js");
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const wasmVals = makeValuesCodec(wasm);
    const wasmTs = makeTimestampCodec(wasm);
    backends.push(
      new ColumnStore(
        {
          name: "rust-wasm-full",
          encodeValues: wasmVals.encodeValues,
          decodeValues: wasmVals.decodeValues,
          encodeValuesWithStats: wasmVals.encodeValuesWithStats,
        },
        CHUNK_SIZE,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        }
      )
    );
  } catch (e) {
    console.log(`  ⚠ ColumnStore/XOR+TS not available — skipping (${(e as Error).message})`);
  }

  // ColumnStore with ALP values + delta-of-delta timestamps (no range-decode).
  try {
    const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
    const { loadWasm, makeALPValuesCodec, makeTimestampCodec } = await import("./wasm-loader.js");
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const alpVals = makeALPValuesCodec(wasm);
    const wasmTs = makeTimestampCodec(wasm);
    backends.push(
      new ColumnStore(
        {
          name: "alp-full",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        CHUNK_SIZE,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        }
      )
    );
  } catch (e) {
    console.log(`  ⚠ ColumnStore/ALP not available — skipping (${(e as Error).message})`);
  }

  // ColumnStore with ALP values + timestamps + fused range-decode (best config).
  try {
    const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
    const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } = await import(
      "./wasm-loader.js"
    );
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const alpVals = makeALPValuesCodec(wasm);
    const wasmTs = makeTimestampCodec(wasm);
    const rangeCodec = makeALPRangeCodec(wasm);
    backends.push(
      new ColumnStore(
        {
          name: "alp-range",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        CHUNK_SIZE,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        },
        rangeCodec
      )
    );
  } catch (e) {
    console.log(`  ⚠ ColumnStore/ALP+range not available — skipping (${(e as Error).message})`);
  }

  // RowGroupStore with ALP values + timestamps (row-group packing, no range-decode).
  try {
    const { RowGroupStore } = await import(pkgPath("dist/row-group-store.js"));
    const { loadWasm, makeALPValuesCodec, makeTimestampCodec } = await import("./wasm-loader.js");
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const alpVals = makeALPValuesCodec(wasm);
    const wasmTs = makeTimestampCodec(wasm);
    backends.push(
      new RowGroupStore(
        {
          name: "rg-alp-full",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        CHUNK_SIZE,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        }
      )
    );
  } catch (e) {
    console.log(`  ⚠ RowGroupStore/ALP not available — skipping (${(e as Error).message})`);
  }

  // RowGroupStore with ALP values + timestamps + fused range-decode.
  try {
    const { RowGroupStore } = await import(pkgPath("dist/row-group-store.js"));
    const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } = await import(
      "./wasm-loader.js"
    );
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const alpVals = makeALPValuesCodec(wasm);
    const wasmTs = makeTimestampCodec(wasm);
    const rangeCodec = makeALPRangeCodec(wasm);
    backends.push(
      new RowGroupStore(
        {
          name: "rg-alp-range",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        CHUNK_SIZE,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        },
        rangeCodec
      )
    );
  } catch (e) {
    console.log(`  ⚠ RowGroupStore/ALP+range not available — skipping (${(e as Error).message})`);
  }

  // ColumnStore with ALP + precision=3 (decimal quantization on ingest, eliminates exceptions).
  try {
    const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
    const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } = await import(
      "./wasm-loader.js"
    );
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);
    const alpVals = makeALPValuesCodec(wasm);
    const wasmTs = makeTimestampCodec(wasm);
    const rangeCodec = makeALPRangeCodec(wasm);
    backends.push(
      new ColumnStore(
        {
          name: "alp-p3",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        CHUNK_SIZE,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        },
        rangeCodec,
        undefined, // labelIndex
        3 // precision — round to 3 decimal places
      )
    );
  } catch (e) {
    console.log(`  ⚠ ColumnStore/ALP+p3 not available — skipping (${(e as Error).message})`);
  }

  return backends;
}

async function loadQueryEngine(): Promise<QueryEngine> {
  const { ScanEngine } = await import(pkgPath("dist/query.js"));
  return new ScanEngine();
}

// ── Data generation ──────────────────────────────────────────────────

interface IngestData {
  labels: Labels[];
  timestamps: BigInt64Array[];
  values: Float64Array[];
}

function generateData(): IngestData {
  const rng = new Rng(42);
  const labelSets = generateLabelSets(NUM_SERIES, 4, 42);
  const labels: Labels[] = [];
  const timestamps: BigInt64Array[] = [];
  const values: Float64Array[] = [];

  for (let s = 0; s < NUM_SERIES; s++) {
    const ls = labelSets[s]!;
    const m = new Map<string, string>();
    m.set("__name__", `metric_${s % 10}`); // 10 distinct metric names
    for (const [k, v] of ls.labels) m.set(k, v);
    labels.push(m);

    const ts = new BigInt64Array(POINTS_PER_SERIES);
    const vs = new Float64Array(POINTS_PER_SERIES);

    // Distribution modeled on real OTel host-metrics data:
    //
    //   pattern 0    (10%) — constant (num_cpus, memory_total)
    //   pattern 1    (10%) — counter, small integers (disk_ops, net_packets)
    //   pattern 2    (10%) — counter, large integers (net_io bytes, ~10^11)
    //   pattern 3    (10%) — gauge, 2dp (cpu_time, load_average)
    //   pattern 4    (10%) — gauge, 3dp (disk_io_time, op_time)
    //   pattern 5    (10%) — gauge, 11dp (memory.utilization — ALP-clean)
    //   pattern 6    (10%) — gauge, 12dp (filesystem.utilization — ALP-clean)
    //   pattern 7-8  (20%) — high-precision ratio (cpu.utilization — ALP exceptions, ~19dp)
    //   pattern 9    (10%) — high-variance gauge, 2dp (latency-like)
    const pattern = s % 10;

    if (pattern === 0) {
      // Constant series: value never changes.
      const constant = Math.round(rng.next() * 1000) / 10;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        vs[i] = constant;
      }
    } else if (pattern === 1) {
      // Counter: monotonically increasing, small integer increments.
      let counter = Math.floor(rng.next() * 10000);
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        const idle = rng.next() < 0.4;
        if (!idle) counter += Math.floor(rng.next() * 10) + 1;
        vs[i] = counter;
      }
    } else if (pattern === 2) {
      // Counter: large integers (~10^10-10^11, like network bytes).
      let counter = Math.floor(rng.next() * 1e10) + 1e10;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        const idle = rng.next() < 0.3;
        if (!idle) counter += Math.floor(rng.next() * 100000) + 1;
        vs[i] = counter;
      }
    } else if (pattern === 3) {
      // Gauge with 2dp: cpu_time, load_average style.
      let v = Math.round(rng.next() * 10000) / 100; // e.g. 17.64
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.05);
        v = Math.max(0, v);
        vs[i] = Math.round(v * 100) / 100;
      }
    } else if (pattern === 4) {
      // Gauge with 3dp: disk_io_time, operation_time style.
      let v = rng.next() * 500; // e.g. 242.308
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.02);
        v = Math.max(0, v);
        vs[i] = Math.round(v * 1000) / 1000;
      }
    } else if (pattern === 5) {
      // Gauge with 11dp: memory.utilization style.
      // Values like 0.10774188717 — these ARE ALP-clean at e=11.
      let base = rng.next() * 0.5 + 0.05; // [0.05, 0.55]
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        base += rng.gaussian(0, 0.0001);
        base = Math.max(0, Math.min(1, base));
        vs[i] = Math.round(base * 1e11) / 1e11;
      }
    } else if (pattern === 6) {
      // Gauge with 12dp: filesystem.utilization style.
      // Values like 0.356793610702 — ALP-clean at e=12.
      let base = rng.next() * 0.4 + 0.1; // [0.1, 0.5]
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        base += rng.gaussian(0, 0.000001);
        base = Math.max(0, Math.min(1, base));
        vs[i] = Math.round(base * 1e12) / 1e12;
      }
    } else if (pattern === 7 || pattern === 8) {
      // High-precision ratio: cpu.utilization style.
      // Values like 0.021290751829661093 — full f64 precision,
      // NOT ALP-clean at any exponent. These become FoR-u64 exceptions.
      // Simulates kernel returning ratio = ticks / total_ticks.
      let ticks = Math.floor(rng.next() * 1e6);
      let totalTicks = Math.floor(1e7 + rng.next() * 1e6);
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        const newTicks = Math.floor(rng.next() * 200) + 1;
        const newTotal = 1000; // constant interval length
        ticks += newTicks;
        totalTicks += newTotal;
        // Division produces high-precision f64 — not round-trippable through ALP.
        vs[i] = ticks / totalTicks;
      }
    } else {
      // High-variance gauge with 2dp: latency-like random walk.
      let v = rng.next() * 100;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.5);
        v = Math.max(0, v);
        vs[i] = Math.round(v * 100) / 100;
      }
    }

    timestamps.push(ts);
    values.push(vs);
  }

  return { labels, timestamps, values };
}

// ── Benchmark ────────────────────────────────────────────────────────

export default async function (): Promise<BenchReport> {
  const suite = new Suite("engine");
  const backends = await loadBackends();
  const qe = await loadQueryEngine();
  const data = generateData();

  console.log(
    `  Configuration: ${NUM_SERIES} series × ${POINTS_PER_SERIES.toLocaleString()} pts = ${TOTAL_SAMPLES.toLocaleString()} total`
  );
  console.log(`  Backends: ${backends.map((b) => b.name).join(", ")}`);
  console.log(`  Query engine: ${qe.name}`);
  console.log();

  // ── Ingest benchmark ──

  console.log("  ── Ingest ──\n");

  // Populate all backends (measured).
  const populated: StorageBackend[] = [];

  for (const backend of backends) {
    // Create a fresh backend for each run.
    const fresh = await freshBackend(backend.name);
    const start = performance.now();

    // Register all series first so every group member exists before
    // ingestion starts. Then ingest in chunk-sized interleaved batches
    // so the column store's maybeFreeze sees all members filling
    // together — matching real OTLP scrape arrival patterns.
    const ids: number[] = [];
    for (let s = 0; s < NUM_SERIES; s++) {
      ids.push(fresh.getOrCreateSeries(data.labels[s]!));
    }
    for (let offset = 0; offset < POINTS_PER_SERIES; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, POINTS_PER_SERIES);
      for (let s = 0; s < NUM_SERIES; s++) {
        fresh.appendBatch(
          ids[s]!,
          data.timestamps[s]!.subarray(offset, end),
          data.values[s]!.subarray(offset, end)
        );
      }
    }

    const elapsed = performance.now() - start;
    const throughput = TOTAL_SAMPLES / (elapsed / 1000);

    suite.add(
      `ingest_batch`,
      fresh.name,
      () => {
        // Already measured above — this is a no-op placeholder.
        // We recorded the real measurement manually.
      },
      { iterations: 1, itemsPerCall: TOTAL_SAMPLES, unit: "samples/sec" }
    );

    // Record as a compression result for the memory table.
    suite.addCompression(
      "at_rest",
      fresh.name,
      TOTAL_SAMPLES,
      TOTAL_SAMPLES * 16, // raw = 16 bytes/sample
      fresh.memoryBytes()
    );

    populated.push(fresh);

    const mem = fresh.memoryBytes();
    console.log(
      `    ${fresh.name.padEnd(28)} ${fmt(throughput).padStart(10)} samples/sec    ${fmtBytes(mem).padStart(10)}    ${(mem / TOTAL_SAMPLES).toFixed(1)} B/pt`
    );
  }

  console.log();

  // ── Query benchmarks ──

  console.log("  ── Query: single series (full range) ──\n");

  for (const store of populated) {
    // Pick series 0, full range.
    const sid = 0;
    const start = T0;
    const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;

    suite.add(
      "query_single",
      store.name,
      () => {
        store.read(sid, start, end);
      },
      { warmup: 10, iterations: 50, itemsPerCall: POINTS_PER_SERIES, unit: "samples/sec" }
    );
  }

  console.log("  ── Query: multi-series select (10 series, full range) ──\n");

  for (const store of populated) {
    const metric = "metric_0"; // 10 series match
    const start = T0;
    const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;

    suite.add(
      "query_select_10",
      store.name,
      () => {
        qe.query(store, { metric, start, end });
      },
      { warmup: 5, iterations: 20, itemsPerCall: 10 * POINTS_PER_SERIES, unit: "samples/sec" }
    );
  }

  console.log("  ── Query: aggregated sum (10 series → 1) ──\n");

  for (const store of populated) {
    const metric = "metric_0";
    const start = T0;
    const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;

    suite.add(
      "query_sum_10",
      store.name,
      () => {
        qe.query(store, { metric, start, end, agg: "sum" });
      },
      { warmup: 5, iterations: 20, itemsPerCall: 10 * POINTS_PER_SERIES, unit: "samples/sec" }
    );
  }

  console.log("  ── Query: time range (last 10%) ──\n");

  for (const store of populated) {
    const rangeLen = BigInt(POINTS_PER_SERIES) * INTERVAL;
    const start = T0 + (rangeLen * 9n) / 10n;
    const end = T0 + rangeLen;

    suite.add(
      "query_timerange",
      store.name,
      () => {
        store.read(0, start, end);
      },
      { warmup: 10, iterations: 50, itemsPerCall: POINTS_PER_SERIES / 10, unit: "samples/sec" }
    );
  }

  // ── Correctness check ──

  // Verify all backends return the same data for the same query.
  if (populated.length >= 2) {
    const start = T0;
    const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;
    const ref = populated[0]!;
    const refData = ref.read(0, start, end);

    for (let i = 1; i < populated.length; i++) {
      const other = populated[i]!;
      const otherData = other.read(0, start, end);
      // Precision-quantized backends legitimately differ from the baseline.
      // Skip cross-validation when comparing lossy vs lossless backends.
      const isLossy = other.name.includes("-p");
      const ok =
        refData.timestamps.length === otherData.timestamps.length &&
        (isLossy
          ? refData.values.every((v, j) => Math.abs(v - otherData.values[j]!) < 0.01)
          : refData.values.every((v, j) => v === otherData.values[j]));
      const detail = isLossy ? "approx (precision-quantized)" : "bit-exact";
      suite.addValidation(
        ref.name,
        other.name,
        "series_0_full",
        ok,
        ok ? detail : `length ${refData.timestamps.length} vs ${otherData.timestamps.length}`
      );
    }
  }

  // ── Run all timed benchmarks ──

  const report = suite.run();
  printReport(report);
  return report;
}

// ── Helper: create a fresh backend by name ───────────────────────────

async function freshBackend(name: string): Promise<StorageBackend> {
  if (name === "flat") {
    const { FlatStore } = await import(pkgPath("dist/flat-store.js"));
    return new FlatStore();
  }

  // Parse "chunked-{codec}-{size}" pattern.
  const chunkedMatch = name.match(/^chunked-(.+)-(\d+)$/);
  if (chunkedMatch) {
    const [, codecName, sizeStr] = chunkedMatch;
    const size = parseInt(sizeStr!, 10);
    const { ChunkedStore } = await import(pkgPath("dist/chunked-store.js"));

    if (codecName === "ts") {
      const codec = await import(pkgPath("dist/codec.js"));
      return new ChunkedStore(
        { name: "ts", encode: codec.encodeChunk, decode: codec.decodeChunk },
        size
      );
    }

    if (codecName === "rust-wasm") {
      const { loadWasm, makeCodecImpl } = await import("./wasm-loader.js");
      const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
      const wasm = await loadWasm(wasmPath);
      const impl = makeCodecImpl(wasm, "rust", "Rust→WASM");
      return new ChunkedStore(
        { name: "rust-wasm", encode: impl.encode, decode: impl.decode },
        size
      );
    }
  }

  // Parse "column-{codec}-{size}" pattern.
  const columnMatch = name.match(/^column-(.+)-(\d+)$/);
  if (columnMatch) {
    const [, codecName, sizeStr] = columnMatch;
    const size = parseInt(sizeStr!, 10);
    const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
    const { loadWasm, makeValuesCodec, makeTimestampCodec, makeALPValuesCodec, makeALPRangeCodec } =
      await import("./wasm-loader.js");
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);

    if (codecName === "rust-wasm-values") {
      const wasmVals = makeValuesCodec(wasm);
      return new ColumnStore(
        {
          name: "rust-wasm-values",
          encodeValues: wasmVals.encodeValues,
          decodeValues: wasmVals.decodeValues,
          encodeValuesWithStats: wasmVals.encodeValuesWithStats,
        },
        size,
        () => 0
      );
    }

    if (codecName === "rust-wasm-full") {
      const wasmVals = makeValuesCodec(wasm);
      const wasmTs = makeTimestampCodec(wasm);
      return new ColumnStore(
        {
          name: "rust-wasm-full",
          encodeValues: wasmVals.encodeValues,
          decodeValues: wasmVals.decodeValues,
          encodeValuesWithStats: wasmVals.encodeValuesWithStats,
        },
        size,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        }
      );
    }

    if (codecName === "alp-full") {
      const alpVals = makeALPValuesCodec(wasm);
      const wasmTs = makeTimestampCodec(wasm);
      return new ColumnStore(
        {
          name: "alp-full",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        size,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        }
      );
    }

    if (codecName === "alp-range") {
      const alpVals = makeALPValuesCodec(wasm);
      const wasmTs = makeTimestampCodec(wasm);
      const rangeCodec = makeALPRangeCodec(wasm);
      return new ColumnStore(
        {
          name: "alp-range",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        size,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        },
        rangeCodec
      );
    }

    // Precision-quantized variants: alp-p{N}.
    const precMatch = codecName?.match(/^alp-p(\d+)$/);
    if (precMatch) {
      const precision = parseInt(precMatch[1]!, 10);
      const alpVals = makeALPValuesCodec(wasm);
      const wasmTs = makeTimestampCodec(wasm);
      const rangeCodec = makeALPRangeCodec(wasm);
      return new ColumnStore(
        {
          name: `alp-p${precision}`,
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        size,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        },
        rangeCodec,
        undefined, // labelIndex
        precision
      );
    }
  }

  // Parse "rowgroup-{codec}-{size}" pattern.
  const rgMatch = name.match(/^rowgroup-(.+)-(\d+)$/);
  if (rgMatch) {
    const [, codecName, sizeStr] = rgMatch;
    const size = parseInt(sizeStr!, 10);
    const { RowGroupStore } = await import(pkgPath("dist/row-group-store.js"));
    const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } = await import(
      "./wasm-loader.js"
    );
    const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
    const wasm = await loadWasm(wasmPath);

    if (codecName === "rg-alp-full") {
      const alpVals = makeALPValuesCodec(wasm);
      const wasmTs = makeTimestampCodec(wasm);
      return new RowGroupStore(
        {
          name: "rg-alp-full",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        size,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        }
      );
    }

    if (codecName === "rg-alp-range") {
      const alpVals = makeALPValuesCodec(wasm);
      const wasmTs = makeTimestampCodec(wasm);
      const rangeCodec = makeALPRangeCodec(wasm);
      return new RowGroupStore(
        {
          name: "rg-alp-range",
          encodeValues: alpVals.encodeValues,
          decodeValues: alpVals.decodeValues,
          encodeValuesWithStats: alpVals.encodeValuesWithStats,
          encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
          decodeBatchValues: alpVals.decodeBatchValues,
        },
        size,
        () => 0,
        undefined,
        {
          name: "rust-wasm-ts",
          encodeTimestamps: wasmTs.encodeTimestamps,
          decodeTimestamps: wasmTs.decodeTimestamps,
        },
        rangeCodec
      );
    }
  }

  throw new Error(`Unknown backend: ${name}`);
}
