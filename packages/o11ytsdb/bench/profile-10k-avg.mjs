#!/usr/bin/env node
/**
 * CPU + memory profile: avg aggregation across 10 000 series × 100 dp.
 *
 * Measures ingest, query, and per-phase breakdown with heap snapshots.
 *
 * Usage:
 *   node --expose-gc bench/profile-10k-avg.mjs
 *   node --expose-gc --cpu-prof bench/profile-10k-avg.mjs    # V8 CPU profile
 *   node --expose-gc --heap-prof bench/profile-10k-avg.mjs   # V8 heap profile
 */

import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadBenchCodecs, PKG_DIR } from "./bench-codecs.mjs";

// ── Config ───────────────────────────────────────────────────────────

const NUM_SERIES    = 10_000;
const PTS_PER_SERIES = 100;
const TOTAL_SAMPLES = NUM_SERIES * PTS_PER_SERIES;
const CHUNK_SIZE    = 512;          // frozen chunk size
const T0            = 1_700_000_000_000n;
const INTERVAL      = 15_000n;      // 15s scrape
const AGG_STEP      = 60_000n;      // 1-minute buckets
const REGIONS       = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1", "eu-central-1"];

// ── Helpers ──────────────────────────────────────────────────────────

const hasGC = typeof global.gc === "function";
function gc() { if (hasGC) global.gc(); }

function heapSnap() {
  gc();
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers };
}

function fmtMs(n) { return `${n.toFixed(1)}ms`; }
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

// ── Data generation ──────────────────────────────────────────────────

function generateData() {
  const series = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const timestamps = new BigInt64Array(PTS_PER_SERIES);
    const values = new Float64Array(PTS_PER_SERIES);
    for (let i = 0; i < PTS_PER_SERIES; i++) {
      timestamps[i] = T0 + BigInt(i) * INTERVAL;
      values[i] = Math.sin(i * 0.01 + s * 0.001) * 50 + 100 + (Math.random() - 0.5) * 10;
    }
    series.push({
      labels: new Map([
        ["__name__", "http_requests"],
        ["region", REGIONS[s % REGIONS.length]],
        ["instance", `host-${s}`],
      ]),
      timestamps,
      values,
    });
  }
  return series;
}

