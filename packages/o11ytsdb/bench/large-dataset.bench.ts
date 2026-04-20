/**
 * Large-dataset benchmark — how much data fits in 1 GB of memory?
 *
 * Progressively scales series count × points per series, measuring:
 *   1. Total memory usage (store.memoryBytes() + process heap)
 *   2. Ingest throughput at scale
 *   3. Query latency on large datasets (select, aggregate, time-range)
 *
 * Stops when the store exceeds 1 GB or the process RSS exceeds ~1.5 GB.
 * Reports a summary table at the end.
 *
 * Usage:
 *   npx tsc -p bench/tsconfig.json && node --expose-gc bench/dist/large-dataset.bench.js
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, fmtBytes } from "./harness.js";
import { Rng } from "./vectors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

// ── Types ────────────────────────────────────────────────────────────

type StorageBackend = import("./types.js").StorageBackend;
type QueryEngine = import("./types.js").QueryEngine;
type Labels = import("./types.js").Labels;

// ── Configuration ────────────────────────────────────────────────────

const CHUNK_SIZE = 640;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n; // 15s scrape interval

// 1 GB memory ceiling for the store
const STORE_MEMORY_CEILING = 1024 * 1024 * 1024; // 1 GB
// Hard RSS ceiling — abort if process memory gets too high
const RSS_CEILING = 1.8 * 1024 * 1024 * 1024; // 1.8 GB

/**
 * Test tiers: each tier defines a (series, pointsPerSeries) pair.
 * We start small and scale up until we hit the 1 GB ceiling.
 */
const TIERS = [
  { series: 1_000, pointsPerSeries: 10_000 },   //   10M samples
  { series: 5_000, pointsPerSeries: 10_000 },   //   50M samples
  { series: 10_000, pointsPerSeries: 10_000 },  //  100M samples
  { series: 10_000, pointsPerSeries: 50_000 },  //  500M samples
  { series: 10_000, pointsPerSeries: 100_000 }, // 1000M samples
  { series: 50_000, pointsPerSeries: 10_000 },  //  500M samples (wide)
  { series: 100_000, pointsPerSeries: 10_000 }, // 1000M samples (wide)
];

// ── Helpers ──────────────────────────────────────────────────────────

interface TierResult {
  series: number;
  pointsPerSeries: number;
  totalSamples: number;
  storeMemoryBytes: number;
  processRssBytes: number;
  processHeapBytes: number;
  ingestMs: number;
  ingestSamplesPerSec: number;
  bytesPerSample: number;
  compressionRatio: number;
  querySingleMs: number;
  querySelect10Ms: number;
  queryAggSumMs: number;
  queryTimeRangeMs: number;
  queryStepAggMs: number;
}

function forceGC(): void {
  if (global.gc) {
    global.gc();
    global.gc();
  }
}

function memSnapshot(): { rss: number; heap: number; ab: number } {
  forceGC();
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed, ab: m.arrayBuffers };
}

function generateLabelsForSeries(
  seriesIdx: number,
  numSeries: number
): Map<string, string> {
  const m = new Map<string, string>();
  // 10 distinct metric names
  m.set("__name__", `metric_${seriesIdx % 10}`);
  // Realistic label cardinality
  m.set("host", `host-${seriesIdx % Math.max(1, Math.floor(numSeries / 100))}`);
  m.set("region", `region-${seriesIdx % 5}`);
  m.set("env", seriesIdx % 3 === 0 ? "prod" : seriesIdx % 3 === 1 ? "staging" : "dev");
  m.set("instance", `inst-${seriesIdx}`);
  return m;
}

