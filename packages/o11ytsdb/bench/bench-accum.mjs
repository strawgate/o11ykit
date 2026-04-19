#!/usr/bin/env node
/**
 * Benchmark: JS bucket math vs WASM accumulator at batch sizes 1/4/8/16/32.
 *
 * Compares:
 *   A) Current path: WASM decode → JS bucket math (per chunk)
 *   B) WASM accumulator: batch feed N chunks → WASM decode+bucket+accumulate
 *
 * Usage:
 *   cd packages/o11ytsdb
 *   npm run build:rust   # if not already built
 *   node --expose-gc bench/bench-accum.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

const CHUNK_SIZE = 512;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n; // 15s in ms

// ── WASM setup ───────────────────────────────────────────────────────

function loadWasm() {
  return readFileSync(join(pkgDir, "wasm/o11ytsdb-rust.wasm"));
}

async function initWasm(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
  return instance.exports;
}

// ── Helpers ──────────────────────────────────────────────────────────

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(fn, warmup = 3, runs = 9) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    if (globalThis.gc) gc();
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return { median: median(times), min: Math.min(...times), times };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (typeof globalThis.gc !== "function")
    console.log("  ⚠ Run with --expose-gc for accurate measurements\n");

  const w = await initWasm(loadWasm());
  const mem = () => new Uint8Array(w.memory.buffer);

  // ── Generate and compress test data ────────────────────────────────
  const NUM_SERIES = 30;
  const PTS_PER_SERIES = 166_667;  // ~5M total
  const TOTAL = NUM_SERIES * PTS_PER_SERIES;
  const CHUNKS_PER_SERIES = Math.ceil(PTS_PER_SERIES / CHUNK_SIZE);
  const TOTAL_CHUNKS = NUM_SERIES * CHUNKS_PER_SERIES;

  console.log(`Generating ${NUM_SERIES} series × ${PTS_PER_SERIES} pts = ${(TOTAL/1e6).toFixed(1)}M samples`);
  console.log(`  ${CHUNKS_PER_SERIES} chunks/series × ${NUM_SERIES} series = ${TOTAL_CHUNKS} total chunks\n`);

  // Compress all chunks
  const compressedTs = [];   // Uint8Array[]
  const compressedVals = []; // Uint8Array[]

  for (let s = 0; s < NUM_SERIES; s++) {
    for (let c = 0; c < CHUNKS_PER_SERIES; c++) {
      const chunkStart = c * CHUNK_SIZE;
      const n = Math.min(CHUNK_SIZE, PTS_PER_SERIES - chunkStart);

      const ts = new BigInt64Array(n);
      const vals = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        ts[i] = T0 + BigInt(chunkStart + i) * INTERVAL;
        vals[i] = Math.sin(i * 0.01) * 50 + 50 + Math.random() * 5;
      }

      // Compress timestamps
      w.resetScratch();
      const tsPtr = w.allocScratch(n * 8);
      const tsOutCap = n * 20;
      const tsOutPtr = w.allocScratch(tsOutCap);
      mem().set(new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength), tsPtr);
      const tsBytes = w.encodeTimestamps(tsPtr, n, tsOutPtr, tsOutCap);
      compressedTs.push(new Uint8Array(w.memory.buffer.slice(tsOutPtr, tsOutPtr + tsBytes)));

      // Compress values (ALP)
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const valOutCap = n * 20;
      const valOutPtr = w.allocScratch(valOutCap);
      mem().set(new Uint8Array(vals.buffer, vals.byteOffset, vals.byteLength), valPtr);
      const valBytes = w.encodeValuesALP(valPtr, n, valOutPtr, valOutCap);
      compressedVals.push(new Uint8Array(w.memory.buffer.slice(valOutPtr, valOutPtr + valBytes)));
    }
  }

  console.log(`Compressed: ${compressedTs.length} chunks`);
  const avgTsSize = compressedTs.reduce((s, b) => s + b.length, 0) / compressedTs.length;
  const avgValSize = compressedVals.reduce((s, b) => s + b.length, 0) / compressedVals.length;
  console.log(`  Avg compressed ts: ${avgTsSize.toFixed(0)} B, val: ${avgValSize.toFixed(0)} B per chunk\n`);

  // Query parameters
  const qStart = T0;
  const qEnd = T0 + BigInt(PTS_PER_SERIES) * INTERVAL;
  const step = 60_000n; // 1 minute
  const minT = Number(qStart);
  const stepN = Number(step);
  const bucketCount = Number((qEnd - qStart) / step) + 1;

  console.log(`Query: step=1min, buckets=${bucketCount}\n`);

  // ─────────────────────────────────────────────────────────────────
  // PATH A: Current JS bucket math (decode per chunk, JS accumulates)
  // ─────────────────────────────────────────────────────────────────

  const _le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  function jsAccumulate() {
    const values = new Float64Array(bucketCount);
    const counts = new Float64Array(bucketCount);

    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      // Decode values (view into WASM scratch)
      w.resetScratch();
      const valIn = w.allocScratch(compressedVals[c].length);
      mem().set(compressedVals[c], valIn);
      const maxSamples = (compressedVals[c][0] << 8) | compressedVals[c][1];
      const valOut = w.allocScratch(maxSamples * 8);
      const nv = w.decodeValuesALP(valIn, compressedVals[c].length, valOut, maxSamples);
      const vs = new Float64Array(w.memory.buffer, valOut, nv);

      // Decode timestamps (need separate scratch allocation)
      const tsIn = w.allocScratch(compressedTs[c].length);
      mem().set(compressedTs[c], tsIn);
      const tsMax = (compressedTs[c][0] << 8) | compressedTs[c][1];
      const tsOut = w.allocScratch(tsMax * 8);
      const nt = w.decodeTimestamps(tsIn, compressedTs[c].length, tsOut, tsMax);
      const ts = new BigInt64Array(w.memory.buffer, tsOut, nt);

      // JS bucket math (same as stepAggregate _makeAccumulator sum path)
      const dv = new DataView(ts.buffer, ts.byteOffset, ts.byteLength);
      const n = Math.min(nv, nt);
      for (let i = 0; i < n; i++) {
        const off = i << 3;
        const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minT) / stepN | 0;
        values[bucket] += vs[i];
        counts[bucket]++;
      }
    }

    return values;
  }

  // ─────────────────────────────────────────────────────────────────
  // PATH B: WASM accumulator (batch feed chunks)
  // ─────────────────────────────────────────────────────────────────

  function wasmAccumulate(batchSize) {
    // AggFn IDs: 0=sum
    w.accumInit(bucketCount, BigInt(Number(qStart)), BigInt(stepN), 0);

    for (let c = 0; c < TOTAL_CHUNKS; c += batchSize) {
      const nc = Math.min(batchSize, TOTAL_CHUNKS - c);

      w.resetScratch();

      // Pack compressed blobs into scratch
      let tsTotalBytes = 0;
      let valTotalBytes = 0;
      for (let i = 0; i < nc; i++) {
        tsTotalBytes += compressedTs[c + i].length;
        valTotalBytes += compressedVals[c + i].length;
      }

      const tsBlobPtr = w.allocScratch(tsTotalBytes);
      const tsOffsetsPtr = w.allocScratch(nc * 4);
      const tsSizesPtr = w.allocScratch(nc * 4);
      const valBlobPtr = w.allocScratch(valTotalBytes);
      const valOffsetsPtr = w.allocScratch(nc * 4);
      const valSizesPtr = w.allocScratch(nc * 4);

      const m = mem();
      const tsOffs = new Uint32Array(w.memory.buffer, tsOffsetsPtr, nc);
      const tsSzs = new Uint32Array(w.memory.buffer, tsSizesPtr, nc);
      const valOffs = new Uint32Array(w.memory.buffer, valOffsetsPtr, nc);
      const valSzs = new Uint32Array(w.memory.buffer, valSizesPtr, nc);

      let tsOff = 0, valOff = 0;
      for (let i = 0; i < nc; i++) {
        const tsBlob = compressedTs[c + i];
        const valBlob = compressedVals[c + i];
        m.set(tsBlob, tsBlobPtr + tsOff);
        tsOffs[i] = tsOff;
        tsSzs[i] = tsBlob.length;
        tsOff += tsBlob.length;

        m.set(valBlob, valBlobPtr + valOff);
        valOffs[i] = valOff;
        valSzs[i] = valBlob.length;
        valOff += valBlob.length;
      }

      w.accumFeedChunks(
        tsBlobPtr, tsOffsetsPtr, tsSizesPtr,
        valBlobPtr, valOffsetsPtr, valSizesPtr,
        nc,
      );
    }

    const resultPtr = w.accumFinalize();
    return new Float64Array(w.memory.buffer.slice(resultPtr, resultPtr + bucketCount * 8));
  }

  // ─────────────────────────────────────────────────────────────────
  // Verify correctness
  // ─────────────────────────────────────────────────────────────────
  console.log("Verifying correctness...");
  const jsResult = jsAccumulate();
  const wasmResult = wasmAccumulate(8);
  let maxDiff = 0;
  let diffs = 0;
  for (let i = 0; i < bucketCount; i++) {
    const diff = Math.abs(jsResult[i] - wasmResult[i]);
    if (diff > 1e-6) { diffs++; maxDiff = Math.max(maxDiff, diff); }
  }
  if (diffs > 0) {
    console.log(`  ⚠ ${diffs} buckets differ (max diff: ${maxDiff.toExponential(2)})`);
    // Show first few diffs
    let shown = 0;
    for (let i = 0; i < bucketCount && shown < 5; i++) {
      const diff = Math.abs(jsResult[i] - wasmResult[i]);
      if (diff > 1e-6) {
        console.log(`    bucket[${i}]: JS=${jsResult[i].toFixed(4)} WASM=${wasmResult[i].toFixed(4)}`);
        shown++;
      }
    }
  } else {
    console.log("  ✓ All buckets match\n");
  }

  // ─────────────────────────────────────────────────────────────────
  // Benchmark
  // ─────────────────────────────────────────────────────────────────
  console.log("═══ BENCHMARK: JS vs WASM accumulator ═══");
  console.log(`  ${TOTAL_CHUNKS} chunks, ${(TOTAL/1e6).toFixed(1)}M samples, step=1min, agg=sum\n`);

  const jsR = bench(jsAccumulate);
  console.log(`  JS bucket math:      ${jsR.median.toFixed(1).padStart(7)}ms  (${(TOTAL / jsR.median / 1000).toFixed(1)}M samples/s)`);

  for (const batchSize of [1, 4, 8, 16, 32]) {
    const r = bench(() => wasmAccumulate(batchSize));
    const speedup = ((jsR.median - r.median) / jsR.median * 100).toFixed(0);
    console.log(`  WASM batch=${String(batchSize).padEnd(2)}:       ${r.median.toFixed(1).padStart(7)}ms  (${(TOTAL / r.median / 1000).toFixed(1)}M samples/s)  ${speedup}% faster`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Memory comparison
  // ─────────────────────────────────────────────────────────────────
  console.log("\n═══ MEMORY ═══");
  if (globalThis.gc) {
    gc(); gc();
    const before = process.memoryUsage();
    jsAccumulate();
    gc(); gc();
    const afterJs = process.memoryUsage();
    wasmAccumulate(8);
    gc(); gc();
    const afterWasm = process.memoryUsage();
    console.log(`  JS path heap delta:   ${((afterJs.heapUsed - before.heapUsed) / 1048576).toFixed(1)} MB`);
    console.log(`  WASM path heap delta: ${((afterWasm.heapUsed - afterJs.heapUsed) / 1048576).toFixed(1)} MB`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Test different agg functions at batch=8
  // ─────────────────────────────────────────────────────────────────
  console.log("\n═══ AGG FUNCTIONS (WASM batch=8) ═══");
  const aggNames = ["sum", "avg", "min", "max", "count", "last"];
  for (let aggId = 0; aggId < aggNames.length; aggId++) {
    const r = bench(() => {
      w.accumInit(bucketCount, BigInt(Number(qStart)), BigInt(stepN), aggId);
      for (let c = 0; c < TOTAL_CHUNKS; c += 8) {
        const nc = Math.min(8, TOTAL_CHUNKS - c);
        w.resetScratch();
        let tsTotalBytes = 0, valTotalBytes = 0;
        for (let i = 0; i < nc; i++) {
          tsTotalBytes += compressedTs[c + i].length;
          valTotalBytes += compressedVals[c + i].length;
        }
        const tsBlobPtr = w.allocScratch(tsTotalBytes);
        const tsOffsetsPtr = w.allocScratch(nc * 4);
        const tsSizesPtr = w.allocScratch(nc * 4);
        const valBlobPtr = w.allocScratch(valTotalBytes);
        const valOffsetsPtr = w.allocScratch(nc * 4);
        const valSizesPtr = w.allocScratch(nc * 4);
        const m = mem();
        const tsOffs = new Uint32Array(w.memory.buffer, tsOffsetsPtr, nc);
        const tsSzs = new Uint32Array(w.memory.buffer, tsSizesPtr, nc);
        const valOffs = new Uint32Array(w.memory.buffer, valOffsetsPtr, nc);
        const valSzs = new Uint32Array(w.memory.buffer, valSizesPtr, nc);
        let tsOff = 0, valOff = 0;
        for (let i = 0; i < nc; i++) {
          m.set(compressedTs[c + i], tsBlobPtr + tsOff);
          tsOffs[i] = tsOff; tsSzs[i] = compressedTs[c + i].length; tsOff += compressedTs[c + i].length;
          m.set(compressedVals[c + i], valBlobPtr + valOff);
          valOffs[i] = valOff; valSzs[i] = compressedVals[c + i].length; valOff += compressedVals[c + i].length;
        }
        w.accumFeedChunks(tsBlobPtr, tsOffsetsPtr, tsSizesPtr, valBlobPtr, valOffsetsPtr, valSizesPtr, nc);
      }
      w.accumFinalize();
    });
    console.log(`  ${aggNames[aggId].padEnd(8)} ${r.median.toFixed(1).padStart(7)}ms`);
  }

  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