// (codecs loaded from bench-codecs.mjs)

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (!hasGC) console.log("  ⚠ Run with --expose-gc for accurate memory\n");

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Profile: avg across 10K series × 100 dp = 1M samples  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`  Config: ${NUM_SERIES.toLocaleString()} series, ${PTS_PER_SERIES} pts/series, chunk=${CHUNK_SIZE}`);
  console.log(`  Query:  avg agg, step=${Number(AGG_STEP)/1000}s, groupBy=[region] (${REGIONS.length} groups)\n`);

  // ── Baseline heap ──
  const heapBase = heapSnap();
  console.log(`  Baseline heap: ${fmtBytes(heapBase.heapUsed)} used, ${fmtBytes(heapBase.rss)} RSS\n`);

  // ── Generate data ──
  const tGen0 = performance.now();
  const data = generateData();
  const tGen1 = performance.now();
  const heapAfterGen = heapSnap();
  console.log(`  Data gen: ${fmtMs(tGen1 - tGen0)}  heap +${fmtBytes(heapAfterGen.heapUsed - heapBase.heapUsed)}`);

  // ── Load WASM + codecs ──
  const { alpValuesCodec, tsCodec, alpRangeCodec, stepAggCodec } = await loadBenchCodecs();
  const { ColumnStore } = await import(join(PKG_DIR, "dist/column-store.js"));
  const { ScanEngine } = await import(join(PKG_DIR, "dist/query.js"));

  const PRECISION = 2; // realistic observability precision

  // ── Ingest ──
  const store = new ColumnStore(alpValuesCodec, CHUNK_SIZE, () => 0, undefined, tsCodec, alpRangeCodec, undefined, PRECISION, stepAggCodec);
  const ids = data.map(d => store.getOrCreateSeries(d.labels));

  gc();
  const heapPreIngest = heapSnap();
  const tIng0 = performance.now();
  for (let s = 0; s < data.length; s++) {
    store.appendBatch(ids[s], data[s].timestamps, data[s].values);
  }
  const tIng1 = performance.now();
  const heapPostIngest = heapSnap();

  console.log(`  Ingest:   ${fmtMs(tIng1 - tIng0)}  (${fmtRate(TOTAL_SAMPLES / (tIng1 - tIng0) * 1000)} samples/s)`);
  console.log(`  Store:    ${fmtBytes(store.memoryBytes())}  (${(store.memoryBytes() / TOTAL_SAMPLES).toFixed(1)} B/pt)`);
  console.log(`  Heap:     +${fmtBytes(heapPostIngest.heapUsed - heapPreIngest.heapUsed)} used, +${fmtBytes(heapPostIngest.rss - heapPreIngest.rss)} RSS\n`);

  // Free raw data to isolate query memory
  data.length = 0;
  gc();

  // ── Query params ──
  const qStart = T0;
  const qEnd = T0 + BigInt(PTS_PER_SERIES) * INTERVAL + 1n;
  const engine = new ScanEngine();

  // ── Warmup ──
  engine.query(store, { metric: "http_requests", start: qStart, end: qEnd, agg: "avg", step: AGG_STEP, groupBy: ["region"] });
  gc();

  // ── Query: avg / 1min step / groupBy region ──
  console.log("  ── avg / 1min step / groupBy region ──\n");

  const heapPreQuery = heapSnap();
  const tQ0 = performance.now();
  const result = engine.query(store, {
    metric: "http_requests",
    start: qStart,
    end: qEnd,
    agg: "avg",
    step: AGG_STEP,
    groupBy: ["region"],
  });
  const tQ1 = performance.now();
  const heapPostQuery = heapSnap();

  const outputPts = result.series.reduce((s, r) => s + r.timestamps.length, 0);
  console.log(`    Time:    ${fmtMs(tQ1 - tQ0)}`);
  console.log(`    Scanned: ${result.scannedSamples.toLocaleString()} samples → ${outputPts.toLocaleString()} output pts (${result.series.length} groups)`);
  console.log(`    Heap:    +${fmtBytes(heapPostQuery.heapUsed - heapPreQuery.heapUsed)} during query`);
  console.log(`    Rate:    ${fmtRate(result.scannedSamples / (tQ1 - tQ0) * 1000)} samples/s\n`);

  // ── Phase breakdown ──
  console.log("  ── Phase breakdown ──\n");

  // Phase A: matchLabel
  gc();
  const tMatch0 = performance.now();
  const matchedIds = store.matchLabel("__name__", "http_requests");
  const tMatch1 = performance.now();
  console.log(`    matchLabel:    ${fmtMs(tMatch1 - tMatch0).padStart(10)}  (${matchedIds.length} series)`);

  // Phase B: readParts
  const useReadParts = typeof store.readParts === "function";
  gc();
  const heapPreRead = heapSnap();
  const tRead0 = performance.now();
  const allParts = [];
  const partsPerSeries = [];
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
  const tRead1 = performance.now();
  const heapPostRead = heapSnap();
  console.log(`    readParts:     ${fmtMs(tRead1 - tRead0).padStart(10)}  (${allParts.length} parts)  heap +${fmtBytes(heapPostRead.heapUsed - heapPreRead.heapUsed)}`);

  // Phase C: groupBy
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
  console.log(`    groupBy:       ${fmtMs(tGroup1 - tGroup0).padStart(10)}  (${groups.size} groups)`);

  // Phase D: stepAggregate per group
  gc();
  const heapPreAgg = heapSnap();
  const tAgg0 = performance.now();
  for (const [, groupRanges] of groups) {
    let minT = BigInt("9223372036854775807");
    let maxT = -minT;
    for (const r of groupRanges) {
      if (r.timestamps.length === 0 && r.stats) {
        if (r.chunkMinT < minT) minT = r.chunkMinT;
        if (r.chunkMaxT > maxT) maxT = r.chunkMaxT;
        continue;
      }
      if (r.timestamps.length === 0) continue;
      if (r.timestamps[0] < minT) minT = r.timestamps[0];
      if (r.timestamps[r.timestamps.length - 1] > maxT)
        maxT = r.timestamps[r.timestamps.length - 1];
    }
    const bucketCount = Number((maxT - minT) / AGG_STEP) + 1;
    const values = new Float64Array(bucketCount);   // avg: init to 0 (sum)
    const counts = new Float64Array(bucketCount);

    const _le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    const minTN = Number(minT);
    const stepN = Number(AGG_STEP);

    for (const r of groupRanges) {
      // Stats-only part: chunk fits in one bucket → fold stats
      if (r.timestamps.length === 0 && r.stats && r.chunkMinT !== undefined && r.chunkMaxT !== undefined) {
        const bLo = (Number(r.chunkMinT) - minTN) / stepN | 0;
        const bHi = (Number(r.chunkMaxT) - minTN) / stepN | 0;
        if (bLo === bHi) {
          values[bLo] += r.stats.sum;
          counts[bLo] += r.stats.count;
          continue;
        }
        // Multi-bucket: decode
        if (r.decode) {
          const decoded = r.decode();
          const src = decoded.timestamps;
          const vs = decoded.values;
          const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
          for (let i = 0, len = src.length; i < len; i++) {
            const off = i << 3;
            const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
            values[bucket] += vs[i];
            counts[bucket]++;
          }
          continue;
        }
      }

      const src = r.timestamps;
      const vs = r.values;
      const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      for (let i = 0, len = src.length; i < len; i++) {
        const off = i << 3;
        const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
        values[bucket] += vs[i];
        counts[bucket]++;
      }
    }

    // Finalize avg
    for (let i = 0; i < bucketCount; i++) {
      if (counts[i] > 0) values[i] /= counts[i];
    }
  }
  const tAgg1 = performance.now();
  const heapPostAgg = heapSnap();

  console.log(`    stepAggregate: ${fmtMs(tAgg1 - tAgg0).padStart(10)}  heap +${fmtBytes(heapPostAgg.heapUsed - heapPreAgg.heapUsed)}`);

  const total = (tMatch1 - tMatch0) + (tRead1 - tRead0) + (tGroup1 - tGroup0) + (tAgg1 - tAgg0);
  console.log(`    ─────────────────────────`);
  console.log(`    total:         ${fmtMs(total).padStart(10)}\n`);

  // ── Repeated query (7 runs, report median) ──
  console.log("  ── Repeated ScanEngine.query (7 runs) ──\n");
  const runs = [];
  const heapRuns = [];
  for (let r = 0; r < 7; r++) {
    gc();
    const hPre = heapSnap();
    const t0 = performance.now();
    engine.query(store, {
      metric: "http_requests",
      start: qStart,
      end: qEnd,
      agg: "avg",
      step: AGG_STEP,
      groupBy: ["region"],
    });
    const t1 = performance.now();
    const hPost = heapSnap();
    runs.push(t1 - t0);
    heapRuns.push(hPost.heapUsed - hPre.heapUsed);
  }
  runs.sort((a, b) => a - b);
  heapRuns.sort((a, b) => a - b);
  const median = runs[3];
  console.log(`    Time:  min=${fmtMs(runs[0])} median=${fmtMs(median)} max=${fmtMs(runs[6])}`);
  console.log(`    Heap:  min=${fmtBytes(heapRuns[0])} median=${fmtBytes(heapRuns[3])} max=${fmtBytes(heapRuns[6])}`);
  console.log(`    Rate:  ${fmtRate(TOTAL_SAMPLES / median * 1000)} samples/s\n`);

  // ── Large step (stats-skip scenario) ──
  const BIG_STEP = 3_600_000n; // 1 hour — 100 dp × 15s = 25 min, all fit in 1-hour bucket
  console.log(`  ── Stats-skip: avg / 1h step / groupBy region ──\n`);
  gc();
  const bigRuns = [];
  for (let r = 0; r < 7; r++) {
    gc();
    const t0 = performance.now();
    engine.query(store, {
      metric: "http_requests",
      start: qStart,
      end: qEnd,
      agg: "avg",
      step: BIG_STEP,
      groupBy: ["region"],
    });
    bigRuns.push(performance.now() - t0);
  }
  bigRuns.sort((a, b) => a - b);
  console.log(`    Time:  min=${fmtMs(bigRuns[0])} median=${fmtMs(bigRuns[3])} max=${fmtMs(bigRuns[6])}`);
  console.log(`    Rate:  ${fmtRate(TOTAL_SAMPLES / bigRuns[3] * 1000)} samples/s  (stats-skip)\n`);

  // ── No groupBy (single output series) ──
  console.log(`  ── avg / 1min step / no groupBy ──\n`);
  gc();
  const noGbRuns = [];
  for (let r = 0; r < 7; r++) {
    gc();
    const t0 = performance.now();
    engine.query(store, {
      metric: "http_requests",
      start: qStart,
      end: qEnd,
      agg: "avg",
      step: AGG_STEP,
    });
    noGbRuns.push(performance.now() - t0);
  }
  noGbRuns.sort((a, b) => a - b);
  console.log(`    Time:  min=${fmtMs(noGbRuns[0])} median=${fmtMs(noGbRuns[3])} max=${fmtMs(noGbRuns[6])}`);
  console.log(`    Rate:  ${fmtRate(TOTAL_SAMPLES / noGbRuns[3] * 1000)} samples/s\n`);

  // ── Final heap summary ──
  gc();
  const heapFinal = heapSnap();
  console.log("  ── Heap summary ──\n");
  console.log(`    Baseline:  ${fmtBytes(heapBase.heapUsed)} heap / ${fmtBytes(heapBase.rss)} RSS`);
  console.log(`    Final:     ${fmtBytes(heapFinal.heapUsed)} heap / ${fmtBytes(heapFinal.rss)} RSS`);
  console.log(`    Delta:     +${fmtBytes(heapFinal.heapUsed - heapBase.heapUsed)} heap / +${fmtBytes(heapFinal.rss - heapBase.rss)} RSS`);
  console.log(`    Store:     ${fmtBytes(store.memoryBytes())}`);
  console.log(`    ArrayBufs: ${fmtBytes(heapFinal.arrayBuffers)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