function generateValues(
  seriesIdx: number,
  pointsPerSeries: number,
  rng: Rng
): { timestamps: BigInt64Array; values: Float64Array } {
  const ts = new BigInt64Array(pointsPerSeries);
  const vs = new Float64Array(pointsPerSeries);
  const pattern = seriesIdx % 10;

  if (pattern === 0) {
    // Constant
    const c = Math.round(rng.next() * 1000) / 10;
    for (let i = 0; i < pointsPerSeries; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      vs[i] = c;
    }
  } else if (pattern <= 2) {
    // Counter (small or large)
    const large = pattern === 2;
    let counter = large
      ? Math.floor(rng.next() * 1e10) + 1e10
      : Math.floor(rng.next() * 10000);
    for (let i = 0; i < pointsPerSeries; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      if (rng.next() >= 0.35) {
        counter += large
          ? Math.floor(rng.next() * 100000) + 1
          : Math.floor(rng.next() * 10) + 1;
      }
      vs[i] = counter;
    }
  } else if (pattern <= 6) {
    // Gauges at various decimal precisions
    const precisions = [100, 1000, 1e11, 1e12];
    const scale = precisions[pattern - 3]!;
    let v = rng.next() * 100;
    for (let i = 0; i < pointsPerSeries; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      v += rng.gaussian(0, 0.05);
      v = Math.max(0, v);
      vs[i] = Math.round(v * scale) / scale;
    }
  } else if (pattern <= 8) {
    // High-precision ratio (cpu.utilization-like)
    let ticks = Math.floor(rng.next() * 1e6);
    let totalTicks = Math.floor(1e7 + rng.next() * 1e6);
    for (let i = 0; i < pointsPerSeries; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      ticks += Math.floor(rng.next() * 200) + 1;
      totalTicks += 1000;
      vs[i] = ticks / totalTicks;
    }
  } else {
    // High-variance gauge
    let v = rng.next() * 100;
    for (let i = 0; i < pointsPerSeries; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      v += rng.gaussian(0, 0.5);
      v = Math.max(0, v);
      vs[i] = Math.round(v * 100) / 100;
    }
  }

  return { timestamps: ts, values: vs };
}

// ── Load best backend (ALP+range ColumnStore) ────────────────────────

async function loadBestBackend(): Promise<StorageBackend> {
  const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
  const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } =
    await import("./wasm-loader.js");
  const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
  const wasm = await loadWasm(wasmPath);
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
    CHUNK_SIZE,
    () => 0,
    "alp-range-1gb",
    {
      name: "rust-wasm-ts",
      encodeTimestamps: wasmTs.encodeTimestamps,
      decodeTimestamps: wasmTs.decodeTimestamps,
    },
    rangeCodec
  );
}

async function loadQueryEngine(): Promise<QueryEngine> {
  const { ScanEngine } = await import(pkgPath("dist/query.js"));
  return new ScanEngine();
}

// ── Benchmark a single tier ──────────────────────────────────────────

function timeIt(fn: () => void, warmup = 2, runs = 5): number {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!; // median
}

