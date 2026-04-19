#!/usr/bin/env node
// SIMD benchmark: ms→ns, block stats, FNV-1a batch hashing
// Compares: JS baseline → WASM scalar → WASM SIMD

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(
  __dirname,
  'target/wasm32-unknown-unknown/release/simd_experiments.wasm',
);

// ── Load WASM ────────────────────────────────────────────────────────

const wasmBytes = readFileSync(WASM_PATH);
const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
const wasm = instance.exports;
const mem = () => new Uint8Array(wasm.memory.buffer);

function copyF64In(ptr, arr) {
  mem().set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), ptr);
}
function readI64Out(ptr, n) {
  return new BigInt64Array(wasm.memory.buffer.slice(ptr, ptr + n * 8));
}
function readF64Out(ptr, n) {
  return new Float64Array(wasm.memory.buffer.slice(ptr, ptr + n * 8));
}
function readU32Out(ptr, n) {
  return new Uint32Array(wasm.memory.buffer.slice(ptr, ptr + n * 4));
}

// ── Bench harness ────────────────────────────────────────────────────

function bench(name, fn, warmup = 500, iters = 5000) {
  for (let i = 0; i < warmup; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const elapsed = performance.now() - t0;
  const perIter = (elapsed / iters) * 1000; // μs
  return { name, totalMs: elapsed.toFixed(1), iters, usPerIter: perIter.toFixed(2) };
}

function printResults(title, results) {
  console.log(`\n  ── ${title} ──\n`);
  const nameW = Math.max(...results.map((r) => r.name.length), 4);
  console.log(
    `    ${'Name'.padEnd(nameW)}  ${'μs/iter'.padStart(10)}  ${'vs JS'.padStart(8)}`,
  );
  console.log(`    ${'─'.repeat(nameW)}  ${'─'.repeat(10)}  ${'─'.repeat(8)}`);
  const jsUs = parseFloat(results[0].usPerIter);
  for (const r of results) {
    const us = parseFloat(r.usPerIter);
    const ratio = (jsUs / us).toFixed(2) + '×';
    console.log(
      `    ${r.name.padEnd(nameW)}  ${r.usPerIter.padStart(10)}  ${ratio.padStart(8)}`,
    );
  }
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 1: ms → ns conversion
// ═════════════════════════════════════════════════════════════════════

function runMsToNs() {
  const N = 10_000;
  // Realistic ms timestamps (~1.7 trillion ns)
  const msArr = new Float64Array(N);
  const baseMs = 1713500000000; // ~2024-04-19 in ms
  for (let i = 0; i < N; i++) msArr[i] = baseMs + i * 15000;

  // JS baseline
  const jsResult = bench('JS BigInt loop', () => {
    const out = new BigInt64Array(N);
    for (let i = 0; i < N; i++) out[i] = BigInt(msArr[i]) * 1_000_000n;
  });

  // WASM scalar
  wasm.resetScratch();
  const inPtr = wasm.allocScratch(N * 8);
  const outPtr = wasm.allocScratch(N * 8);
  copyF64In(inPtr, msArr);

  const wasmScalar = bench('WASM scalar', () => {
    wasm.ms_to_ns_scalar(inPtr, outPtr, N);
  });

  // WASM SIMD
  const wasmSimd = bench('WASM SIMD i64x2', () => {
    wasm.ms_to_ns_simd(inPtr, outPtr, N);
  });

  // Verify correctness
  wasm.ms_to_ns_simd(inPtr, outPtr, N);
  const out = readI64Out(outPtr, 3);
  const expected = [
    BigInt(Math.trunc(msArr[0])) * 1_000_000n,
    BigInt(Math.trunc(msArr[1])) * 1_000_000n,
    BigInt(Math.trunc(msArr[2])) * 1_000_000n,
  ];
  for (let i = 0; i < 3; i++) {
    if (out[i] !== expected[i]) {
      console.error(`  ⚠ ms→ns mismatch at [${i}]: got ${out[i]}, expected ${expected[i]}`);
    }
  }

  printResults('Experiment 1: ms → ns (N=10,000)', [jsResult, wasmScalar, wasmSimd]);
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 2: Block stats
// ═════════════════════════════════════════════════════════════════════

function runStats() {
  const N = 640; // Typical chunk size

  // Gauge-like values with occasional resets
  const vals = new Float64Array(N);
  let v = 100.0;
  for (let i = 0; i < N; i++) {
    v += (Math.random() - 0.3) * 2.0;
    if (Math.random() < 0.02) v = 50 + Math.random() * 50;
    vals[i] = v;
  }

  // JS baseline
  const jsResult = bench(
    'JS scalar loop',
    () => {
      let minV = vals[0],
        maxV = vals[0],
        sum = vals[0],
        sumSq = vals[0] * vals[0],
        rc = 0;
      for (let i = 1; i < N; i++) {
        const v = vals[i];
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        sum += v;
        sumSq += v * v;
        if (v < vals[i - 1]) rc++;
      }
    },
    2000,
    20000,
  );

  // WASM scalar
  wasm.resetScratch();
  const valPtr = wasm.allocScratch(N * 8);
  const statsPtr = wasm.allocScratch(8 * 8);
  copyF64In(valPtr, vals);

  const wasmScalar = bench(
    'WASM scalar',
    () => {
      wasm.stats_scalar(valPtr, N, statsPtr);
    },
    2000,
    20000,
  );

  // WASM SIMD
  const wasmSimd = bench(
    'WASM SIMD f64x2',
    () => {
      wasm.stats_simd(valPtr, N, statsPtr);
    },
    2000,
    20000,
  );

  // Verify SIMD matches scalar
  wasm.stats_scalar(valPtr, N, statsPtr);
  const scalarStats = readF64Out(statsPtr, 8);
  wasm.stats_simd(valPtr, N, statsPtr);
  const simdStats = readF64Out(statsPtr, 8);
  const labels = ['minV', 'maxV', 'sum', 'count', 'firstV', 'lastV', 'sumSq', 'resetCount'];
  for (let i = 0; i < 8; i++) {
    const diff = Math.abs(scalarStats[i] - simdStats[i]);
    // Allow tiny floating-point differences for sum/sumSq
    const tol = i === 2 || i === 6 ? 1e-6 * Math.abs(scalarStats[i]) : 0;
    if (diff > tol) {
      console.error(
        `  ⚠ stats mismatch [${labels[i]}]: scalar=${scalarStats[i]}, simd=${simdStats[i]}`,
      );
    }
  }

  printResults('Experiment 2: Block stats (N=640, chunk-sized)', [
    jsResult,
    wasmScalar,
    wasmSimd,
  ]);
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 3: FNV-1a batch hashing
// ═════════════════════════════════════════════════════════════════════

function runFnv() {
  // Generate 4 strings of same length (typical: label key=value ~50 chars)
  const LEN = 50;
  const strings = [];
  for (let s = 0; s < 4; s++) {
    const arr = new Uint8Array(LEN);
    for (let i = 0; i < LEN; i++) arr[i] = 32 + Math.floor(Math.random() * 95);
    strings.push(arr);
  }

  // JS baseline: 4 sequential FNV hashes
  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  function jsFnv(buf) {
    let h = FNV_OFFSET;
    for (let i = 0; i < buf.length; i++) {
      h ^= buf[i];
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    return h;
  }

  const jsResult = bench(
    'JS 4× FNV',
    () => {
      jsFnv(strings[0]);
      jsFnv(strings[1]);
      jsFnv(strings[2]);
      jsFnv(strings[3]);
    },
    2000,
    50000,
  );

  // WASM setup
  wasm.resetScratch();
  const ptrs = strings.map((s) => {
    const p = wasm.allocScratch(LEN);
    mem().set(s, p);
    return p;
  });
  const outPtr = wasm.allocScratch(4 * 4);

  // WASM scalar batch
  const wasmScalar = bench(
    'WASM scalar 4×',
    () => {
      wasm.fnv_batch_scalar(ptrs[0], ptrs[1], ptrs[2], ptrs[3], LEN, outPtr);
    },
    2000,
    50000,
  );

  // WASM SIMD batch
  const wasmSimd = bench(
    'WASM SIMD i32x4',
    () => {
      wasm.fnv_batch_simd(ptrs[0], ptrs[1], ptrs[2], ptrs[3], LEN, outPtr);
    },
    2000,
    50000,
  );

  // Verify correctness: scalar vs SIMD
  wasm.fnv_batch_scalar(ptrs[0], ptrs[1], ptrs[2], ptrs[3], LEN, outPtr);
  const scalarHashes = readU32Out(outPtr, 4);
  wasm.fnv_batch_simd(ptrs[0], ptrs[1], ptrs[2], ptrs[3], LEN, outPtr);
  const simdHashes = readU32Out(outPtr, 4);
  for (let i = 0; i < 4; i++) {
    if (scalarHashes[i] !== simdHashes[i]) {
      console.error(
        `  ⚠ FNV mismatch [${i}]: scalar=${scalarHashes[i]}, simd=${simdHashes[i]}`,
      );
    }
    const jsHash = jsFnv(strings[i]);
    if (jsHash !== scalarHashes[i]) {
      console.error(
        `  ⚠ FNV JS vs WASM mismatch [${i}]: js=${jsHash}, wasm=${scalarHashes[i]}`,
      );
    }
  }

  printResults('Experiment 3: FNV-1a 4-way batch (50 bytes each)', [
    jsResult,
    wasmScalar,
    wasmSimd,
  ]);

  // 3b: N-string sequential hashing (realistic: 1000 variable-length strings)
  const NUM_STRINGS = 1000;
  const strs = [];
  let totalPacked = 0;
  for (let i = 0; i < NUM_STRINGS; i++) {
    const len = 20 + Math.floor(Math.random() * 60); // 20-80 bytes
    const arr = new Uint8Array(len);
    for (let j = 0; j < len; j++) arr[j] = 32 + Math.floor(Math.random() * 95);
    strs.push(arr);
    totalPacked += 2 + len;
  }

  // JS baseline
  const jsNResult = bench(
    `JS ${NUM_STRINGS}× FNV`,
    () => {
      for (const s of strs) jsFnv(s);
    },
    500,
    5000,
  );

  // WASM N-string: pack into buffer
  wasm.resetScratch();
  const packedPtr = wasm.allocScratch(totalPacked);
  const nOutPtr = wasm.allocScratch(NUM_STRINGS * 4);
  const wasmMem = mem();
  let off = 0;
  for (const s of strs) {
    wasmMem[packedPtr + off] = (s.length >> 8) & 0xff;
    wasmMem[packedPtr + off + 1] = s.length & 0xff;
    off += 2;
    wasmMem.set(s, packedPtr + off);
    off += s.length;
  }

  const wasmNResult = bench(
    `WASM ${NUM_STRINGS}× FNV`,
    () => {
      wasm.fnv_n_strings(packedPtr, totalPacked, nOutPtr, NUM_STRINGS);
    },
    500,
    5000,
  );

  printResults(`Experiment 3b: FNV-1a ${NUM_STRINGS}× variable-length strings`, [
    jsNResult,
    wasmNResult,
  ]);
}

// ═════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  SIMD Experiments — WASM SIMD vs scalar vs JS       ║');
console.log('╚══════════════════════════════════════════════════════╝');

runMsToNs();
runStats();
runFnv();

console.log('\n  Done.\n');
