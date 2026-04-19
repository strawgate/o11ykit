#!/usr/bin/env node
/**
 * Extended query pattern profiler — tests dimensions the main profiler misses:
 *   - Label selectivity (1 vs 10 vs 100 vs all series)
 *   - GroupBy cardinality (1 group vs 5 vs 30 vs 300)
 *   - Narrow time-range queries
 *   - Multiple label matchers (intersection perf)
 *   - Rate queries vs other aggregations
 *
 * Usage:
 *   cd packages/o11ytsdb
 *   node --expose-gc bench/profile-query-patterns.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

const CHUNK_SIZE = 512;
const T0 = 1_700_000_000_000n; // ms epoch
const INTERVAL = 15_000n;       // 15s in ms
const MIN = 60_000n;            // 1 minute in ms
const HOUR = 3_600_000n;        // 1 hour in ms

// ── WASM loader ──────────────────────────────────────────────────────

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

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(fn, warmup = 2, runs = 7) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    if (globalThis.gc) gc();
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return { median: median(times) };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (typeof globalThis.gc !== "function")
    console.log("  ⚠ Run with --expose-gc for accurate measurements\n");

  const wasmBytes = loadWasmSync();
  const { alpValuesCodec, tsCodec } = await makeWasmCodecs(wasmBytes);
  const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
  const { ScanEngine } = await import(join(pkgDir, "dist/query.js"));

  const engine = new ScanEngine();

  // 300 series × 10K pts = 3M samples
  // 3 label dimensions for selectivity/groupBy testing
  const SERIES = 300;
  const PTS = 10_000;

  console.log(`Ingesting ${SERIES} series × ${PTS} pts = ${(SERIES * PTS / 1e6).toFixed(1)}M samples...`);

  const store = new ColumnStore(alpValuesCodec, CHUNK_SIZE, () => 0, undefined, tsCodec);

  for (let s = 0; s < SERIES; s++) {
    const labels = new Map([
      ["__name__", "cpu_usage"],
      ["host", `host-${s % 30}`],           // 30 distinct hosts
      ["region", `region-${s % 5}`],         // 5 regions
      ["instance", `instance-${s}`],         // 300 unique instances
    ]);
    const id = store.getOrCreateSeries(labels);
    const ts = new BigInt64Array(PTS);
    const vs = new Float64Array(PTS);
    for (let i = 0; i < PTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      vs[i] = Math.random() * 100;
    }
    store.appendBatch(id, ts, vs);
  }

  const start = T0;
  const end = T0 + BigInt(PTS) * INTERVAL + 1n;
  const mid = T0 + BigInt(PTS / 2) * INTERVAL;
  const totalSpan = end - start;

  console.log(`Store: ${(store.memoryBytes() / 1048576).toFixed(1)} MB\n`);

  // ─────────────────────────────────────────────────────────────────
  // 1: SELECTIVITY — how does matching fewer series help?
  // ─────────────────────────────────────────────────────────────────
  console.log("═══ SELECTIVITY (step=1min, agg=sum) ═══");
  for (const [desc, matchers] of [
    ["1 instance (1 series)", [{ label: "instance", value: "instance-0" }]],
    ["1 host (10 series)", [{ label: "host", value: "host-0" }]],
    ["1 region (60 series)", [{ label: "region", value: "region-0" }]],
    ["all (300 series)", undefined],
  ]) {
    const opts = { metric: "cpu_usage", start, end, step: MIN, agg: "sum", matchers };
    const r = bench(() => engine.query(store, opts));
    const result = engine.query(store, opts);
    console.log(`  ${desc.padEnd(26)} ${r.median.toFixed(1).padStart(7)}ms  scanned=${result.scannedSamples.toLocaleString().padStart(12)}  series=${result.scannedSeries}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // 2: MULTIPLE MATCHERS — intersection performance
  // ─────────────────────────────────────────────────────────────────
  console.log("\n═══ MULTIPLE MATCHERS (step=1min, agg=sum) ═══");
  for (const [desc, matchers] of [
    ["0 extra (all 300)", undefined],
    ["1: region (60 series)", [{ label: "region", value: "region-0" }]],
    ["2: region+host (10)", [{ label: "region", value: "region-0" }, { label: "host", value: "host-0" }]],
    ["3: narrow to 1 series", [{ label: "region", value: "region-0" }, { label: "host", value: "host-0" }, { label: "instance", value: "instance-0" }]],
  ]) {
    const opts = { metric: "cpu_usage", start, end, step: MIN, agg: "sum", matchers };
    const r = bench(() => engine.query(store, opts));
    const result = engine.query(store, opts);
    console.log(`  ${desc.padEnd(28)} ${r.median.toFixed(1).padStart(7)}ms  scanned=${result.scannedSamples.toLocaleString().padStart(12)}  series=${result.scannedSeries}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // 3: GROUPBY CARDINALITY
  // ─────────────────────────────────────────────────────────────────
  console.log("\n═══ GROUPBY CARDINALITY (step=1min, agg=sum) ═══");
  for (const [desc, groupBy] of [
    ["no groupBy (1 group)", undefined],
    ["by region (5 groups)", ["region"]],
    ["by host (30 groups)", ["host"]],
    ["by instance (300 groups)", ["instance"]],
    ["by region+host (30)", ["region", "host"]],
  ]) {
    const opts = { metric: "cpu_usage", start, end, step: MIN, agg: "sum", groupBy };
    const r = bench(() => engine.query(store, opts));
    const result = engine.query(store, opts);
    console.log(`  ${desc.padEnd(30)} ${r.median.toFixed(1).padStart(7)}ms  groups=${String(result.series.length).padStart(3)}  scanned=${result.scannedSamples.toLocaleString()}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // 4: TIME RANGE SELECTIVITY
  // ─────────────────────────────────────────────────────────────────
  console.log("\n═══ TIME RANGE (step=1min, agg=sum, all 300 series) ═══");
  for (const [desc, s, e] of [
    ["full range (100%)", start, end],
    ["last 50%", mid, end],
    ["last 10%", start + (totalSpan * 9n / 10n), end],
    ["last 1%", start + (totalSpan * 99n / 100n), end],
    ["first 10min", start, start + 10n * MIN],
    ["middle 10min", mid, mid + 10n * MIN],
  ]) {
    const opts = { metric: "cpu_usage", start: s, end: e, step: MIN, agg: "sum" };
    const r = bench(() => engine.query(store, opts));
    const result = engine.query(store, opts);
    console.log(`  ${desc.padEnd(25)} ${r.median.toFixed(1).padStart(7)}ms  scanned=${result.scannedSamples.toLocaleString().padStart(12)}  buckets=${result.series[0]?.timestamps.length || 0}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // 5: AGG FUNCTION COMPARISON × 300 SERIES
  // ─────────────────────────────────────────────────────────────────
  console.log("\n═══ AGG FUNCTION × 300 SERIES (step=1min) ═══");
  for (const agg of ["sum", "avg", "min", "max", "count", "last", "rate"]) {
    const opts = { metric: "cpu_usage", start, end, step: MIN, agg };
    const r = bench(() => engine.query(store, opts));
    console.log(`  agg=${agg.padEnd(8)} ${r.median.toFixed(1).padStart(7)}ms`);
  }

  // ─────────────────────────────────────────────────────────────────
  // 6: RAW READ SCALING (no aggregation)
  // ─────────────────────────────────────────────────────────────────
  console.log("\n═══ RAW READ (no agg) ═══");
  for (const [desc, matchers] of [
    ["1 series", [{ label: "instance", value: "instance-0" }]],
    ["10 series (host)", [{ label: "host", value: "host-0" }]],
    ["60 series (region)", [{ label: "region", value: "region-0" }]],
    ["all 300 series", undefined],
  ]) {
    const opts = { metric: "cpu_usage", start, end, matchers };
    const r = bench(() => engine.query(store, opts));
    const result = engine.query(store, opts);
    console.log(`  ${desc.padEnd(25)} ${r.median.toFixed(1).padStart(7)}ms  series=${result.scannedSeries}  samples=${result.scannedSamples.toLocaleString()}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // 7: STEP SIZE × SELECTIVITY MATRIX
  // ─────────────────────────────────────────────────────────────────
  console.log("\n═══ STEP SIZE × SELECTIVITY MATRIX (agg=sum) ═══");
  const steps = [
    ["15s", INTERVAL],
    ["1min", MIN],
    ["1h", HOUR],
    ["4h", 4n * HOUR],
  ];
  const selectivities = [
    ["1 series", [{ label: "instance", value: "instance-0" }]],
    ["10 series", [{ label: "host", value: "host-0" }]],
    ["300 series", undefined],
  ];

  // Header
  console.log("  " + "".padEnd(14) + steps.map(([l]) => l.padStart(10)).join(""));
  for (const [selDesc, matchers] of selectivities) {
    let line = "  " + selDesc.padEnd(14);
    for (const [, stepVal] of steps) {
      const opts = { metric: "cpu_usage", start, end, step: stepVal, agg: "sum", matchers };
      const r = bench(() => engine.query(store, opts));
      line += (r.median.toFixed(1) + "ms").padStart(10);
    }
    console.log(line);
  }

  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
