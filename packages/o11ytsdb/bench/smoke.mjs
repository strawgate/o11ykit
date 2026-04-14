#!/usr/bin/env node
/**
 * Smoke test — quick validation that all backends ingest + query correctly.
 *
 * 5 series × 512 points, single pass, no warmup loops.
 * Prints ingest rate, memory, and correctness check.
 * Target runtime: <2 seconds.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');

// ── Config ───────────────────────────────────────────────────────────

const NUM_SERIES = 5;
const POINTS_PER_SERIES = 512;
const CHUNK_SIZE = 128;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n; // 15s

// ── Generate data ────────────────────────────────────────────────────

function generateData() {
  const series = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const timestamps = new BigInt64Array(POINTS_PER_SERIES);
    const values = new Float64Array(POINTS_PER_SERIES);
    for (let i = 0; i < POINTS_PER_SERIES; i++) {
      timestamps[i] = T0 + BigInt(i) * INTERVAL;
      values[i] = Math.sin(i * 0.1) * 100 + s * 10;
    }
    const labels = new Map([['__name__', `metric_${s}`], ['job', 'test']]);
    series.push({ labels, timestamps, values });
  }
  return series;
}

// ── WASM loader ──────────────────────────────────────────────────────

async function loadWasmCodecs() {
  const wasmPath = join(pkgDir, 'wasm/o11ytsdb-rust.wasm');
  const wasmBytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
  const w = instance.exports;

  const mem = () => new Uint8Array(w.memory.buffer);

  const valuesCodec = {
    name: 'rust-wasm',
    encodeValues(values) {
      const n = values.length;
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytesWritten = w.encodeValues(valPtr, n, outPtr, outCap);
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + bytesWritten));
    },
    decodeValues(buf) {
      w.resetScratch();
      const inPtr = w.allocScratch(buf.length);
      mem().set(buf, inPtr);
      const maxSamples = (buf[0] << 8) | buf[1];
      const valPtr = w.allocScratch(maxSamples * 8);
      const n = w.decodeValues(inPtr, buf.length, valPtr, maxSamples);
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
      const bytesWritten = w.encodeValuesWithStats(valPtr, n, outPtr, outCap, statsPtr);
      const compressed = new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + bytesWritten));
      const s = new Float64Array(w.memory.buffer.slice(statsPtr, statsPtr + 64));
      return {
        compressed,
        stats: { minV: s[0], maxV: s[1], sum: s[2], count: s[3], firstV: s[4], lastV: s[5], sumOfSquares: s[6], resetCount: s[7] },
      };
    },
  };

  const tsCodec = {
    name: 'rust-wasm-ts',
    encodeTimestamps(timestamps) {
      const n = timestamps.length;
      w.resetScratch();
      const tsPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength), tsPtr);
      const bytesWritten = w.encodeTimestamps(tsPtr, n, outPtr, outCap);
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + bytesWritten));
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

  return { valuesCodec, tsCodec };
}

// ── Test a backend ───────────────────────────────────────────────────

function testBackend(name, store, data) {
  const t0 = performance.now();

  // Ingest.
  for (const { labels, timestamps, values } of data) {
    const id = store.getOrCreateSeries(labels);
    store.appendBatch(id, timestamps, values);
  }
  const ingestMs = performance.now() - t0;
  const totalSamples = NUM_SERIES * POINTS_PER_SERIES;
  const ingestRate = (totalSamples / ingestMs * 1000).toFixed(0);
  const memKB = (store.memoryBytes() / 1024).toFixed(1);
  const bPerPt = (store.memoryBytes() / totalSamples).toFixed(1);

  // Query: read back series 0 full range.
  const start = T0;
  const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;
  const result = store.read(0, start, end);

  // Correctness check.
  const expected = data[0];
  let ok = result.timestamps.length === POINTS_PER_SERIES;
  if (ok) {
    for (let i = 0; i < POINTS_PER_SERIES; i++) {
      if (result.timestamps[i] !== expected.timestamps[i]) { ok = false; break; }
      if (Math.abs(result.values[i] - expected.values[i]) > 1e-10) { ok = false; break; }
    }
  }

  const status = ok ? '✓' : '✗ FAIL';
  console.log(`  ${name.padEnd(30)} ${ingestRate.padStart(8)} samples/s  ${memKB.padStart(7)} KB  ${bPerPt.padStart(5)} B/pt  ${status}`);
  return ok;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const data = generateData();
  const { valuesCodec, tsCodec } = await loadWasmCodecs();

  console.log(`\n  Smoke test: ${NUM_SERIES} series × ${POINTS_PER_SERIES} pts (chunk=${CHUNK_SIZE})\n`);
  console.log(`  ${'Backend'.padEnd(30)} ${'Ingest'.padStart(8)}          ${'Mem'.padStart(7)}     ${'Eff'.padStart(5)}    OK?`);
  console.log(`  ${'─'.repeat(30)} ${'─'.repeat(8)}          ${'─'.repeat(7)}     ${'─'.repeat(5)}    ${'─'.repeat(6)}`);

  let allOk = true;

  // FlatStore.
  {
    const { FlatStore } = await import(join(pkgDir, 'dist/flat-store.js'));
    allOk = testBackend('flat', new FlatStore(), data) && allOk;
  }

  // ChunkedStore + WASM.
  {
    const { ChunkedStore } = await import(join(pkgDir, 'dist/chunked-store.js'));
    const { encodeChunk, decodeChunk } = await import(join(pkgDir, 'dist/codec.js'));
    // Use WASM codec via the wasm-loader.
    const wasmPath = join(pkgDir, 'wasm/o11ytsdb-rust.wasm');
    const wasmBytes = readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
    const w = instance.exports;
    const mem = () => new Uint8Array(w.memory.buffer);
    const codec = {
      name: 'rust-wasm',
      encode(timestamps, values) {
        const n = timestamps.length;
        w.resetScratch();
        const tsPtr = w.allocScratch(n * 8);
        const valPtr = w.allocScratch(n * 8);
        const outCap = n * 20;
        const outPtr = w.allocScratch(outCap);
        const m = mem();
        m.set(new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength), tsPtr);
        m.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
        return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + w.encodeChunk(tsPtr, valPtr, n, outPtr, outCap)));
      },
      decode(buf) {
        w.resetScratch();
        const inPtr = w.allocScratch(buf.length);
        mem().set(buf, inPtr);
        const maxSamples = (buf[0] << 8) | buf[1];
        const tsPtr = w.allocScratch(maxSamples * 8);
        const valPtr = w.allocScratch(maxSamples * 8);
        const n = w.decodeChunk(inPtr, buf.length, tsPtr, valPtr, maxSamples);
        return {
          timestamps: new BigInt64Array(w.memory.buffer.slice(tsPtr, tsPtr + n * 8)),
          values: new Float64Array(w.memory.buffer.slice(valPtr, valPtr + n * 8)),
        };
      },
    };
    allOk = testBackend('chunked-rust-wasm-128', new ChunkedStore(codec, CHUNK_SIZE), data) && allOk;
  }

  // ColumnStore + WASM values only.
  {
    const { ColumnStore } = await import(join(pkgDir, 'dist/column-store.js'));
    allOk = testBackend('column-wasm-values-128', new ColumnStore(valuesCodec, CHUNK_SIZE, () => 0), data) && allOk;
  }

  // ColumnStore + WASM values + WASM timestamps.
  {
    const { ColumnStore } = await import(join(pkgDir, 'dist/column-store.js'));
    allOk = testBackend('column-wasm-full-128', new ColumnStore(valuesCodec, CHUNK_SIZE, () => 0, undefined, tsCodec), data) && allOk;
  }

  console.log('');
  if (allOk) {
    console.log('  All backends passed ✓\n');
  } else {
    console.log('  SOME BACKENDS FAILED ✗\n');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
