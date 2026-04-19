#!/usr/bin/env node
/**
 * Query-optimization sweep — exercises step sizes, agg functions, time
 * ranges, and allocation patterns needed to validate upcoming optimizations:
 *
 *   1. Fused read-aggregate (eliminate concatRanges allocations)
 *   2. WASM-based aggregation (push bucket math into Rust)
 *   3. ChunkStats-based skip (use precomputed min/max/sum/count per chunk)
 *
 * Usage:
 *   node --expose-gc bench/query-sweep.mjs
 *   node --expose-gc bench/query-sweep.mjs --quick     # fewer warmups, 3 runs
 *   node --expose-gc bench/query-sweep.mjs --filter max # only run max-agg rows
 *
 * Data layout for ChunkStats coverage analysis:
 *   - 30 series, 15s interval, chunk=512 → each chunk spans 512*15s = 7,680s = 128 min
 *   - step=1min  →  ~128 buckets/chunk  (no full-chunk skip possible)
 *   - step=5min  →  ~26 buckets/chunk   (no full-chunk skip)
 *   - step=1h    →  ~2.1 buckets/chunk  (some chunks may span 2-3 buckets)
 *   - step=6h    →  ~0.36 bucket/chunk  → most chunks fit entirely in one bucket ✓
 *   - step=1d    →  ~0.09 bucket/chunk  → almost all chunks fit in one bucket ✓
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// ── Config ───────────────────────────────────────────────────────────

const NUM_SERIES = 30;
const POINTS_PER_SERIES = Math.ceil(5_000_000 / NUM_SERIES); // ~166,667
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const CHUNK_SIZE = 512;
const T0 = 1_700_000_000_000n; // epoch ms
const INTERVAL = 15_000n; // 15s scrape interval
const REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1", "eu-central-1"];

const CHUNK_SPAN_MS = CHUNK_SIZE * Number(INTERVAL); // 7,680,000 ms = 128 min

// Parse CLI flags
const args = process.argv.slice(2);
const isQuick = args.includes("--quick");
const filterIdx = args.indexOf("--filter");
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
const WARMUP = isQuick ? 1 : 3;
const RUNS = isQuick ? 3 : 7;

// ── Sweep dimensions ─────────────────────────────────────────────────

const STEPS = [
  { name: "1min", ms: 60_000n, label: "60s" },
  { name: "5min", ms: 300_000n, label: "5m" },
  { name: "1h", ms: 3_600_000n, label: "1h" },
  { name: "6h", ms: 21_600_000n, label: "6h" },
  { name: "1d", ms: 86_400_000n, label: "1d" },
];

const AGG_FNS = ["min", "max", "sum", "avg", "count", "last"];

// Which agg functions can use ChunkStats to skip decoding
const CHUNK_STATS_ELIGIBLE = new Set(["min", "max", "sum", "avg", "count", "last"]);

// ── Data generation ──────────────────────────────────────────────────

function generateData() {
  const series = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const timestamps = new BigInt64Array(POINTS_PER_SERIES);
    const values = new Float64Array(POINTS_PER_SERIES);
    for (let i = 0; i < POINTS_PER_SERIES; i++) {
      timestamps[i] = T0 + BigInt(i) * INTERVAL;
      const base = Math.sin(i * 0.001 + s) * 50 + 100;
      values[i] = base + (Math.random() - 0.5) * 10;
    }
    const region = REGIONS[s % REGIONS.length];
    const labels = new Map([
      ["__name__", "cpu_usage"],
      ["region", region],
      ["instance", `host-${s}`],
    ]);
    series.push({ labels, timestamps, values });
  }
  return series;
}

// ── WASM codec setup ─────────────────────────────────────────────────

async function makeWasmCodecs() {
  const wasmBytes = readFileSync(join(pkgDir, "wasm/o11ytsdb-rust.wasm"));
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
  const w = instance.exports;
  const mem = () => new Uint8Array(w.memory.buffer);

  const alpValuesCodec = {
    name: "rust-wasm-alp",
    encodeValues(values) {
      const n = values.length;
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      return new Uint8Array(
        w.memory.buffer.slice(outPtr, outPtr + w.encodeValuesALP(valPtr, n, outPtr, outCap))
      );
    },
    decodeValues(buf) {
      w.resetScratch();
      const inPtr = w.allocScratch(buf.length);
      mem().set(buf, inPtr);
      const maxSamples = (buf[0] << 8) | buf[1];
      const valPtr = w.allocScratch(maxSamples * 8);
      const n = w.decodeValuesALP(inPtr, buf.length, valPtr, maxSamples);
      return new Float64Array(w.memory.buffer.slice(valPtr, valPtr + n * 8));
    },
    encodeValuesWithStats(values) {
      const n = values.length;
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      const statsPtr = w.allocScratch(64);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytesWritten = w.encodeValuesALPWithStats(valPtr, n, outPtr, outCap, statsPtr);
      const compressed = new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + bytesWritten));
      const s = new Float64Array(w.memory.buffer.slice(statsPtr, statsPtr + 64));
      return {
        compressed,
        stats: {
          minV: s[0],
          maxV: s[1],
          sum: s[2],
          count: s[3],
          firstV: s[4],
          lastV: s[5],
          sumOfSquares: s[6],
          resetCount: s[7],
        },
      };
    },
    encodeBatchValuesWithStats(arrays) {
      const numArrays = arrays.length;
      const chunkSize = arrays[0].length;
      w.resetScratch();
      const valsPtr = w.allocScratch(numArrays * chunkSize * 8);
      for (let i = 0; i < numArrays; i++) {
        mem().set(
          new Uint8Array(arrays[i].buffer, arrays[i].byteOffset, arrays[i].byteLength),
          valsPtr + i * chunkSize * 8
        );
      }
      const outCap = numArrays * chunkSize * 20;
      const outPtr = w.allocScratch(outCap);
      const offsetsPtr = w.allocScratch(numArrays * 4);
      const sizesPtr = w.allocScratch(numArrays * 4);
      const statsPtr = w.allocScratch(numArrays * 64);
      w.encodeBatchValuesALPWithStats(
        valsPtr,
        chunkSize,
        numArrays,
        outPtr,
        outCap,
        offsetsPtr,
        sizesPtr,
        statsPtr
      );
      const offsets = new Uint32Array(
        w.memory.buffer.slice(offsetsPtr, offsetsPtr + numArrays * 4)
      );
      const sizes = new Uint32Array(w.memory.buffer.slice(sizesPtr, sizesPtr + numArrays * 4));
      const allStats = new Float64Array(w.memory.buffer.slice(statsPtr, statsPtr + numArrays * 64));
      const results = [];
      for (let i = 0; i < numArrays; i++) {
        const compressed = new Uint8Array(
          w.memory.buffer.slice(outPtr + offsets[i], outPtr + offsets[i] + sizes[i])
        );
        const si = i * 8;
        results.push({
          compressed,
          stats: {
            minV: allStats[si],
            maxV: allStats[si + 1],
            sum: allStats[si + 2],
            count: allStats[si + 3],
            firstV: allStats[si + 4],
            lastV: allStats[si + 5],
            sumOfSquares: allStats[si + 6],
            resetCount: allStats[si + 7],
          },
        });
      }
      return results;
    },
  };

  const tsCodec = {
    name: "rust-wasm-ts",
    encodeTimestamps(timestamps) {
      const n = timestamps.length;
      w.resetScratch();
      const tsPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(
        new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength),
        tsPtr
      );
      return new Uint8Array(
        w.memory.buffer.slice(outPtr, outPtr + w.encodeTimestamps(tsPtr, n, outPtr, outCap))
      );
    },
    decodeTimestamps(buf) {
      w.resetScratch();
      const inPtr = w.allocScratch(buf.length);
      mem().set(buf, inPtr);
      const maxSamples = (buf[0] << 8) | buf[1];
      const tsPtr = w.allocScratch(maxSamples * 8);
      const n = w.decodeTimestamps(inPtr, buf.length, tsPtr, maxSamples);
      return new BigInt64Array(w.memory.buffer.slice(tsPtr, tsPtr + n * 8));
    },
  };

  const alpRangeCodec = {
    rangeDecodeValues(compressedTs, compressedVals, startT, endT) {
      w.resetScratch();
      const tsInPtr = w.allocScratch(compressedTs.length);
      mem().set(compressedTs, tsInPtr);
      const valInPtr = w.allocScratch(compressedVals.length);
      mem().set(compressedVals, valInPtr);
      const maxSamples = (compressedVals[0] << 8) | compressedVals[1];
      const outTsPtr = w.allocScratch(maxSamples * 8);
      const outValPtr = w.allocScratch(maxSamples * 8);
      const n = w.rangeDecodeALP(
        tsInPtr,
        compressedTs.length,
        valInPtr,
        compressedVals.length,
        startT,
        endT,
        outTsPtr,
        outValPtr,
        maxSamples
      );
      if (n === 0) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
      return {
        timestamps: new BigInt64Array(w.memory.buffer.slice(outTsPtr, outTsPtr + n * 8)),
        values: new Float64Array(w.memory.buffer.slice(outValPtr, outValPtr + n * 8)),
      };
    },
  };

  return { alpValuesCodec, tsCodec, alpRangeCodec };
}

// ── Helpers ──────────────────────────────────────────────────────────

function _fmtMs(n) {
  return n < 1 ? `${(n * 1000).toFixed(0)}µs` : `${n.toFixed(1)}ms`;
}
function _fmtRate(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M/s`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K/s`;
  return `${n.toFixed(0)}/s`;
}
function fmtBytes(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "+";
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
  return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`;
}

/** Run fn with warmup, return sorted array of times + heap deltas. */
function bench(fn, warmup = WARMUP, runs = RUNS) {
  const hasGC = typeof global.gc === "function";
  // Warmup
  for (let w = 0; w < warmup; w++) fn();

  const times = [];
  const heapDeltas = [];
  for (let r = 0; r < runs; r++) {
    if (hasGC) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    fn();
    const elapsed = performance.now() - t0;
    const heapAfter = process.memoryUsage().heapUsed;
    times.push(elapsed);
    heapDeltas.push(heapAfter - heapBefore);
  }
  times.sort((a, b) => a - b);
  heapDeltas.sort((a, b) => a - b);
  const mid = Math.floor(runs / 2);
  return {
    min: times[0],
    median: times[mid],
    max: times[runs - 1],
    heapMin: heapDeltas[0],
    heapMedian: heapDeltas[mid],
    heapMax: heapDeltas[runs - 1],
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const hasGC = typeof global.gc === "function";
  if (!hasGC) console.log("  ⚠ Run with --expose-gc for accurate heap tracking\n");

  // ── Setup ──
  console.log("  Generating data...");
  const data = generateData();
  const dataSpanMs = Number(BigInt(POINTS_PER_SERIES) * INTERVAL);

  console.log("  Loading WASM codecs...");
  const { alpValuesCodec, tsCodec, alpRangeCodec } = await makeWasmCodecs();
  const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
  const { ScanEngine } = await import(join(pkgDir, "dist/query.js"));

  const engine = new ScanEngine();

  console.log("  Ingesting into column-alp-fused store...");
  const store = new ColumnStore(
    alpValuesCodec,
    CHUNK_SIZE,
    () => 0,
    undefined,
    tsCodec,
    alpRangeCodec
  );
  const ids = data.map((d) => store.getOrCreateSeries(d.labels));
  for (let s = 0; s < data.length; s++) {
    store.appendBatch(ids[s], data[s].timestamps, data[s].values);
  }
  const numChunksPerSeries = Math.ceil(POINTS_PER_SERIES / CHUNK_SIZE);

  console.log(
    `\n  ${NUM_SERIES} series × ${POINTS_PER_SERIES.toLocaleString()} pts = ${TOTAL_SAMPLES.toLocaleString()} samples`
  );
  console.log(
    `  Chunks: ${numChunksPerSeries}/series × ${NUM_SERIES} series = ${numChunksPerSeries * NUM_SERIES} total`
  );
  console.log(
    `  Chunk span: ${(CHUNK_SPAN_MS / 60_000).toFixed(0)} min  |  Data span: ${(dataSpanMs / 86_400_000).toFixed(1)} days`
  );
  console.log(
    `  Store: ${(store.memoryBytes() / 1024 / 1024).toFixed(1)} MB  (${(store.memoryBytes() / TOTAL_SAMPLES).toFixed(1)} B/pt)`
  );
  console.log(`  Warmup: ${WARMUP}  Runs: ${RUNS}  ${filter ? `Filter: ${filter}` : ""}\n`);

  // ── Time ranges ──
  const qFull = { start: T0, end: T0 + BigInt(POINTS_PER_SERIES) * INTERVAL + 1n };
  // Last 10% — hits fewer chunks, different decode-skip ratio
  const qLast10 = {
    start: T0 + BigInt(Math.floor(POINTS_PER_SERIES * 0.9)) * INTERVAL,
    end: T0 + BigInt(POINTS_PER_SERIES) * INTERVAL + 1n,
  };

  const timeRanges = [
    { name: "full", ...qFull, pctLabel: "100%", expectedSamples: TOTAL_SAMPLES },
    {
      name: "last10%",
      ...qLast10,
      pctLabel: "10%",
      expectedSamples: Math.ceil(TOTAL_SAMPLES * 0.1),
    },
  ];

  // ── Table header ──
  const hdr = [
    "agg".padEnd(6),
    "step".padEnd(6),
    "range".padEnd(6),
    "buckets".padStart(8),
    "chunks/bkt".padStart(11),
    "statsSkip?".padStart(11),
    "min(ms)".padStart(9),
    "med(ms)".padStart(9),
    "max(ms)".padStart(9),
    "heap Δ".padStart(10),
    "scanned".padStart(12),
    "output".padStart(10),
  ];
  console.log(`  ${hdr.join("  ")}`);
  console.log(`  ${"─".repeat(hdr.join("  ").length)}`);

  // ── Sweep ──
  const results = [];

  for (const aggFn of AGG_FNS) {
    if (filter && !aggFn.includes(filter)) continue;

    for (const step of STEPS) {
      for (const range of timeRanges) {
        const stepMs = Number(step.ms);
        const rangeMs = Number(range.end - range.start);
        const bucketCount = Math.floor(rangeMs / stepMs) + 1;

        // Chunks per bucket: how many chunks span a single bucket?
        // If chunkSpan < stepMs, chunks fit inside buckets → stats skip possible
        const chunksPerBucket = CHUNK_SPAN_MS / stepMs;
        const statsSkipPossible = CHUNK_STATS_ELIGIBLE.has(aggFn) && chunksPerBucket < 1;

        let result;
        let scanned = 0;
        let outputPts = 0;

        const stats = bench(() => {
          result = engine.query(store, {
            metric: "cpu_usage",
            start: range.start,
            end: range.end,
            agg: aggFn,
            step: step.ms,
            groupBy: ["region"],
          });
          scanned = result.scannedSamples;
          outputPts = result.series.reduce((s, r) => s + r.timestamps.length, 0);
        });

        const row = {
          aggFn,
          step: step.name,
          range: range.name,
          bucketCount,
          chunksPerBucket,
          statsSkipPossible,
          ...stats,
          scanned,
          outputPts,
        };
        results.push(row);

        const cols = [
          aggFn.padEnd(6),
          step.name.padEnd(6),
          range.pctLabel.padEnd(6),
          String(bucketCount).padStart(8),
          chunksPerBucket.toFixed(2).padStart(11),
          (statsSkipPossible ? "✓ YES" : "  no").padStart(11),
          stats.min.toFixed(1).padStart(9),
          stats.median.toFixed(1).padStart(9),
          stats.max.toFixed(1).padStart(9),
          fmtBytes(stats.heapMedian).padStart(10),
          scanned.toLocaleString().padStart(12),
          outputPts.toLocaleString().padStart(10),
        ];
        console.log(`  ${cols.join("  ")}`);
      }
    }
    // Visual separator between agg functions
    if (AGG_FNS.indexOf(aggFn) < AGG_FNS.length - 1) {
      console.log(`  ${"─".repeat(hdr.join("  ").length)}`);
    }
  }

  // ── Summary analysis ──
  console.log(`\n  ═══ Analysis ═══\n`);

  // Group by agg fn and show median across all configs
  const byAgg = new Map();
  for (const r of results) {
    if (!byAgg.has(r.aggFn)) byAgg.set(r.aggFn, []);
    byAgg.get(r.aggFn).push(r);
  }

  // ChunkStats skip opportunity
  const skipRows = results.filter((r) => r.statsSkipPossible);
  const noSkipRows = results.filter(
    (r) => !r.statsSkipPossible && CHUNK_STATS_ELIGIBLE.has(r.aggFn)
  );
  if (skipRows.length > 0 && noSkipRows.length > 0) {
    const skipMedian = skipRows.reduce((s, r) => s + r.median, 0) / skipRows.length;
    const noSkipMedian = noSkipRows.reduce((s, r) => s + r.median, 0) / noSkipRows.length;
    console.log(`  ChunkStats skip opportunity:`);
    console.log(
      `    Eligible configs (chunk fits in 1 bucket):  ${skipRows.length} rows, avg median ${skipMedian.toFixed(1)}ms`
    );
    console.log(
      `    Non-skip configs (chunk spans >1 bucket):   ${noSkipRows.length} rows, avg median ${noSkipMedian.toFixed(1)}ms`
    );
    console.log(
      `    Potential savings: if stats-skip avoids decode for ${skipRows.length} configs,`
    );
    console.log(`    read() phase (~50% of query time) could be largely eliminated\n`);
  }

  // Allocation pressure analysis
  const fullRangeRows = results.filter((r) => r.range === "full");
  const avgHeap = fullRangeRows.reduce((s, r) => s + r.heapMedian, 0) / fullRangeRows.length;
  console.log(`  Allocation pressure (full-range queries):`);
  console.log(`    Average heap Δ per query: ${fmtBytes(avgHeap)}`);
  console.log(`    Fused read-aggregate target: eliminate concatRanges → ~0 heap growth\n`);

  // Fastest/slowest per agg
  console.log(`  Per-agg median (full range, step=1min):`);
  for (const [agg, rows] of byAgg) {
    const r = rows.find((r) => r.step === "1min" && r.range === "full");
    if (r) console.log(`    ${agg.padEnd(6)} ${r.median.toFixed(1)}ms`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
