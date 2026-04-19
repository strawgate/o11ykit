#!/usr/bin/env node
/**
 * Benchmark: Fused WASM stepAggregateChunkALP vs JS decode+aggregate.
 *
 * Measures the per-chunk aggregation time for both paths:
 *   1. JS path: decodeTimestamps + decodeValuesALP + JS bucket loop
 *   2. WASM fused: stepAggregateChunkALP (decode + aggregate in one call)
 *
 * Usage:
 *   node --expose-gc bench/bench-fused-agg.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// ── Config ───────────────────────────────────────────────────────────

const CHUNK_SIZE = 640;
const NUM_CHUNKS = 260;   // ~166K samples (one series worth)
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n;
const STEP = 60_000n;     // 1-minute aggregation step

// ── Load WASM ────────────────────────────────────────────────────────

const wasmPath = join(pkgDir, "wasm/o11ytsdb-rust.wasm");
const wasmBytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
const w = instance.exports;
const mem = () => new Uint8Array(w.memory.buffer);

// ── Generate and compress test data ──────────────────────────────────

console.log(`Generating ${NUM_CHUNKS} chunks × ${CHUNK_SIZE} samples = ${(NUM_CHUNKS * CHUNK_SIZE).toLocaleString()} samples`);
console.log(`Step: ${STEP}ms, Interval: ${INTERVAL}ms\n`);

const compressedTs = [];
const compressedVals = [];

for (let c = 0; c < NUM_CHUNKS; c++) {
  const ts = new BigInt64Array(CHUNK_SIZE);
  const vals = new Float64Array(CHUNK_SIZE);
  for (let i = 0; i < CHUNK_SIZE; i++) {
    ts[i] = T0 + BigInt(c * CHUNK_SIZE + i) * INTERVAL;
    vals[i] = Math.sin((c * CHUNK_SIZE + i) * 0.001) * 50 + 100 + (Math.random() - 0.5) * 10;
  }

  // Encode timestamps
  w.resetScratch();
  const tsPtr = w.allocScratch(CHUNK_SIZE * 8);
  const outCap = CHUNK_SIZE * 20;
  const outPtr = w.allocScratch(outCap);
  mem().set(new Uint8Array(ts.buffer), tsPtr);
  const tsBytesWritten = w.encodeTimestamps(tsPtr, CHUNK_SIZE, outPtr, outCap);
  compressedTs.push(new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + tsBytesWritten)));

  // Encode values (ALP)
  w.resetScratch();
  const valPtr = w.allocScratch(CHUNK_SIZE * 8);
  const outPtr2 = w.allocScratch(outCap);
  mem().set(new Uint8Array(vals.buffer), valPtr);
  const valBytesWritten = w.encodeValuesALP(valPtr, CHUNK_SIZE, outPtr2, outCap);
  compressedVals.push(new Uint8Array(w.memory.buffer.slice(outPtr2, outPtr2 + valBytesWritten)));
}

// Compute time range
const totalSamples = NUM_CHUNKS * CHUNK_SIZE;
const minT = T0;
const maxT = T0 + BigInt(totalSamples - 1) * INTERVAL;
const bucketCount = Number((maxT - minT) / STEP) + 1;

console.log(`Bucket count: ${bucketCount}`);
console.log(`Compressed ts: ${compressedTs.reduce((a, b) => a + b.length, 0)} bytes`);
console.log(`Compressed vals: ${compressedVals.reduce((a, b) => a + b.length, 0)} bytes\n`);

// ── Platform endianness flag ─────────────────────────────────────────
const _le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// ── JS path: decode + DataView bucket loop ───────────────────────────

function jsAggregate(aggInit) {
  const values = new Float64Array(bucketCount).fill(aggInit);
  const counts = new Float64Array(bucketCount);
  const minTN = Number(minT);
  const stepN = Number(STEP);

  for (let c = 0; c < NUM_CHUNKS; c++) {
    // Decode timestamps
    w.resetScratch();
    const tsInPtr = w.allocScratch(compressedTs[c].length);
    mem().set(compressedTs[c], tsInPtr);
    const maxS = (compressedTs[c][0] << 8) | compressedTs[c][1];
    const tsOutPtr = w.allocScratch(maxS * 8);
    const n = w.decodeTimestamps(tsInPtr, compressedTs[c].length, tsOutPtr, maxS);
    const ts = new BigInt64Array(w.memory.buffer.slice(tsOutPtr, tsOutPtr + n * 8));

    // Decode values
    w.resetScratch();
    const valInPtr = w.allocScratch(compressedVals[c].length);
    mem().set(compressedVals[c], valInPtr);
    const maxV = (compressedVals[c][0] << 8) | compressedVals[c][1];
    const valOutPtr = w.allocScratch(maxV * 8);
    const nv = w.decodeValuesALP(valInPtr, compressedVals[c].length, valOutPtr, maxV);
    const vs = new Float64Array(w.memory.buffer.slice(valOutPtr, valOutPtr + nv * 8));

    // DataView bucket loop (same as production query.ts)
    const dv = new DataView(ts.buffer, ts.byteOffset, ts.byteLength);
    for (let i = 0; i < n; i++) {
      const off = i << 3;
      const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
      values[bucket] += vs[i]; // sum path
      counts[bucket]++;
    }
  }
  return { values, counts };
}

// ── WASM fused path: stepAggregateChunkALP ───────────────────────────

function wasmFusedAggregate(aggInit) {
  const values = new Float64Array(bucketCount).fill(aggInit);
  const counts = new Float64Array(bucketCount);

  // Allocate persistent bucket arrays in WASM (once for all chunks).
  w.resetScratch();
  const valsPtr = w.allocScratch(bucketCount * 8);
  const cntsPtr = w.allocScratch(bucketCount * 8);
  // Reserve space for the largest compressed blob pair.
  const maxBlobSize = Math.max(
    ...compressedTs.map(b => b.length),
    ...compressedVals.map(b => b.length),
  );
  const tsInPtr = w.allocScratch(maxBlobSize);
  const valInPtr = w.allocScratch(maxBlobSize);

  // Copy initial bucket state into WASM.
  let wasmMem = mem();
  wasmMem.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valsPtr);
  wasmMem.set(new Uint8Array(counts.buffer, counts.byteOffset, counts.byteLength), cntsPtr);

  for (let c = 0; c < NUM_CHUNKS; c++) {
    // Copy compressed blobs into pre-allocated WASM regions.
    wasmMem = mem();
    wasmMem.set(compressedTs[c], tsInPtr);
    wasmMem.set(compressedVals[c], valInPtr);

    // Fused decode + aggregate — buckets stay in WASM memory.
    w.stepAggregateChunkALP(
      tsInPtr, compressedTs[c].length,
      valInPtr, compressedVals[c].length,
      2, // sum
      minT, STEP,
      valsPtr, cntsPtr, bucketCount,
    );
  }

  // Copy final buckets back once.
  values.set(new Float64Array(w.memory.buffer.slice(valsPtr, valsPtr + bucketCount * 8)));
  counts.set(new Float64Array(w.memory.buffer.slice(cntsPtr, cntsPtr + bucketCount * 8)));
  return { values, counts };
}

// ── Correctness check ────────────────────────────────────────────────

console.log("Correctness check...");
const jsResult = jsAggregate(0);
const wasmResult = wasmFusedAggregate(0);

let maxDiff = 0;
let mismatchCount = 0;
for (let i = 0; i < bucketCount; i++) {
  const diff = Math.abs(jsResult.values[i] - wasmResult.values[i]);
  if (diff > 1e-6) {
    if (mismatchCount < 5) {
      console.log(`  bucket ${i}: JS=${jsResult.values[i]}, WASM=${wasmResult.values[i]}, diff=${diff}`);
    }
    mismatchCount++;
  }
  maxDiff = Math.max(maxDiff, diff);
}

if (mismatchCount > 0) {
  console.log(`  ⚠ ${mismatchCount} mismatches (max diff: ${maxDiff})`);
} else {
  console.log(`  ✓ All ${bucketCount} buckets match (max diff: ${maxDiff.toExponential(2)})`);
}

// Verify counts match
let countMismatch = 0;
for (let i = 0; i < bucketCount; i++) {
  if (jsResult.counts[i] !== wasmResult.counts[i]) countMismatch++;
}
console.log(`  ${countMismatch === 0 ? "✓" : "⚠"} Counts: ${countMismatch} mismatches\n`);

// ── Benchmark ────────────────────────────────────────────────────────

function bench(name, fn, warmup = 3, runs = 7) {
  for (let w = 0; w < warmup; w++) fn();
  const times = [];
  for (let r = 0; r < runs; r++) {
    if (global.gc) global.gc();
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mid = times.length >> 1;
  const median = times[mid];
  console.log(`  ${name.padEnd(35)} min=${times[0].toFixed(1)}ms  median=${median.toFixed(1)}ms`);
  return median;
}

console.log("Benchmarking (sum aggregation):");
const jsTime = bench("JS decode+DataView", () => jsAggregate(0));
const wasmTime = bench("WASM fused stepAggregateChunkALP", () => wasmFusedAggregate(0));
console.log(`\n  Speedup: ${(jsTime / wasmTime).toFixed(1)}×`);
