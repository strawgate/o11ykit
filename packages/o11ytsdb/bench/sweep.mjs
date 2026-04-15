#!/usr/bin/env node
/**
 * Chunk-size sweep — measures ingest + query throughput across chunk sizes
 * with both full-range and narrow-range queries.
 *
 * Usage:
 *   node --expose-gc bench/sweep.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// ── Config ───────────────────────────────────────────────────────────

const NUM_SERIES = 100;
const POINTS_PER_SERIES = 10_000;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n;
const TOTAL = NUM_SERIES * POINTS_PER_SERIES; // 1M

const CHUNK_SIZES = [64, 128, 192, 256, 320, 384, 448, 512, 576, 640, 704, 768, 832, 896, 960, 1024];

// Narrow query: last 10% of the time range.
const FULL_START = T0;
const FULL_END = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;
const NARROW_START = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL * 9n / 10n;
const NARROW_END = FULL_END;

// ── Data generation ──────────────────────────────────────────────────

function generateData() {
  const series = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const timestamps = new BigInt64Array(POINTS_PER_SERIES);
    const values = new Float64Array(POINTS_PER_SERIES);
    for (let i = 0; i < POINTS_PER_SERIES; i++) {
      timestamps[i] = T0 + BigInt(i) * INTERVAL;
      if (s % 5 === 0) values[i] = 42.0;
      else if (s % 5 === 1) values[i] = i * 1.0;
      else if (s % 5 === 2) values[i] = Math.sin(i * 0.01) * 100;
      else if (s % 5 === 3) values[i] = Math.random() * 1000;
      else values[i] = Math.floor(i / 100) * 10.0;
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

// ── WASM codec loader ────────────────────────────────────────────────

async function loadCodecs() {
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
        stats: { minV: s[0], maxV: s[1], sum: s[2], count: s[3], firstV: s[4], lastV: s[5], sumOfSquares: s[6], resetCount: s[7] },
      };
    },
    encodeBatchValuesWithStats(arrays) {
      const numArrays = arrays.length;
      const chunkSize = arrays[0].length;
      w.resetScratch();
      const valsPtr = w.allocScratch(numArrays * chunkSize * 8);
      for (let i = 0; i < numArrays; i++) {
        const arr = arrays[i];
        mem().set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), valsPtr + i * chunkSize * 8);
      }
      const outCap = numArrays * chunkSize * 20;
      const outPtr = w.allocScratch(outCap);
      const offsetsPtr = w.allocScratch(numArrays * 4);
      const sizesPtr = w.allocScratch(numArrays * 4);
      const statsPtr = w.allocScratch(numArrays * 64);
      w.encodeBatchValuesALPWithStats(
        valsPtr, chunkSize, numArrays, outPtr, outCap, offsetsPtr, sizesPtr, statsPtr
      );
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
        tsInPtr, compressedTs.length,
        valInPtr, compressedVals.length,
        startT, endT,
        outTsPtr, outValPtr,
        maxSamples,
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

function fmtRate(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}

function fmtMs(n) { return n.toFixed(1); }

// ── Run one configuration ────────────────────────────────────────────

async function runConfig(chunkSize, data, codecs, useFused, makeGrouper, totalPts, queryRange) {
  const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
  const { alpValuesCodec, tsCodec, alpRangeCodec } = codecs;

  const store = useFused
    ? new ColumnStore(alpValuesCodec, chunkSize, makeGrouper(), undefined, tsCodec, alpRangeCodec)
    : new ColumnStore(alpValuesCodec, chunkSize, makeGrouper(), undefined, tsCodec);

  // Register series.
  const ids = [];
  for (const { labels } of data) ids.push(store.getOrCreateSeries(labels));

  const qFullStart = queryRange.fullStart;
  const qFullEnd = queryRange.fullEnd;
  const qNarrowStart = queryRange.narrowStart;
  const qNarrowEnd = queryRange.narrowEnd;

  // Ingest.
  const t0 = performance.now();
  for (let s = 0; s < data.length; s++) {
    store.appendBatch(ids[s], data[s].timestamps, data[s].values);
  }
  const ingestMs = performance.now() - t0;

  // Full-range query.
  const tFull0 = performance.now();
  let fullRead = 0;
  for (const id of ids) {
    const r = store.read(id, qFullStart, qFullEnd);
    fullRead += r.timestamps.length;
  }
  const fullMs = performance.now() - tFull0;

  // Narrow query (last 10%).
  const tNarrow0 = performance.now();
  let narrowRead = 0;
  for (const id of ids) {
    const r = store.read(id, qNarrowStart, qNarrowEnd);
    narrowRead += r.timestamps.length;
  }
  const narrowMs = performance.now() - tNarrow0;

  // Correctness spot-check.
  // Timestamp codec has ms precision — allow 1ms tolerance for nanosecond OTel data.
  const r0 = store.read(ids[0], qFullStart, qFullEnd);
  const expectedLen = data[0].timestamps.length;
  let ok = r0.timestamps.length === expectedLen;
  if (!ok && !runConfig._diagShown) {
    runConfig._diagShown = true;
    console.log(`  [DIAG] chunk=${chunkSize} fused=${useFused}: expected ${expectedLen} pts, got ${r0.timestamps.length}`);
    console.log(`         query=[${qFullStart}, ${qFullEnd}]`);
    console.log(`         series0 range=[${data[0].timestamps[0]}, ${data[0].timestamps[data[0].timestamps.length - 1]}]`);
    if (r0.timestamps.length > 0) {
      console.log(`         result range=[${r0.timestamps[0]}, ${r0.timestamps[r0.timestamps.length - 1]}]`);
    }
  }
  if (ok) {
    for (let i = 0; i < expectedLen; i++) {
      if (r0.timestamps[i] !== data[0].timestamps[i] ||
          Math.abs(r0.values[i] - data[0].values[i]) > 1e-10) {
        ok = false;
        break;
      }
    }
  }

  return {
    chunkSize,
    fused: useFused,
    ingestMs,
    ingestRate: totalPts / ingestMs * 1000,
    fullMs,
    fullRate: fullRead / fullMs * 1000,
    narrowMs,
    narrowRate: narrowRead / narrowMs * 1000,
    bPerPt: store.memoryBytes() / totalPts,
    correct: ok,
    fullRead,
    narrowRead,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const USE_OTEL = process.argv.includes("--otel");
  const dsIdx = process.argv.indexOf("--dataset");
  const dataset = dsIdx >= 0 ? process.argv[dsIdx + 1] : "host-metrics";
  const repeatIdx = process.argv.indexOf("--repeat");
  const repeat = repeatIdx >= 0 ? Number(process.argv[repeatIdx + 1]) : 1;

  let data, totalPts, queryRange, makeGrouper;

  if (USE_OTEL) {
    const { loadOtelData } = await import(join(__dirname, "load-otel.mjs"));
    data = await loadOtelData(join(__dirname, `data/${dataset}.jsonl`), { repeat });
    totalPts = data.reduce((s, d) => s + d.timestamps.length, 0);
    // Compute time range from data.
    let minT = data[0].timestamps[0];
    let maxT = data[0].timestamps[data[0].timestamps.length - 1];
    for (const d of data) {
      if (d.timestamps[0] < minT) minT = d.timestamps[0];
      if (d.timestamps[d.timestamps.length - 1] > maxT) maxT = d.timestamps[d.timestamps.length - 1];
    }
    const range = maxT - minT;
    queryRange = {
      fullStart: minT,
      fullEnd: maxT,
      narrowStart: minT + range * 9n / 10n,
      narrowEnd: maxT,
    };
    // Group by metric name + series length (series must share timestamps to share a group).
    // Pre-compute group assignments based on data characteristics.
    const seriesGroupIds = [];
    {
      const keyToGroup = new Map();
      let nextGid = 0;
      for (const d of data) {
        const name = d.labels.get("__name__") ?? "";
        const key = `${name}\0${d.timestamps.length}`;
        if (!keyToGroup.has(key)) keyToGroup.set(key, nextGid++);
        seriesGroupIds.push(keyToGroup.get(key));
      }
    }
    makeGrouper = () => {
      let idx = 0;
      return (_labels) => seriesGroupIds[idx++];
    };
    console.log(`\n  Chunk-size sweep (OTel ${dataset}): ${data.length} series, ${totalPts.toLocaleString()} pts${repeat > 1 ? ` (×${repeat})` : ""}`);
  } else {
    data = generateData();
    totalPts = TOTAL;
    queryRange = {
      fullStart: FULL_START,
      fullEnd: FULL_END,
      narrowStart: NARROW_START,
      narrowEnd: NARROW_END,
    };
    makeGrouper = () => () => 0;
    console.log(`\n  Chunk-size sweep: ${NUM_SERIES} series × ${POINTS_PER_SERIES.toLocaleString()} pts = ${TOTAL.toLocaleString()} samples`);
  }
  console.log(`  Narrow query: last 10% of range\n`);

  const codecs = await loadCodecs();

  const results = [];

  for (const cs of CHUNK_SIZES) {
    // ALP without fused (Path B).
    const r1 = await runConfig(cs, data, codecs, false, makeGrouper, totalPts, queryRange);
    results.push(r1);
    // ALP with fused range-decode (Path A).
    const r2 = await runConfig(cs, data, codecs, true, makeGrouper, totalPts, queryRange);
    results.push(r2);

    if (global.gc) global.gc();
  }

  // ── Table output ──

  console.log("  ┌───────┬───────┬──────────┬──────────┬──────────┬──────────┬──────────┬───────┬────┐");
  console.log("  │ Chunk │ Fused │  Ingest  │  Full Q  │ Full ms  │ Narrow Q │ Narrw ms │ B/pt  │ OK │");
  console.log("  ├───────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────┼────┤");

  for (const r of results) {
    const cs = String(r.chunkSize).padStart(5);
    const fused = r.fused ? "  ✓  " : "     ";
    const ingest = `${fmtRate(r.ingestRate)}/s`.padStart(8);
    const fullQ = `${fmtRate(r.fullRate)}/s`.padStart(8);
    const fullMs = `${fmtMs(r.fullMs)}`.padStart(8);
    const narrowQ = `${fmtRate(r.narrowRate)}/s`.padStart(8);
    const narrowMs = `${fmtMs(r.narrowMs)}`.padStart(8);
    const bpt = `${r.bPerPt.toFixed(1)}`.padStart(5);
    const ok = r.correct ? "✓" : "✗";
    console.log(`  │ ${cs} │ ${fused} │ ${ingest} │ ${fullQ} │ ${fullMs} │ ${narrowQ} │ ${narrowMs} │ ${bpt} │ ${ok}  │`);
  }
  console.log("  └───────┴───────┴──────────┴──────────┴──────────┴──────────┴──────────┴───────┴────┘");

  // Summary — best configs.
  const correct = results.filter(r => r.correct);
  if (correct.length > 0) {
    const bestFull = correct.reduce((a, b) => a.fullRate > b.fullRate ? a : b);
    const bestNarrow = correct.reduce((a, b) => a.narrowRate > b.narrowRate ? a : b);
    const bestIngest = correct.reduce((a, b) => a.ingestRate > b.ingestRate ? a : b);
    const bestCompress = correct.reduce((a, b) => a.bPerPt < b.bPerPt ? a : b);
    console.log(`\n  Best full-range query:   chunk=${bestFull.chunkSize} fused=${bestFull.fused} → ${fmtRate(bestFull.fullRate)}/s (${fmtMs(bestFull.fullMs)}ms)`);
    console.log(`  Best narrow query:       chunk=${bestNarrow.chunkSize} fused=${bestNarrow.fused} → ${fmtRate(bestNarrow.narrowRate)}/s (${fmtMs(bestNarrow.narrowMs)}ms)`);
    console.log(`  Best ingest:             chunk=${bestIngest.chunkSize} fused=${bestIngest.fused} → ${fmtRate(bestIngest.ingestRate)}/s`);
    console.log(`  Best compression:        chunk=${bestCompress.chunkSize} → ${bestCompress.bPerPt.toFixed(1)} B/pt`);
  }

  const failures = results.filter(r => !r.correct);
  if (failures.length > 0) {
    console.log(`\n  ⚠ CORRECTNESS FAILURES: ${failures.map(r => `chunk=${r.chunkSize} fused=${r.fused}`).join(", ")}`);
  }

  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
