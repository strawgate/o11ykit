#!/usr/bin/env node
/**
 * Deep query profiler — isolates decode vs aggregation costs at scale.
 *
 * Measures:
 *  1. Chunk decode cost (WASM + JS allocation)
 *  2. Stats-skip hit rate at different step sizes
 *  3. Bucket-assignment throughput
 *  4. Memory pressure per query (heap delta)
 *  5. Scaling behavior (series × points matrix)
 *
 * Usage:
 *   node --expose-gc bench/profile-query-deep.mjs
 *   node --expose-gc bench/profile-query-deep.mjs --scale    # run scaling matrix
 *   node --cpu-prof bench/profile-query-deep.mjs             # V8 CPU profile
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

const RUN_SCALING = process.argv.includes("--scale");

// ── Config ───────────────────────────────────────────────────────────

const CHUNK_SIZE = 512;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n; // 15s scrape interval
const REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1", "eu-central-1"];

// ── WASM loader (same as profile-query.mjs) ──────────────────────────

function loadWasmSync() {
  return readFileSync(join(pkgDir, "wasm/o11ytsdb-rust.wasm"));
}

async function makeWasmCodecs(wasmBytes) {
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
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + w.encodeValuesALP(valPtr, n, outPtr, outCap)));
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
    decodeValuesView(buf) {
      w.resetScratch();
      const inPtr = w.allocScratch(buf.length);
      mem().set(buf, inPtr);
      const maxSamples = (buf[0] << 8) | buf[1];
      const valPtr = w.allocScratch(maxSamples * 8);
      const n = w.decodeValuesALP(inPtr, buf.length, valPtr, maxSamples);
      return new Float64Array(w.memory.buffer, valPtr, n);
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
        stats: { minV: s[0], maxV: s[1], sum: s[2], count: s[3], firstV: s[4], lastV: s[5], sumOfSquares: s[6], resetCount: s[7] },
      };
    },
    encodeBatchValuesWithStats(arrays) {
      const numArrays = arrays.length;
      const chunkSize = arrays[0].length;
      w.resetScratch();
      const valsPtr = w.allocScratch(numArrays * chunkSize * 8);
      for (let i = 0; i < numArrays; i++) {
        mem().set(new Uint8Array(arrays[i].buffer, arrays[i].byteOffset, arrays[i].byteLength), valsPtr + i * chunkSize * 8);
      }
      const outCap = numArrays * chunkSize * 20;
      const outPtr = w.allocScratch(outCap);
      const offsetsPtr = w.allocScratch(numArrays * 4);
      const sizesPtr = w.allocScratch(numArrays * 4);
      const statsPtr = w.allocScratch(numArrays * 64);
      w.encodeBatchValuesALPWithStats(valsPtr, chunkSize, numArrays, outPtr, outCap, offsetsPtr, sizesPtr, statsPtr);
      const offsets = new Uint32Array(w.memory.buffer.slice(offsetsPtr, offsetsPtr + numArrays * 4));
      const sizes = new Uint32Array(w.memory.buffer.slice(sizesPtr, sizesPtr + numArrays * 4));
      const allStats = new Float64Array(w.memory.buffer.slice(statsPtr, statsPtr + numArrays * 64));
      const results = [];
      for (let i = 0; i < numArrays; i++) {
        const compressed = new Uint8Array(w.memory.buffer.slice(outPtr + offsets[i], outPtr + offsets[i] + sizes[i]));
        const si = i * 8;
        results.push({
          compressed,
          stats: {
            minV: allStats[si], maxV: allStats[si+1], sum: allStats[si+2], count: allStats[si+3],
            firstV: allStats[si+4], lastV: allStats[si+5], sumOfSquares: allStats[si+6], resetCount: allStats[si+7],
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
      mem().set(new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength), tsPtr);
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + w.encodeTimestamps(tsPtr, n, outPtr, outCap)));
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

  return { alpValuesCodec, tsCodec };
}

// ── Helpers ──────────────────────────────────────────────────────────

function gcAndSnap() {
  if (global.gc) { global.gc(); global.gc(); }
  return process.memoryUsage();
}

function fmtMs(n) { return `${n.toFixed(1)}ms`; }
function fmtRate(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}
function fmtBytes(n) {
  if (Math.abs(n) < 1024) return `${n} B`;
  if (Math.abs(n) < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ── Data generation ──────────────────────────────────────────────────

function generateData(numSeries, pointsPerSeries) {
  const series = [];
  for (let s = 0; s < numSeries; s++) {
    const timestamps = new BigInt64Array(pointsPerSeries);
    const values = new Float64Array(pointsPerSeries);
    for (let i = 0; i < pointsPerSeries; i++) {
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

// ── Ingest helper ────────────────────────────────────────────────────

function ingestData(store, data) {
  const ids = data.map(d => store.getOrCreateSeries(d.labels));
  for (let s = 0; s < data.length; s++) {
    store.appendBatch(ids[s], data[s].timestamps, data[s].values);
  }
  return ids;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const hasGC = typeof global.gc === "function";
  if (!hasGC) console.log("  ⚠ Run with --expose-gc for accurate memory\n");

  const wasmBytes = loadWasmSync();
  const { alpValuesCodec, tsCodec } = await makeWasmCodecs(wasmBytes);
  const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
  const { ScanEngine } = await import(join(pkgDir, "dist/query.js"));
  const engine = new ScanEngine();

  // ── Test 1: Phase-isolated profiling at default scale ──────────────

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  TEST 1: Phase-isolated profiling (30 series × 166K pts = 5M samples)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const NUM_SERIES = 30;
  const PPS = Math.ceil(5_000_000 / NUM_SERIES);
  const TOTAL = NUM_SERIES * PPS;

  const data = generateData(NUM_SERIES, PPS);
  const store = new ColumnStore(alpValuesCodec, CHUNK_SIZE, () => 0, undefined, tsCodec);
  const ids = ingestData(store, data);

  const qStart = T0;
  const qEnd = T0 + BigInt(PPS) * INTERVAL + 1n;

  console.log(`  Store: ${fmtBytes(store.memoryBytes())} (${(store.memoryBytes() / TOTAL).toFixed(1)} B/pt)\n`);

  // Phase A: readParts (just build part list with lazy callbacks)
  {
    gcAndSnap();
    const t0 = performance.now();
    let totalParts = 0;
    let statsOnlyParts = 0;
    for (const id of ids) {
      const parts = store.readParts(id, qStart, qEnd);
      totalParts += parts.length;
      for (const p of parts) {
        if (p.timestamps.length === 0 && p.stats) statsOnlyParts++;
      }
    }
    const t1 = performance.now();
    console.log(`  Phase A: readParts           ${fmtMs(t1 - t0).padStart(10)}  (${totalParts} parts, ${statsOnlyParts} stats-only / ${((statsOnlyParts / totalParts) * 100).toFixed(0)}% eligible for skip)`);
  }

  // Phase B: Force-decode all stats-only parts (measure WASM decode cost)
  {
    gcAndSnap();
    const mem0 = process.memoryUsage();
    let decodeCount = 0;
    let decodeSamples = 0;
    const t0 = performance.now();
    for (const id of ids) {
      const parts = store.readParts(id, qStart, qEnd);
      for (const p of parts) {
        if (p.decode) {
          const decoded = p.decode();
          decodeSamples += decoded.timestamps.length;
          decodeCount++;
        } else {
          decodeSamples += p.timestamps.length;
        }
      }
    }
    const t1 = performance.now();
    const mem1 = process.memoryUsage();
    console.log(`  Phase B: Force-decode all    ${fmtMs(t1 - t0).padStart(10)}  (${decodeCount} decodes, ${fmtRate(decodeSamples)} samples, ${fmtRate(decodeSamples / (t1 - t0) * 1000)} samples/s)`);
    console.log(`           Heap delta:         ${fmtBytes(mem1.heapUsed - mem0.heapUsed).padStart(10)}`);
  }

  // Phase C: Full query with different step sizes to see stats-skip impact
  console.log(`\n  Phase C: Full query — step size vs stats-skip\n`);
  const steps = [
    { name: "15s (every sample)", step: 15_000n },
    { name: "1min", step: 60_000n },
    { name: "5min", step: 300_000n },
    { name: "1h", step: 3_600_000n },
    { name: "4h (chunk fits)", step: 14_400_000n },
    { name: "24h", step: 86_400_000n },
  ];

  for (const { name, step } of steps) {
    const runs = [];
    let result;
    for (let r = 0; r < 7; r++) {
      if (hasGC) global.gc();
      const t0 = performance.now();
      result = engine.query(store, {
        metric: "cpu_usage",
        start: qStart,
        end: qEnd,
        agg: "min",
        step,
        groupBy: ["region"],
      });
      const t1 = performance.now();
      runs.push(t1 - t0);
    }
    const med = median(runs);
    const outPts = result.series.reduce((s, r) => s + r.timestamps.length, 0);
    const scanned = result.scannedSamples;
    console.log(`    step=${name.padEnd(22)} median=${fmtMs(med).padStart(8)}  scanned=${fmtRate(scanned).padStart(6)} → ${fmtRate(outPts).padStart(6)} out  (${fmtRate(scanned / med * 1000)} samples/s)`);
  }

  // Phase D: Aggregation function comparison (all use same step)
  console.log(`\n  Phase D: Aggregation function comparison (step=1min)\n`);
  const aggFns = ["min", "max", "sum", "avg", "count", "last", "rate"];
  for (const agg of aggFns) {
    const runs = [];
    for (let r = 0; r < 7; r++) {
      if (hasGC) global.gc();
      const t0 = performance.now();
      engine.query(store, {
        metric: "cpu_usage",
        start: qStart,
        end: qEnd,
        agg,
        step: 60_000n,
        groupBy: ["region"],
      });
      const t1 = performance.now();
      runs.push(t1 - t0);
    }
    console.log(`    agg=${agg.padEnd(8)} median=${fmtMs(median(runs)).padStart(8)}`);
  }

  // Phase E: Memory allocation per query
  console.log(`\n  Phase E: Memory allocation per query\n`);
  {
    gcAndSnap();
    const mem0 = process.memoryUsage();
    const ab0 = mem0.arrayBuffers;

    engine.query(store, {
      metric: "cpu_usage",
      start: qStart,
      end: qEnd,
      agg: "min",
      step: 60_000n,
      groupBy: ["region"],
    });

    const mem1 = process.memoryUsage();
    console.log(`    Heap delta:         ${fmtBytes(mem1.heapUsed - mem0.heapUsed)}`);
    console.log(`    ArrayBuffer delta:  ${fmtBytes(mem1.arrayBuffers - ab0)}`);
    console.log(`    External delta:     ${fmtBytes(mem1.external - mem0.external)}`);
  }

  // Phase F: Raw read throughput (decode only, no agg)
  console.log(`\n  Phase F: Raw read throughput\n`);
  {
    const runs = [];
    for (let r = 0; r < 7; r++) {
      if (hasGC) global.gc();
      const t0 = performance.now();
      engine.query(store, {
        metric: "cpu_usage",
        start: qStart,
        end: qEnd,
        // No agg — just read all series
      });
      const t1 = performance.now();
      runs.push(t1 - t0);
    }
    const med = median(runs);
    console.log(`    No-agg read:  median=${fmtMs(med).padStart(8)}  (${fmtRate(TOTAL / med * 1000)} samples/s)`);
  }

  // ── Test 2: Scaling matrix ─────────────────────────────────────────
  if (RUN_SCALING) {
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  TEST 2: Scaling matrix");
    console.log("═══════════════════════════════════════════════════════════════\n");

    const matrix = [
      { series: 10,    pps: 10_000 },
      { series: 30,    pps: 166_667 },
      { series: 100,   pps: 50_000 },
      { series: 300,   pps: 16_667 },
      { series: 1000,  pps: 5_000 },
      { series: 3000,  pps: 1_667 },
      { series: 10000, pps: 500 },
      // Wide (many series, few pts):
      { series: 10000, pps: 1_024 },
      // Deep (few series, many pts):
      { series: 10,    pps: 500_000 },
    ];

    console.log("  series   pts/s     total    ingest    mem     query(min/1m)  query(min/4h)  raw-read");
    console.log("  ─────── ──────── ──────── ──────── ──────── ────────────── ────────────── ──────────");

    for (const { series, pps } of matrix) {
      const total = series * pps;
      const data = generateData(series, pps);
      const s = new ColumnStore(alpValuesCodec, CHUNK_SIZE, () => 0, undefined, tsCodec);

      if (hasGC) global.gc();
      const t0 = performance.now();
      ingestData(s, data);
      const t1 = performance.now();
      const memBytes = s.memoryBytes();

      const qs = T0;
      const qe = T0 + BigInt(pps) * INTERVAL + 1n;

      // Warm up
      engine.query(s, { metric: "cpu_usage", start: qs, end: qe, agg: "min", step: 60_000n, groupBy: ["region"] });

      // 1min step query
      const runs1m = [];
      for (let r = 0; r < 5; r++) {
        if (hasGC) global.gc();
        const t = performance.now();
        engine.query(s, { metric: "cpu_usage", start: qs, end: qe, agg: "min", step: 60_000n, groupBy: ["region"] });
        runs1m.push(performance.now() - t);
      }

      // 4h step query
      const runs4h = [];
      for (let r = 0; r < 5; r++) {
        if (hasGC) global.gc();
        const t = performance.now();
        engine.query(s, { metric: "cpu_usage", start: qs, end: qe, agg: "min", step: 14_400_000n, groupBy: ["region"] });
        runs4h.push(performance.now() - t);
      }

      // Raw read (no agg)
      const runsRaw = [];
      for (let r = 0; r < 5; r++) {
        if (hasGC) global.gc();
        const t = performance.now();
        engine.query(s, { metric: "cpu_usage", start: qs, end: qe });
        runsRaw.push(performance.now() - t);
      }

      const line = [
        String(series).padStart(7),
        String(pps).padStart(8),
        fmtRate(total).padStart(8),
        fmtMs(t1 - t0).padStart(8),
        fmtBytes(memBytes).padStart(8),
        fmtMs(median(runs1m)).padStart(14),
        fmtMs(median(runs4h)).padStart(14),
        fmtMs(median(runsRaw)).padStart(10),
      ].join(" ");
      console.log(`  ${line}`);
    }
  }

  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
