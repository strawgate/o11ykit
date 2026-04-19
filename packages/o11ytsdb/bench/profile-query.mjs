#!/usr/bin/env node
/**
 * Query-focused profiler — reproduces real-world aggregation workloads.
 *
 * Default scenario: 5M datapoints, 30 series, min agg with 1-min step, groupBy region.
 *
 * Usage:
 *   node --expose-gc bench/profile-query.mjs
 *   node --cpu-prof bench/profile-query.mjs           # V8 CPU profile
 *   node --cpu-prof bench/profile-query.mjs --detail  # per-phase CPU profiles
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// ── Config ───────────────────────────────────────────────────────────

const NUM_SERIES = 30;
const POINTS_PER_SERIES = Math.ceil(5_000_000 / NUM_SERIES); // ~166,667 pts each → 5M total
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const CHUNK_SIZE = 512;
const T0 = 1_700_000_000_000n; // epoch ms
const INTERVAL = 15_000n; // 15s scrape interval
const REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1", "eu-central-1"];
const AGG_STEP = 60_000n; // 1 minute aggregation step

// ── Data generation (30 series across 5 regions) ─────────────────────

function generateData() {
  const series = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const timestamps = new BigInt64Array(POINTS_PER_SERIES);
    const values = new Float64Array(POINTS_PER_SERIES);
    for (let i = 0; i < POINTS_PER_SERIES; i++) {
      timestamps[i] = T0 + BigInt(i) * INTERVAL;
      // Realistic gauge data with some variety per series
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

// ── WASM loader (reuse from profile.mjs) ─────────────────────────────

function loadWasmSync() {
  const wasmPath = join(pkgDir, "wasm/o11ytsdb-rust.wasm");
  return readFileSync(wasmPath);
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

function _gcAndSnap() {
  if (global.gc) global.gc();
  return process.memoryUsage();
}

function fmtMs(n) {
  return `${n.toFixed(1)}ms`;
}
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

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const hasGC = typeof global.gc === "function";
  if (!hasGC) console.log("  ⚠ Run with --expose-gc for accurate memory\n");

  console.log(
    `  Scenario: ${NUM_SERIES} series × ${POINTS_PER_SERIES.toLocaleString()} pts = ${TOTAL_SAMPLES.toLocaleString()} samples`
  );
  console.log(
    `  Query: min agg, step=${Number(AGG_STEP) / 1000}s, groupBy=[region], ${REGIONS.length} groups`
  );
  console.log(`  Chunk size: ${CHUNK_SIZE}\n`);

  // ── Setup ──
  const data = generateData();
  const wasmBytes = loadWasmSync();
  const { alpValuesCodec, tsCodec, alpRangeCodec } = await makeWasmCodecs(wasmBytes);

  const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
  const { ScanEngine } = await import(join(pkgDir, "dist/query.js"));

  const backends = [
    {
      name: "column-alp (no range)",
      make: () => new ColumnStore(alpValuesCodec, CHUNK_SIZE, () => 0, undefined, tsCodec),
    },
    {
      name: "column-alp-fused",
      make: () =>
        new ColumnStore(alpValuesCodec, CHUNK_SIZE, () => 0, undefined, tsCodec, alpRangeCodec),
    },
  ];

  const engine = new ScanEngine();

  // Time range for queries
  const qStart = T0;
  const qEnd = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL + 1n;

  for (const backend of backends) {
    console.log(`  ── ${backend.name} ──\n`);

    // Ingest
    const store = backend.make();
    const ids = data.map((d) => store.getOrCreateSeries(d.labels));
    const tIngest0 = performance.now();
    for (let s = 0; s < data.length; s++) {
      store.appendBatch(ids[s], data[s].timestamps, data[s].values);
    }
    const tIngest1 = performance.now();
    console.log(
      `    Ingest: ${fmtMs(tIngest1 - tIngest0)}  (${fmtRate((TOTAL_SAMPLES / (tIngest1 - tIngest0)) * 1000)} samples/s)`
    );
    console.log(
      `    Store:  ${fmtBytes(store.memoryBytes())}  (${(store.memoryBytes() / TOTAL_SAMPLES).toFixed(1)} B/pt)\n`
    );

    // ── Query 1: Raw read all series (no aggregation) ──
    if (hasGC) global.gc();
    const tRead0 = performance.now();
    let readSamples = 0;
    for (const id of ids) {
      const r = store.read(id, qStart, qEnd);
      readSamples += r.timestamps.length;
    }
    const tRead1 = performance.now();
    console.log(
      `    Raw read (all series):    ${fmtMs(tRead1 - tRead0)}  ${fmtRate((readSamples / (tRead1 - tRead0)) * 1000)} samples/s  (${readSamples.toLocaleString()} pts)`
    );

    // ── Query 2: ScanEngine with min agg + step + groupBy ──
    if (hasGC) global.gc();
    const tAgg0 = performance.now();
    const result = engine.query(store, {
      metric: "cpu_usage",
      start: qStart,
      end: qEnd,
      agg: "min",
      step: AGG_STEP,
      groupBy: ["region"],
    });
    const tAgg1 = performance.now();
    const outputPts = result.series.reduce((s, r) => s + r.timestamps.length, 0);
    console.log(
      `    Agg query (min/1m/region): ${fmtMs(tAgg1 - tAgg0)}  scanned=${result.scannedSamples.toLocaleString()} → ${outputPts.toLocaleString()} output pts  (${result.series.length} groups)`
    );

    // ── Break down the aggregation query into phases ──
    if (hasGC) global.gc();

    // Phase A: matchLabel
    const tMatch0 = performance.now();
    const matchedIds = store.matchLabel("__name__", "cpu_usage");
    const tMatch1 = performance.now();

    // Phase B: Read all matching series (readParts when available)
    const useReadParts = typeof store.readParts === "function";
    const tReadPhase0 = performance.now();
    const allParts = []; // flat array of TimeRange parts
    const partsPerSeries = []; // count per series for groupBy
    for (const id of matchedIds) {
      if (useReadParts) {
        const parts = store.readParts(id, qStart, qEnd);
        partsPerSeries.push(parts.length);
        for (const p of parts) allParts.push(p);
      } else {
        allParts.push(store.read(id, qStart, qEnd));
        partsPerSeries.push(1);
      }
    }
    const tReadPhase1 = performance.now();
    const totalParts = allParts.length;

    // Phase C: Group by region
    const tGroup0 = performance.now();
    const groups = new Map();
    let partIdx = 0;
    for (let si = 0; si < matchedIds.length; si++) {
      const labels = store.labels(matchedIds[si]);
      const key = labels?.get("region") ?? "";
      if (!groups.has(key)) groups.set(key, []);
      const g = groups.get(key);
      const n = partsPerSeries[si];
      for (let j = 0; j < n; j++) g.push(allParts[partIdx++]);
    }
    const tGroup1 = performance.now();

    // Phase D: stepAggregate per group (fused DataView → bucket)
    const _le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    const tAggPhase0 = performance.now();
    for (const [, groupRanges] of groups) {
      // Find time bounds
      let minT = BigInt("9223372036854775807");
      let maxT = -minT;
      for (const r of groupRanges) {
        if (r.timestamps.length === 0) continue;
        if (r.timestamps[0] < minT) minT = r.timestamps[0];
        if (r.timestamps[r.timestamps.length - 1] > maxT)
          maxT = r.timestamps[r.timestamps.length - 1];
      }
      const bucketCount = Number((maxT - minT) / AGG_STEP) + 1;
      const timestamps = new BigInt64Array(bucketCount);
      const values = new Float64Array(bucketCount);
      for (let i = 0; i < bucketCount; i++) timestamps[i] = minT + BigInt(i) * AGG_STEP;
      values.fill(Infinity); // min init

      const minTN = Number(minT);
      const stepN = Number(AGG_STEP);

      // Fused: DataView read directly in accumulation loop (no Float64Array alloc)
      for (const r of groupRanges) {
        const src = r.timestamps;
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const vs = r.values;
        for (let i = 0, len = src.length; i < len; i++) {
          const off = i << 3;
          const bucket =
            ((dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN) | 0;
          if (vs[i] < values[bucket]) values[bucket] = vs[i];
        }
      }
    }
    const tAggPhase1 = performance.now();

    console.log(`\n    Phase breakdown${useReadParts ? " (readParts)" : " (read+concat)"}:`);
    console.log(
      `      matchLabel:    ${fmtMs(tMatch1 - tMatch0).padStart(10)}  (${matchedIds.length} series)`
    );
    console.log(
      `      read():        ${fmtMs(tReadPhase1 - tReadPhase0).padStart(10)}  (${totalParts} parts, ${useReadParts ? "skip concat" : "concat"})`
    );
    console.log(
      `      groupBy:       ${fmtMs(tGroup1 - tGroup0).padStart(10)}  (${groups.size} groups)`
    );
    console.log(
      `      stepAggregate: ${fmtMs(tAggPhase1 - tAggPhase0).padStart(10)}  (fused DataView → bucket + min fold)`
    );

    const total =
      tMatch1 -
      tMatch0 +
      (tReadPhase1 - tReadPhase0) +
      (tGroup1 - tGroup0) +
      (tAggPhase1 - tAggPhase0);
    console.log(`      ─────────────────────`);
    console.log(`      total:         ${fmtMs(total).padStart(10)}`);

    // ── Repeat query 5x for stable timing ──
    console.log(`\n    Repeated query (5 runs):`);
    const runs = [];
    for (let r = 0; r < 5; r++) {
      if (hasGC) global.gc();
      const t0 = performance.now();
      engine.query(store, {
        metric: "cpu_usage",
        start: qStart,
        end: qEnd,
        agg: "min",
        step: AGG_STEP,
        groupBy: ["region"],
      });
      const t1 = performance.now();
      runs.push(t1 - t0);
    }
    runs.sort((a, b) => a - b);
    console.log(`      min=${fmtMs(runs[0])}  median=${fmtMs(runs[2])}  max=${fmtMs(runs[4])}`);

    // ── Stats-skip scenario: large step (4h) so chunks fit in 1 bucket ──
    // Chunk span ≈ 512 × 15s = 7,680s ≈ 128min.  4h step → most chunks skip decode.
    const BIG_STEP = 14_400_000n; // 4 hours
    if (hasGC) global.gc();
    const tBig0 = performance.now();
    const bigResult = engine.query(store, {
      metric: "cpu_usage",
      start: qStart,
      end: qEnd,
      agg: "min",
      step: BIG_STEP,
      groupBy: ["region"],
    });
    const tBig1 = performance.now();
    const bigPts = bigResult.series.reduce((s, r) => s + r.timestamps.length, 0);
    console.log(
      `\n    Stats-skip query (min/4h/region): ${fmtMs(tBig1 - tBig0)}  scanned=${bigResult.scannedSamples.toLocaleString()} → ${bigPts.toLocaleString()} output pts`
    );

    // Repeat 5x
    const bigRuns = [];
    for (let r = 0; r < 5; r++) {
      if (hasGC) global.gc();
      const t0 = performance.now();
      engine.query(store, {
        metric: "cpu_usage",
        start: qStart,
        end: qEnd,
        agg: "min",
        step: BIG_STEP,
        groupBy: ["region"],
      });
      const t1 = performance.now();
      bigRuns.push(t1 - t0);
    }
    bigRuns.sort((a, b) => a - b);
    console.log(
      `    Repeated (5 runs): min=${fmtMs(bigRuns[0])}  median=${fmtMs(bigRuns[2])}  max=${fmtMs(bigRuns[4])}`
    );

    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
