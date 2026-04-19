/**
 * Memory diagnostic — break down where RSS goes relative to store memory.
 *
 * Investigates:
 *   1. WASM linear memory high-water mark
 *   2. V8 heap vs external vs arrayBuffers
 *   3. Per-chunk ArrayBuffer overhead
 *   4. Whether GC can reclaim the gap
 *
 * Usage:
 *   node --expose-gc bench/dist/mem-diagnostic.bench.js
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fmtBytes } from "./harness.js";
import { Rng } from "./vectors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

type StorageBackend = import("../dist/types.js").StorageBackend;
type Labels = import("../dist/types.js").Labels;

const CHUNK_SIZE = 640;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n;

function forceGC(): void {
  if (global.gc) {
    for (let i = 0; i < 3; i++) global.gc();
  }
}

function memDump(label: string): void {
  forceGC();
  const m = process.memoryUsage();
  console.log(
    `  ${label.padEnd(40)} RSS=${fmtBytes(m.rss).padEnd(10)} ` +
    `heap=${fmtBytes(m.heapUsed).padEnd(10)} ` +
    `heapTotal=${fmtBytes(m.heapTotal).padEnd(10)} ` +
    `external=${fmtBytes(m.external).padEnd(10)} ` +
    `arrayBufs=${fmtBytes(m.arrayBuffers)}`
  );
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  o11ytsdb — Memory Diagnostic                           ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  memDump("Baseline (empty process)");

  // ── Load WASM and check its memory ──

  const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } =
    await import("./wasm-loader.js");
  const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
  const wasm = await loadWasm(wasmPath);

  const wasmMemPages = (wasm.memory as WebAssembly.Memory).buffer.byteLength;
  console.log(`\n  WASM linear memory: ${fmtBytes(wasmMemPages)} (${wasmMemPages / 65536} pages)`);
  memDump("After WASM load");

  // ── Create store ──

  const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
  const alpVals = makeALPValuesCodec(wasm);
  const wasmTs = makeTimestampCodec(wasm);
  const rangeCodec = makeALPRangeCodec(wasm);

  const store: StorageBackend = new ColumnStore(
    {
      name: "alp-range",
      encodeValues: alpVals.encodeValues,
      decodeValues: alpVals.decodeValues,
      encodeValuesWithStats: alpVals.encodeValuesWithStats,
      encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
      decodeBatchValues: alpVals.decodeBatchValues,
    },
    CHUNK_SIZE,
    () => 0,
    "alp-range-diag",
    {
      name: "rust-wasm-ts",
      encodeTimestamps: wasmTs.encodeTimestamps,
      decodeTimestamps: wasmTs.decodeTimestamps,
    },
    rangeCodec
  );

  memDump("After store creation");

  // ── Ingest 5,000 series × 10,000 points ──

  const NUM_SERIES = 5_000;
  const PTS_PER_SERIES = 10_000;
  const rng = new Rng(42);

  console.log(`\n  ── Ingesting ${NUM_SERIES.toLocaleString()} series × ${PTS_PER_SERIES.toLocaleString()} pts ──\n`);

  // Register all series
  const ids: number[] = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const labels = new Map<string, string>();
    labels.set("__name__", `metric_${s % 10}`);
    labels.set("host", `host-${s % 50}`);
    labels.set("region", `region-${s % 5}`);
    labels.set("instance", `inst-${s}`);
    ids.push(store.getOrCreateSeries(labels));
  }

  memDump("After registering series (no data)");

  // Track WASM memory growth during ingest
  const wasmMemBefore = (wasm.memory as WebAssembly.Memory).buffer.byteLength;

  // Ingest in stages to see memory growth pattern
  const stages = [500, 1000, 2000, 3000, 5000];
  let ingested = 0;

  for (const target of stages) {
    while (ingested < target) {
      const ts = new BigInt64Array(PTS_PER_SERIES);
      const vs = new Float64Array(PTS_PER_SERIES);
      const pattern = ingested % 10;

      // Simple gauge data
      let v = rng.next() * 100;
      for (let i = 0; i < PTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.05);
        v = Math.max(0, v);
        vs[i] = pattern <= 2
          ? Math.round(v * 100) / 100  // 2dp gauge
          : pattern <= 5
            ? Math.round(v * 1000) / 1000  // 3dp gauge
            : v;  // full precision
      }

      for (let offset = 0; offset < PTS_PER_SERIES; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, PTS_PER_SERIES);
        store.appendBatch(ids[ingested]!, ts.subarray(offset, end), vs.subarray(offset, end));
      }
      ingested++;
    }

    const wasmMemNow = (wasm.memory as WebAssembly.Memory).buffer.byteLength;
    const storeMem = store.memoryBytes();
    memDump(`After ${target.toLocaleString()} series (store=${fmtBytes(storeMem)})`);
    console.log(`    WASM linear memory: ${fmtBytes(wasmMemNow)} (grew ${fmtBytes(wasmMemNow - wasmMemBefore)})`);
  }

  // ── Final breakdown ──

  console.log("\n  ── Final Memory Breakdown ──\n");

  forceGC();
  const final = process.memoryUsage();
  const storeMem = store.memoryBytes();
  const wasmMemFinal = (wasm.memory as WebAssembly.Memory).buffer.byteLength;
  const totalSamples = store.sampleCount;

  console.log(`    Store self-reported:   ${fmtBytes(storeMem)}`);
  console.log(`    V8 heap used:          ${fmtBytes(final.heapUsed)}`);
  console.log(`    V8 heap total:         ${fmtBytes(final.heapTotal)}`);
  console.log(`    V8 external:           ${fmtBytes(final.external)}`);
  console.log(`    V8 array buffers:      ${fmtBytes(final.arrayBuffers)}`);
  console.log(`    WASM linear memory:    ${fmtBytes(wasmMemFinal)}`);
  console.log(`    Process RSS:           ${fmtBytes(final.rss)}`);
  console.log();

  // The "explained" memory: heap objects + arrayBuffers (which includes compressed chunks)
  // + WASM linear memory
  const explained = final.heapUsed + final.arrayBuffers + wasmMemFinal;
  const unexplained = final.rss - explained;
  console.log(`    Explained (heap + arrayBufs + WASM): ${fmtBytes(explained)}`);
  console.log(`    Unexplained (RSS gap):               ${fmtBytes(unexplained)}`);
  console.log(`    RSS / store memory:                  ${(final.rss / storeMem).toFixed(1)}x`);
  console.log(`    ArrayBuffers / store memory:          ${(final.arrayBuffers / storeMem).toFixed(1)}x`);
  console.log();

  // ── Test: can aggressive GC reclaim the gap? ──

  console.log("  ── After aggressive GC (10 rounds) ──\n");
  for (let i = 0; i < 10; i++) {
    if (global.gc) global.gc();
    await new Promise(r => setTimeout(r, 50));
  }
  const postGC = process.memoryUsage();
  console.log(`    RSS:          ${fmtBytes(postGC.rss)} (was ${fmtBytes(final.rss)})`);
  console.log(`    Heap used:    ${fmtBytes(postGC.heapUsed)} (was ${fmtBytes(final.heapUsed)})`);
  console.log(`    ArrayBuffers: ${fmtBytes(postGC.arrayBuffers)} (was ${fmtBytes(final.arrayBuffers)})`);
  console.log(`    Reclaimed:    ${fmtBytes(final.rss - postGC.rss)}`);
  console.log();

  // ── Count ArrayBuffer objects in the store ──
  // Estimate: each frozen chunk has 1 Uint8Array for values.
  // Each timestamp chunk has 1 Uint8Array for compressed ts.
  // Chunks per series ≈ PTS_PER_SERIES / CHUNK_SIZE
  const chunksPerSeries = Math.ceil(PTS_PER_SERIES / CHUNK_SIZE);
  const totalChunks = NUM_SERIES * chunksPerSeries;
  // Plus shared timestamp chunks (1 group, so chunksPerSeries timestamp chunks)
  const totalTsChunks = chunksPerSeries;
  const totalArrayBuffers = totalChunks + totalTsChunks;
  // Each ArrayBuffer has ~96 bytes of V8 overhead (BackingStore + pointers)
  const estimatedABOverhead = totalArrayBuffers * 96;

  console.log("  ── ArrayBuffer Object Overhead ──\n");
  console.log(`    Frozen value chunks:    ${totalChunks.toLocaleString()}`);
  console.log(`    Frozen timestamp chunks: ${totalTsChunks.toLocaleString()}`);
  console.log(`    Total ArrayBuffer objects: ${totalArrayBuffers.toLocaleString()}`);
  console.log(`    Estimated V8 overhead (~96 B each): ${fmtBytes(estimatedABOverhead)}`);
  console.log();

  // ── V8 heap total vs used ──
  console.log("  ── V8 Heap Fragmentation ──\n");
  console.log(`    Heap used:     ${fmtBytes(postGC.heapUsed)}`);
  console.log(`    Heap total:    ${fmtBytes(postGC.heapTotal)}`);
  console.log(`    Waste (total-used): ${fmtBytes(postGC.heapTotal - postGC.heapUsed)} (${((1 - postGC.heapUsed/postGC.heapTotal)*100).toFixed(0)}%)`);
  console.log();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