async function runTier(
  numSeries: number,
  pointsPerSeries: number,
  qe: QueryEngine
): Promise<TierResult | null> {
  const totalSamples = numSeries * pointsPerSeries;
  const rawBytes = totalSamples * 16; // 8 bytes ts + 8 bytes value

  console.log(
    `\n  ═══ Tier: ${numSeries.toLocaleString()} series × ${pointsPerSeries.toLocaleString()} pts = ${totalSamples.toLocaleString()} samples (${fmtBytes(rawBytes)} raw) ═══\n`
  );

  // Check RSS before we start — abort if already near ceiling
  const pre = memSnapshot();
  if (pre.rss > RSS_CEILING * 0.8) {
    console.log(`    ⚠ RSS already at ${fmtBytes(pre.rss)} — skipping tier`);
    return null;
  }

  const store = await loadBestBackend();

  // ── Ingest ──
  console.log("    Ingesting...");
  const rng = new Rng(42);
  const ingestStart = performance.now();

  // Ingest in interleaved chunk-sized batches (realistic scrape pattern).
  // Pre-register all series first.
  const ids: number[] = [];
  const allLabels: Labels[] = [];
  for (let s = 0; s < numSeries; s++) {
    const labels = generateLabelsForSeries(s, numSeries);
    allLabels.push(labels);
    ids.push(store.getOrCreateSeries(labels));
  }

  // Generate and ingest data in streaming fashion to avoid holding
  // all raw data in memory at once. Process one series at a time,
  // in chunk-sized batches.
  for (let s = 0; s < numSeries; s++) {
    const data = generateValues(s, pointsPerSeries, rng);
    for (let offset = 0; offset < pointsPerSeries; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, pointsPerSeries);
      store.appendBatch(
        ids[s]!,
        data.timestamps.subarray(offset, end),
        data.values.subarray(offset, end)
      );
    }

    // Progress reporting for large tiers
    if (numSeries >= 5000 && (s + 1) % 1000 === 0) {
      const pct = (((s + 1) / numSeries) * 100).toFixed(0);
      const elapsed = ((performance.now() - ingestStart) / 1000).toFixed(1);
      const mem = store.memoryBytes();
      process.stdout.write(
        `\r    Ingested ${(s + 1).toLocaleString()}/${numSeries.toLocaleString()} series (${pct}%) — ${elapsed}s — store: ${fmtBytes(mem)}`
      );

      // Check memory ceiling mid-ingest
      if (mem > STORE_MEMORY_CEILING) {
        console.log(
          `\n    ⛔ Store exceeded 1 GB at ${(s + 1).toLocaleString()} series (${fmtBytes(mem)}) — stopping ingest`
        );
        // Report partial results
        const ingestMs = performance.now() - ingestStart;
        const actualSamples = store.sampleCount;
        forceGC();
        const post = process.memoryUsage();
        return {
          series: s + 1,
          pointsPerSeries,
          totalSamples: actualSamples,
          storeMemoryBytes: mem,
          processRssBytes: post.rss,
          processHeapBytes: post.heapUsed,
          ingestMs,
          ingestSamplesPerSec: actualSamples / (ingestMs / 1000),
          bytesPerSample: mem / actualSamples,
          compressionRatio: (actualSamples * 16) / mem,
          querySingleMs: -1,
          querySelect10Ms: -1,
          queryAggSumMs: -1,
          queryTimeRangeMs: -1,
          queryStepAggMs: -1,
        };
      }
    }
  }

  const ingestMs = performance.now() - ingestStart;
  if (numSeries >= 5000) process.stdout.write("\n");

  forceGC();
  const postIngest = process.memoryUsage();
  const storeMem = store.memoryBytes();
  const actualSamples = store.sampleCount;

  console.log(`    Ingest: ${(ingestMs / 1000).toFixed(1)}s — ${fmt(actualSamples / (ingestMs / 1000))} samples/sec`);
  console.log(`    Store memory: ${fmtBytes(storeMem)} (${(storeMem / actualSamples).toFixed(2)} B/sample)`);
  console.log(`    Compression: ${((actualSamples * 16) / storeMem).toFixed(1)}x vs raw`);
  console.log(`    Process RSS: ${fmtBytes(postIngest.rss)} | Heap: ${fmtBytes(postIngest.heapUsed)}`);

  // ── Queries ──
  console.log("    Running queries...");

  const fullEnd = T0 + BigInt(pointsPerSeries) * INTERVAL;

  // 1. Single series read (full range)
  const querySingleMs = timeIt(() => {
    store.read(0, T0, fullEnd);
  });

  // 2. Select 10 series (metric_0 matches ~10% of series)
  const querySelect10Ms = timeIt(() => {
    qe.query(store, { metric: "metric_0", start: T0, end: fullEnd });
  }, 1, 3);

  // 3. Aggregated sum across metric_0
  const queryAggSumMs = timeIt(() => {
    qe.query(store, { metric: "metric_0", start: T0, end: fullEnd, agg: "sum" });
  }, 1, 3);

  // 4. Time range query (last 10%)
  const rangeStart = T0 + (BigInt(pointsPerSeries) * INTERVAL * 9n) / 10n;
  const queryTimeRangeMs = timeIt(() => {
    store.read(0, rangeStart, fullEnd);
  });

  // 5. Step-aggregated query (60s step, sum, metric_0)
  const step = 60_000n; // 60 second buckets
  const queryStepAggMs = timeIt(() => {
    qe.query(store, {
      metric: "metric_0",
      start: T0,
      end: fullEnd,
      agg: "sum",
      step,
    });
  }, 1, 3);

  const matchCount = Math.floor(numSeries / 10);
  console.log(`    Query single series (${pointsPerSeries.toLocaleString()} pts): ${querySingleMs.toFixed(1)} ms`);
  console.log(`    Query select ${matchCount} series: ${querySelect10Ms.toFixed(1)} ms`);
  console.log(`    Query agg sum ${matchCount} series: ${queryAggSumMs.toFixed(1)} ms`);
  console.log(`    Query time range (last 10%): ${queryTimeRangeMs.toFixed(1)} ms`);
  console.log(`    Query step-agg sum (60s step): ${queryStepAggMs.toFixed(1)} ms`);

  return {
    series: numSeries,
    pointsPerSeries,
    totalSamples: actualSamples,
    storeMemoryBytes: storeMem,
    processRssBytes: postIngest.rss,
    processHeapBytes: postIngest.heapUsed,
    ingestMs,
    ingestSamplesPerSec: actualSamples / (ingestMs / 1000),
    bytesPerSample: storeMem / actualSamples,
    compressionRatio: (actualSamples * 16) / storeMem,
    querySingleMs,
    querySelect10Ms,
    queryAggSumMs,
    queryTimeRangeMs,
    queryStepAggMs,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  o11ytsdb — Large Dataset Benchmark (1 GB memory ceiling)   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Backend: ColumnStore + ALP + delta-of-delta timestamps + range-decode`);
  console.log(`  Chunk size: ${CHUNK_SIZE}`);
  console.log(`  Memory ceiling: ${fmtBytes(STORE_MEMORY_CEILING)}`);
  console.log(`  Node: ${process.version}`);
  console.log(`  GC exposed: ${!!global.gc}`);
  console.log();

  const qe = await loadQueryEngine();
  const results: TierResult[] = [];
  let hitCeiling = false;

  for (const tier of TIERS) {
    // Run each tier in isolation — we create a fresh store each time
    // and let the old one get GC'd.
    forceGC();

    const result = await runTier(tier.series, tier.pointsPerSeries, qe);
    if (result) {
      results.push(result);

      // Check if we've hit the ceiling
      if (result.storeMemoryBytes >= STORE_MEMORY_CEILING) {
        hitCeiling = true;
        console.log(`\n  ⛔ Hit 1 GB ceiling — stopping.`);
        break;
      }
    }

    // Give GC time to reclaim the old store
    forceGC();
    await new Promise((r) => setTimeout(r, 100));
  }

  // ── Summary table ──
  console.log("\n\n  ╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("  ║                                    LARGE DATASET BENCHMARK SUMMARY                                              ║");
  console.log("  ╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝\n");

  // Memory & compression table
  console.log("  ── Memory & Compression ──\n");
  console.log(
    "    " +
    "Series".padEnd(10) +
    "Pts/Series".padEnd(12) +
    "Total Samples".padEnd(16) +
    "Store Mem".padEnd(12) +
    "B/sample".padEnd(10) +
    "Compress".padEnd(10) +
    "RSS".padEnd(12) +
    "Ingest"
  );
  console.log("    " + "─".repeat(90));

  for (const r of results) {
    console.log(
      "    " +
      r.series.toLocaleString().padEnd(10) +
      r.pointsPerSeries.toLocaleString().padEnd(12) +
      r.totalSamples.toLocaleString().padEnd(16) +
      fmtBytes(r.storeMemoryBytes).padEnd(12) +
      r.bytesPerSample.toFixed(2).padEnd(10) +
      `${r.compressionRatio.toFixed(1)}x`.padEnd(10) +
      fmtBytes(r.processRssBytes).padEnd(12) +
      `${fmt(r.ingestSamplesPerSec)}/s`
    );
  }

  // Query latency table
  console.log("\n  ── Query Latency (ms, median of 5 runs) ──\n");
  console.log(
    "    " +
    "Series".padEnd(10) +
    "Pts/Series".padEnd(12) +
    "Single".padEnd(10) +
    "Select 10%".padEnd(12) +
    "Agg Sum".padEnd(10) +
    "TimeRange".padEnd(12) +
    "Step-Agg"
  );
  console.log("    " + "─".repeat(76));

  for (const r of results) {
    const fmtQ = (ms: number) => (ms < 0 ? "—" : ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}`);
    console.log(
      "    " +
      r.series.toLocaleString().padEnd(10) +
      r.pointsPerSeries.toLocaleString().padEnd(12) +
      fmtQ(r.querySingleMs).padEnd(10) +
      fmtQ(r.querySelect10Ms).padEnd(12) +
      fmtQ(r.queryAggSumMs).padEnd(10) +
      fmtQ(r.queryTimeRangeMs).padEnd(12) +
      fmtQ(r.queryStepAggMs)
    );
  }

  // Key findings
  if (results.length > 0) {
    const last = results[results.length - 1]!;
    const largest = results.reduce((a, b) => (a.totalSamples > b.totalSamples ? a : b));

    console.log("\n  ── Key Findings ──\n");
    console.log(`    Largest dataset tested: ${largest.totalSamples.toLocaleString()} samples (${largest.series.toLocaleString()} series × ${largest.pointsPerSeries.toLocaleString()} pts)`);
    console.log(`    At largest:  store=${fmtBytes(largest.storeMemoryBytes)}  B/sample=${largest.bytesPerSample.toFixed(2)}  compression=${largest.compressionRatio.toFixed(1)}x`);

    if (hitCeiling) {
      // Extrapolate: how many samples could fit in exactly 1 GB?
      const bps = largest.bytesPerSample;
      const samplesIn1GB = Math.floor(STORE_MEMORY_CEILING / bps);
      console.log(`    Extrapolated capacity at 1 GB: ~${samplesIn1GB.toLocaleString()} samples (~${(samplesIn1GB / largest.pointsPerSeries).toLocaleString()} series × ${largest.pointsPerSeries.toLocaleString()} pts)`);
    } else {
      console.log(`    ✅ All tiers fit within 1 GB — the largest used ${fmtBytes(largest.storeMemoryBytes)}`);
      const bps = largest.bytesPerSample;
      const samplesIn1GB = Math.floor(STORE_MEMORY_CEILING / bps);
      console.log(`    Extrapolated capacity at 1 GB: ~${samplesIn1GB.toLocaleString()} samples`);
    }
  }

  console.log();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
