#!/usr/bin/env node
/**
 * Profile harness — CPU + memory profiling for ingest and query paths.
 *
 * Usage:
 *   node bench/profile.mjs                  # all backends, synthetic data
 *   node bench/profile.mjs column-wasm-full # single backend, detailed
 *   node bench/profile.mjs --otel           # all backends, real OTel data
 *   node bench/profile.mjs --otel column-alp-fused-128
 *   node --cpu-prof bench/profile.mjs       # generate V8 CPU profile
 *
 * Reports: wall time, GC pressure, heap delta, allocation rate, per-phase breakdown.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// ── Config ───────────────────────────────────────────────────────────

const USE_OTEL = process.argv.includes("--otel");
const NUM_SERIES = 500;
const POINTS_PER_SERIES = 100_000;
const CHUNK_SIZE = 512;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n;

// ── Generate data ────────────────────────────────────────────────────

function generateData() {
  const series = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const timestamps = new BigInt64Array(POINTS_PER_SERIES);
    const values = new Float64Array(POINTS_PER_SERIES);
    for (let i = 0; i < POINTS_PER_SERIES; i++) {
      timestamps[i] = T0 + BigInt(i) * INTERVAL;
      // Realistic mix: counters, gauges, constant
      if (s % 5 === 0)
        values[i] = 42.0; // constant
      else if (s % 5 === 1)
        values[i] = i * 1.0; // monotonic counter
      else if (s % 5 === 2)
        values[i] = Math.sin(i * 0.01) * 100; // smooth gauge
      else if (s % 5 === 3)
        values[i] = Math.random() * 1000; // high variance
      else values[i] = Math.floor(i / 100) * 10.0; // step function
    }
    const labels = new Map([
      ["__name__", `metric_${s % 10}`],
      ["job", "test"],
      ["instance", `host-${s}`],
    ]);
    series.push({ labels, timestamps, values });
  }
  return series;
}

// ── WASM loader ──────────────────────────────────────────────────────

function loadWasmSync() {
  const wasmPath = join(pkgDir, "wasm/o11ytsdb-rust.wasm");
  const wasmBytes = readFileSync(wasmPath);
  return wasmBytes;
}

async function makeWasmCodecs(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
  const w = instance.exports;
  const mem = () => new Uint8Array(w.memory.buffer);

  const valuesCodec = {
    name: "rust-wasm",
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
      // Pack all arrays contiguously into WASM memory.
      const valsPtr = w.allocScratch(numArrays * chunkSize * 8);
      for (let i = 0; i < numArrays; i++) {
        const arr = arrays[i];
        mem().set(
          new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
          valsPtr + i * chunkSize * 8
        );
      }
      const outCap = numArrays * chunkSize * 20;
      const outPtr = w.allocScratch(outCap);
      const offsetsPtr = w.allocScratch(numArrays * 4);
      const sizesPtr = w.allocScratch(numArrays * 4);
      const statsPtr = w.allocScratch(numArrays * 64);
      const _totalBytes = w.encodeBatchValuesWithStats(
        valsPtr,
        chunkSize,
        numArrays,
        outPtr,
        outCap,
        offsetsPtr,
        sizesPtr,
        statsPtr
      );
      // Read back results.
      const offsets = new Uint32Array(
        w.memory.buffer.slice(offsetsPtr, offsetsPtr + numArrays * 4)
      );
      const sizes = new Uint32Array(w.memory.buffer.slice(sizesPtr, sizesPtr + numArrays * 4));
      const allStats = new Float64Array(w.memory.buffer.slice(statsPtr, statsPtr + numArrays * 64));
      const _outBuf = new Uint8Array(w.memory.buffer);
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

  const fullCodec = {
    name: "rust-wasm",
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
      return new Uint8Array(
        w.memory.buffer.slice(outPtr, outPtr + w.encodeChunk(tsPtr, valPtr, n, outPtr, outCap))
      );
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

  const alpValuesCodec = {
    name: "rust-wasm-alp",
    encodeValues(values) {
      const n = values.length;
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytesWritten = w.encodeValuesALP(valPtr, n, outPtr, outCap);
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + bytesWritten));
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
        const arr = arrays[i];
        mem().set(
          new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
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

  const alpRangeCodec = {
    rangeDecodeValues(compressedTs, compressedVals, startT, endT) {
      w.resetScratch();
      const tsInPtr = w.allocScratch(compressedTs.length);
      mem().set(compressedTs, tsInPtr);
      const valInPtr = w.allocScratch(compressedVals.length);
      mem().set(compressedVals, valInPtr);
      // Max output is full chunk.
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
      if (n === 0) {
        return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
      }
      return {
        timestamps: new BigInt64Array(w.memory.buffer.slice(outTsPtr, outTsPtr + n * 8)),
        values: new Float64Array(w.memory.buffer.slice(outValPtr, outValPtr + n * 8)),
      };
    },
  };

  return { valuesCodec, alpValuesCodec, tsCodec, fullCodec, alpRangeCodec };
}

// ── Memory helpers ───────────────────────────────────────────────────

function gcAndSnap() {
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed, external: m.external, ab: m.arrayBuffers };
}

function memDelta(before, after) {
  return {
    rss: after.rss - before.rss,
    heap: after.heap - before.heap,
    external: after.external - before.external,
    ab: after.ab - before.ab,
  };
}

function fmtBytes(n) {
  if (Math.abs(n) < 1024) return `${n} B`;
  if (Math.abs(n) < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtRate(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}

// ── Profile a single backend ─────────────────────────────────────────

async function profileBackend(name, makeStore, data, TOTAL_SAMPLES) {
  const result = { name, phases: {} };

  // Phase 1: Create store + register series (no data).
  const snapPre = gcAndSnap();
  const t0 = performance.now();
  const store = makeStore();
  const ids = [];
  for (const { labels } of data) {
    ids.push(store.getOrCreateSeries(labels));
  }
  const tCreate = performance.now();
  const snapCreate = gcAndSnap();
  result.phases.create = {
    ms: tCreate - t0,
    mem: memDelta(snapPre, snapCreate),
  };

  // Phase 2: Ingest all data.
  const tIngestStart = performance.now();
  for (let s = 0; s < data.length; s++) {
    store.appendBatch(ids[s], data[s].timestamps, data[s].values);
  }
  const tIngestEnd = performance.now();
  const snapIngest = gcAndSnap();
  const ingestMs = tIngestEnd - tIngestStart;
  result.phases.ingest = {
    ms: ingestMs,
    rate: (TOTAL_SAMPLES / ingestMs) * 1000,
    mem: memDelta(snapCreate, snapIngest),
  };

  // Phase 3: Query — read all series full range.
  // Compute actual time range from data.
  let qStart = data[0].timestamps[0];
  let qEnd = data[0].timestamps[data[0].timestamps.length - 1];
  for (const s of data) {
    if (s.timestamps[0] < qStart) qStart = s.timestamps[0];
    if (s.timestamps[s.timestamps.length - 1] > qEnd) qEnd = s.timestamps[s.timestamps.length - 1];
  }
  qEnd += 1n; // inclusive → exclusive
  const tQueryStart = performance.now();
  let totalRead = 0;
  for (let s = 0; s < ids.length; s++) {
    const r = store.read(ids[s], qStart, qEnd);
    totalRead += r.timestamps.length;
  }
  const tQueryEnd = performance.now();
  const queryMs = tQueryEnd - tQueryStart;
  const snapQuery = gcAndSnap();
  result.phases.query = {
    ms: queryMs,
    rate: (totalRead / queryMs) * 1000,
    mem: memDelta(snapIngest, snapQuery),
    samplesRead: totalRead,
  };

  // Final memory.
  result.totalMem = memDelta(snapPre, snapQuery);
  result.storeMemory = store.memoryBytes();
  result.bPerPt = store.memoryBytes() / TOTAL_SAMPLES;

  // Correctness spot-check on first series.
  const expectedLen = data[0].timestamps.length;
  const r0 = store.read(ids[0], qStart, qEnd);
  let ok = r0.timestamps.length === expectedLen;
  if (!ok && r0.timestamps.length > 0) {
    console.log(`    ⚠ length mismatch: expected ${expectedLen}, got ${r0.timestamps.length}`);
  }
  if (ok) {
    for (let i = 0; i < expectedLen; i++) {
      if (r0.timestamps[i] !== data[0].timestamps[i]) {
        console.log(
          `    ⚠ ts mismatch at [${i}]: expected ${data[0].timestamps[i]}, got ${r0.timestamps[i]} (diff=${Number(r0.timestamps[i] - data[0].timestamps[i])})`
        );
        ok = false;
        break;
      }
      if (Math.abs(r0.values[i] - data[0].values[i]) > 1e-10) {
        console.log(
          `    ⚠ val mismatch at [${i}]: expected ${data[0].values[i]}, got ${r0.values[i]}`
        );
        ok = false;
        break;
      }
    }
  }
  result.correct = ok;
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const hasGC = typeof global.gc === "function";
  if (!hasGC) {
    console.log("  ⚠ Run with --expose-gc for accurate memory profiling\n");
  }

  // Extract positional filter (backend name), skipping --flag value pairs.
  const positional = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--repeat" || a === "--dataset") {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    positional.push(a);
  }
  const filter = positional[0];

  // Parse --repeat N for OTel data multiplication.
  const repeatIdx = process.argv.indexOf("--repeat");
  const repeat = repeatIdx >= 0 ? Number(process.argv[repeatIdx + 1]) : 1;

  // Parse --dataset NAME to pick a split file (process, cpu, infra) or default host-metrics.
  const dsIdx = process.argv.indexOf("--dataset");
  const dataset = dsIdx >= 0 ? process.argv[dsIdx + 1] : "host-metrics";
  const otelPath = join(__dirname, `data/${dataset}.jsonl`);

  let data, TOTAL_SAMPLES;
  if (USE_OTEL) {
    const { loadOtelData } = await import(join(__dirname, "load-otel.mjs"));
    data = await loadOtelData(otelPath, { repeat });
    TOTAL_SAMPLES = data.reduce((s, d) => s + d.timestamps.length, 0);
    console.log(
      `  Data source: OTel ${dataset} (${data.length} series, ${TOTAL_SAMPLES.toLocaleString()} pts${repeat > 1 ? `, ×${repeat}` : ""})\n`
    );
  } else {
    data = generateData();
    TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
  }
  const wasmBytes = loadWasmSync();
  const { valuesCodec, alpValuesCodec, tsCodec, fullCodec, alpRangeCodec } =
    await makeWasmCodecs(wasmBytes);

  const backends = [];

  // Grouper factory: for OTel data, group by metric name + series length
  // (series must share timestamps to share a group).  For synthetic data, all
  // series have identical timestamps so one group is fine.
  let otelGroupIds;
  if (USE_OTEL) {
    otelGroupIds = [];
    const keyToGroup = new Map();
    let nextGid = 0;
    for (const d of data) {
      const name = d.labels.get("__name__") ?? "";
      const key = `${name}\0${d.timestamps.length}`;
      if (!keyToGroup.has(key)) keyToGroup.set(key, nextGid++);
      otelGroupIds.push(keyToGroup.get(key));
    }
  }
  function makeGrouper() {
    if (!USE_OTEL) return () => 0;
    let idx = 0;
    return (_labels) => otelGroupIds[idx++];
  }

  // Define backends.
  const defs = [
    {
      name: "flat",
      make: async () => {
        const { FlatStore } = await import(join(pkgDir, "dist/flat-store.js"));
        return () => new FlatStore();
      },
    },
    {
      name: `chunked-wasm-${CHUNK_SIZE}`,
      make: async () => {
        const { ChunkedStore } = await import(join(pkgDir, "dist/chunked-store.js"));
        return () => new ChunkedStore(fullCodec, CHUNK_SIZE);
      },
    },
    {
      name: `column-xor-full-${CHUNK_SIZE}`,
      make: async () => {
        const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
        return () => new ColumnStore(valuesCodec, CHUNK_SIZE, makeGrouper(), undefined, tsCodec);
      },
    },
    {
      name: `column-alp-full-${CHUNK_SIZE}`,
      make: async () => {
        const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
        return () => new ColumnStore(alpValuesCodec, CHUNK_SIZE, makeGrouper(), undefined, tsCodec);
      },
    },
    {
      name: `column-alp-fused-${CHUNK_SIZE}`,
      make: async () => {
        const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
        return () =>
          new ColumnStore(
            alpValuesCodec,
            CHUNK_SIZE,
            makeGrouper(),
            undefined,
            tsCodec,
            alpRangeCodec
          );
      },
    },
  ];

  console.log(
    `\n  Profile: ${data.length} series, ${TOTAL_SAMPLES.toLocaleString()} samples (chunk=${CHUNK_SIZE})\n`
  );

  for (const def of defs) {
    if (filter && !def.name.includes(filter)) continue;
    const makeStore = await def.make();
    const result = await profileBackend(def.name, makeStore, data, TOTAL_SAMPLES);
    backends.push(result);
  }

  // ── Summary table ──

  console.log(
    "  ┌─────────────────────────────┬──────────┬──────────┬──────────┬────────┬───────┬────┐"
  );
  console.log(
    "  │ Backend                     │  Ingest  │  Query   │   Mem    │ B/pt   │ Heap  │ OK │"
  );
  console.log(
    "  ├─────────────────────────────┼──────────┼──────────┼──────────┼────────┼───────┼────┤"
  );

  for (const r of backends) {
    const ingestStr = `${fmtRate(r.phases.ingest.rate)}/s`.padStart(8);
    const queryStr = `${fmtRate(r.phases.query.rate)}/s`.padStart(8);
    const memStr = fmtBytes(r.storeMemory).padStart(8);
    const bptStr = `${r.bPerPt.toFixed(1)}`.padStart(6);
    const heapStr = fmtBytes(r.totalMem.heap).padStart(5);
    const ok = r.correct ? "✓" : "✗";
    console.log(
      `  │ ${r.name.padEnd(27)} │ ${ingestStr} │ ${queryStr} │ ${memStr} │ ${bptStr} │ ${heapStr} │ ${ok}  │`
    );
  }
  console.log(
    "  └─────────────────────────────┴──────────┴──────────┴──────────┴────────┴───────┴────┘"
  );

  // ── Detailed per-backend breakdown ──

  if (filter || backends.length === 1) {
    for (const r of backends) {
      console.log(`\n  ── ${r.name} detailed ──\n`);
      console.log(
        `    Create:  ${r.phases.create.ms.toFixed(1)}ms  heap: ${fmtBytes(r.phases.create.mem.heap)}  ab: ${fmtBytes(r.phases.create.mem.ab)}`
      );
      console.log(
        `    Ingest:  ${r.phases.ingest.ms.toFixed(1)}ms  ${fmtRate(r.phases.ingest.rate)} samples/s  heap: ${fmtBytes(r.phases.ingest.mem.heap)}  ab: ${fmtBytes(r.phases.ingest.mem.ab)}`
      );
      console.log(
        `    Query:   ${r.phases.query.ms.toFixed(1)}ms  ${fmtRate(r.phases.query.rate)} samples/s  heap: ${fmtBytes(r.phases.query.mem.heap)}  ab: ${fmtBytes(r.phases.query.mem.ab)}`
      );
      console.log(`    Store:   ${fmtBytes(r.storeMemory)}  (${r.bPerPt.toFixed(1)} B/pt)`);
      console.log(
        `    Total:   rss=${fmtBytes(r.totalMem.rss)}  heap=${fmtBytes(r.totalMem.heap)}  ab=${fmtBytes(r.totalMem.ab)}`
      );
    }
  }

  // ── Phase comparison ──

  if (backends.length > 1) {
    console.log("\n  ── Phase timing breakdown (ms) ──\n");
    console.log(
      `  ${"Backend".padEnd(28)} ${"Create".padStart(8)} ${"Ingest".padStart(8)} ${"Query".padStart(8)} ${"Total".padStart(8)}`
    );
    console.log(
      `  ${"─".repeat(28)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)}`
    );
    for (const r of backends) {
      const total = r.phases.create.ms + r.phases.ingest.ms + r.phases.query.ms;
      console.log(
        `  ${r.name.padEnd(28)} ${r.phases.create.ms.toFixed(1).padStart(8)} ${r.phases.ingest.ms.toFixed(1).padStart(8)} ${r.phases.query.ms.toFixed(1).padStart(8)} ${total.toFixed(1).padStart(8)}`
      );
    }
  }

  console.log("");
  const anyFail = backends.some((r) => !r.correct);
  if (anyFail) {
    console.log("  CORRECTNESS FAILURE\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
