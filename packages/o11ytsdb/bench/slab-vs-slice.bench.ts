/**
 * Slab vs Slice RSS benchmark — measures RSS improvement from slab allocation.
 *
 * Compares current behavior (one ArrayBuffer per compressed chunk via
 * buffer.slice()) against a slab allocator that packs many chunks into
 * shared large ArrayBuffers.
 *
 * Uses child_process.execFileSync for clean per-variant RSS isolation.
 *
 * Usage:
 *   npx tsc -p bench/tsconfig.json
 *   node --expose-gc bench/dist/slab-vs-slice.bench.js
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, fmtBytes } from "./harness.js";
import { Rng } from "./vectors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

// ── Types ────────────────────────────────────────────────────────────

type StorageBackend = import("./types.js").StorageBackend;
type ValuesCodec = import("./types.js").ValuesCodec;
type TimestampCodec = import("./types.js").TimestampCodec;
type RangeDecodeCodec = import("./types.js").RangeDecodeCodec;
type QueryEngine = import("./types.js").QueryEngine;
type Labels = import("./types.js").Labels;
type ChunkStats = import("./types.js").ChunkStats;

// ── Configuration ────────────────────────────────────────────────────

const NUM_SERIES = parseInt(process.env.BENCH_SERIES ?? "5000");
const PTS_PER_SERIES = parseInt(process.env.BENCH_PTS ?? "10000");
const CHUNK_SIZE = 640;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n;

// ── Slab Allocator ───────────────────────────────────────────────────

class ByteSlab {
  private slabs: ArrayBuffer[] = [];
  private current: Uint8Array;
  private offset: number;
  readonly slabSize: number;
  private _usedBytes = 0;

  constructor(slabSize = 1024 * 1024) {
    this.slabSize = slabSize;
    const buf = new ArrayBuffer(slabSize);
    this.current = new Uint8Array(buf);
    this.offset = 0;
    this.slabs.push(buf);
  }

  /** Copy data into the slab and return a view into it. */
  alloc(data: Uint8Array): Uint8Array {
    const len = data.length;
    if (len === 0) return new Uint8Array(0);

    // Align to 8 bytes for typed array compatibility.
    const alignedLen = (len + 7) & ~7;

    if (this.offset + alignedLen > this.slabSize) {
      const size = Math.max(this.slabSize, alignedLen);
      const buf = new ArrayBuffer(size);
      this.current = new Uint8Array(buf);
      this.offset = 0;
      this.slabs.push(buf);
    }

    const view = new Uint8Array(this.current.buffer, this.offset, len);
    view.set(data);
    this._usedBytes += len;
    this.offset += alignedLen;
    return view;
  }

  get slabCount(): number {
    return this.slabs.length;
  }
  get totalAllocated(): number {
    return this.slabs.reduce((sum, b) => sum + b.byteLength, 0);
  }
  get usedBytes(): number {
    return this._usedBytes;
  }
}

// ── Slab-Wrapped Codec Adapters (double-copy: buffer.slice → slab) ───

function slabWrappedValuesCodec(inner: ValuesCodec, slab: ByteSlab): ValuesCodec & { name: string } {
  const wrapped: ValuesCodec & { name: string } = {
    name: `slab(${inner.name})`,

    encodeValues(values: Float64Array): Uint8Array {
      return slab.alloc(inner.encodeValues(values));
    },

    decodeValues: inner.decodeValues.bind(inner),

    encodeValuesWithStats(values: Float64Array) {
      const { compressed, stats } = inner.encodeValuesWithStats!(values);
      return { compressed: slab.alloc(compressed), stats };
    },

    encodeBatchValuesWithStats(arrays: Float64Array[]) {
      return inner.encodeBatchValuesWithStats!(arrays).map(
        (r: { compressed: Uint8Array; stats: ChunkStats }) => ({
          compressed: slab.alloc(r.compressed),
          stats: r.stats,
        })
      );
    },
  };

  if (inner.decodeBatchValues) {
    wrapped.decodeBatchValues = inner.decodeBatchValues.bind(inner);
  }

  return wrapped;
}

function slabWrappedTsCodec(inner: TimestampCodec, slab: ByteSlab): TimestampCodec & { name: string } {
  return {
    name: `slab(${inner.name})`,
    encodeTimestamps(timestamps: BigInt64Array): Uint8Array {
      return slab.alloc(inner.encodeTimestamps(timestamps));
    },
    decodeTimestamps: inner.decodeTimestamps.bind(inner),
  };
}

// ── Direct-Slab Codec (zero-copy from WASM → slab, no buffer.slice) ─

type WasmExports = import("./wasm-loader.js").WasmExports;

const DELTA_ALP_TAG = 0xda;

function readAlpSampleCount(buf: Uint8Array): number {
  if (buf.length < 2) return 0;
  if (buf[0] !== DELTA_ALP_TAG) return (buf[0]! << 8) | buf[1]!;
  if (buf.length < 11) return 0;
  return ((buf[9]! << 8) | buf[10]!) + 1;
}

function parseStatsInline(wasmBuf: ArrayBuffer, statsPtr: number): ChunkStats {
  const s = new Float64Array(wasmBuf, statsPtr, 8);
  return {
    minV: s[0]!, maxV: s[1]!, sum: s[2]!, count: s[3]!,
    firstV: s[4]!, lastV: s[5]!, sumOfSquares: s[6]!, resetCount: s[7]!,
  };
}

/**
 * Create ALP codecs that copy WASM output directly into a slab,
 * bypassing buffer.slice() entirely. Single copy: WASM mem → slab.
 */
function directSlabValuesCodec(wasm: WasmExports, slab: ByteSlab): ValuesCodec & { name: string } {
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    name: "direct-slab-alp",

    encodeValues(values: Float64Array): Uint8Array {
      const n = values.length;
      wasm.resetScratch();
      const valPtr = wasm.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytes = wasm.encodeValuesALP(valPtr, n, outPtr, outCap);
      // Direct: view into WASM memory → slab.alloc copies it once.
      return slab.alloc(new Uint8Array(wasm.memory.buffer, outPtr, bytes));
    },

    decodeValues(buf: Uint8Array): Float64Array {
      if (buf.length < 2) return new Float64Array(0);
      wasm.resetScratch();
      const inPtr = wasm.allocScratch(buf.length);
      mem().set(buf, inPtr);
      const maxSamples = readAlpSampleCount(buf);
      if (maxSamples === 0) return new Float64Array(0);
      const valPtr = wasm.allocScratch(maxSamples * 8);
      const n = wasm.decodeValuesALP(inPtr, buf.length, valPtr, maxSamples);
      // Decode still uses buffer.slice — query results are short-lived.
      return new Float64Array(wasm.memory.buffer.slice(valPtr, valPtr + n * 8));
    },

    encodeValuesWithStats(values: Float64Array) {
      const n = values.length;
      wasm.resetScratch();
      const valPtr = wasm.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      const statsPtr = wasm.allocScratch(64);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytes = wasm.encodeValuesALPWithStats(valPtr, n, outPtr, outCap, statsPtr);
      return {
        compressed: slab.alloc(new Uint8Array(wasm.memory.buffer, outPtr, bytes)),
        stats: parseStatsInline(wasm.memory.buffer, statsPtr),
      };
    },

    encodeBatchValuesWithStats(arrays: Float64Array[]) {
      const numArrays = arrays.length;
      if (numArrays === 0) return [];
      const chunkSize = arrays[0]!.length;
      wasm.resetScratch();

      const valsPtr = wasm.allocScratch(numArrays * chunkSize * 8);
      const wasmMem = mem();
      for (let i = 0; i < numArrays; i++) {
        const arr = arrays[i]!;
        wasmMem.set(
          new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
          valsPtr + i * chunkSize * 8
        );
      }

      const outCap = numArrays * chunkSize * 20;
      const outPtr = wasm.allocScratch(outCap);
      const offsetsPtr = wasm.allocScratch(numArrays * 4);
      const sizesPtr = wasm.allocScratch(numArrays * 4);
      const statsPtr = wasm.allocScratch(numArrays * 64);

      wasm.encodeBatchValuesALPWithStats(
        valsPtr, chunkSize, numArrays, outPtr, outCap, offsetsPtr, sizesPtr, statsPtr
      );

      // Read offsets/sizes as views — they're valid until next resetScratch.
      const offsets = new Uint32Array(wasm.memory.buffer, offsetsPtr, numArrays);
      const sizes = new Uint32Array(wasm.memory.buffer, sizesPtr, numArrays);
      const allStats = new Float64Array(wasm.memory.buffer, statsPtr, numArrays * 8);

      const results: Array<{ compressed: Uint8Array; stats: ChunkStats }> = [];
      for (let i = 0; i < numArrays; i++) {
        const si = i * 8;
        results.push({
          // Direct: view into WASM output buffer → slab
          compressed: slab.alloc(new Uint8Array(wasm.memory.buffer, outPtr + offsets[i]!, sizes[i]!)),
          stats: {
            minV: allStats[si]!, maxV: allStats[si + 1]!, sum: allStats[si + 2]!,
            count: allStats[si + 3]!, firstV: allStats[si + 4]!, lastV: allStats[si + 5]!,
            sumOfSquares: allStats[si + 6]!, resetCount: allStats[si + 7]!,
          },
        });
      }
      return results;
    },

    decodeBatchValues(blobs: Uint8Array[], chunkSize: number): Float64Array[] {
      const numBlobs = blobs.length;
      wasm.resetScratch();

      let totalBytes = 0;
      for (const b of blobs) totalBytes += b.length;

      const blobsPtr = wasm.allocScratch(totalBytes);
      const dOffsetsPtr = wasm.allocScratch(numBlobs * 4);
      const dSizesPtr = wasm.allocScratch(numBlobs * 4);

      const wasmMem = mem();
      const offsets = new Uint32Array(numBlobs);
      const sizes = new Uint32Array(numBlobs);
      let off = 0;
      for (let i = 0; i < numBlobs; i++) {
        const b = blobs[i]!;
        wasmMem.set(b, blobsPtr + off);
        offsets[i] = off;
        sizes[i] = b.length;
        off += b.length;
      }
      wasmMem.set(new Uint8Array(offsets.buffer), dOffsetsPtr);
      wasmMem.set(new Uint8Array(sizes.buffer), dSizesPtr);

      const outPtr = wasm.allocScratch(numBlobs * chunkSize * 8);
      wasm.decodeBatchValuesALP(blobsPtr, dOffsetsPtr, dSizesPtr, numBlobs, outPtr, chunkSize);

      const results: Float64Array[] = [];
      for (let i = 0; i < numBlobs; i++) {
        results.push(
          new Float64Array(
            wasm.memory.buffer.slice(outPtr + i * chunkSize * 8, outPtr + (i + 1) * chunkSize * 8)
          )
        );
      }
      return results;
    },
  };
}

function directSlabTsCodec(wasm: WasmExports, slab: ByteSlab): TimestampCodec & { name: string } {
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    name: "direct-slab-dod",

    encodeTimestamps(timestamps: BigInt64Array): Uint8Array {
      const n = timestamps.length;
      wasm.resetScratch();
      const tsPtr = wasm.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      mem().set(
        new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength),
        tsPtr
      );
      const bytes = wasm.encodeTimestamps(tsPtr, n, outPtr, outCap);
      return slab.alloc(new Uint8Array(wasm.memory.buffer, outPtr, bytes));
    },

    decodeTimestamps(buf: Uint8Array): BigInt64Array {
      if (buf.length < 2) return new BigInt64Array(0);
      wasm.resetScratch();
      const inPtr = wasm.allocScratch(buf.length);
      mem().set(buf, inPtr);
      const maxSamples = (buf[0]! << 8) | buf[1]!;
      const tsPtr = wasm.allocScratch(maxSamples * 8);
      const n = wasm.decodeTimestamps(inPtr, buf.length, tsPtr, maxSamples);
      return new BigInt64Array(wasm.memory.buffer.slice(tsPtr, tsPtr + n * 8));
    },
  };
}

// ── Child Process Result ─────────────────────────────────────────────

interface VariantResult {
  name: string;
  rss: number;
  heap: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  storeMem: number;
  ingestMs: number;
  totalSamples: number;
  querySingleMs: number;
  queryAggMs: number;
  queryStepAggMs: number;
  slabCount?: number;
  slabAllocated?: number;
  slabUsed?: number;
  hotBufBytes?: number;
  hotUsedBytes?: number;
}

// ── Child: ingest + measure + query ──────────────────────────────────

async function runChild(mode: string): Promise<void> {
  const log = (msg: string) => process.stderr.write(msg + "\n");
  log(`  [${mode}] starting — ${NUM_SERIES}×${PTS_PER_SERIES} samples`);

  // Load WASM.
  const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } =
    await import("./wasm-loader.js");
  const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
  const wasm = await loadWasm(wasmPath);

  let valuesCodec: ValuesCodec = { name: "alp", ...makeALPValuesCodec(wasm) };
  let tsCodec: TimestampCodec = { name: "dod", ...makeTimestampCodec(wasm) };
  const rangeCodec: RangeDecodeCodec = makeALPRangeCodec(wasm);
  let slab: ByteSlab | undefined;

  // Strip "rr-" prefix — round-robin is handled by ingest pattern, not codec selection.
  const codecMode = mode.startsWith("rr-") ? mode.slice(3) : mode;

  if (codecMode.startsWith("slab-")) {
    const sizeStr = codecMode.replace("slab-", "");
    const slabSize = sizeStr.endsWith("k")
      ? parseInt(sizeStr) * 1024
      : sizeStr.endsWith("m")
        ? parseInt(sizeStr) * 1024 * 1024
        : parseInt(sizeStr);
    slab = new ByteSlab(slabSize);
    valuesCodec = slabWrappedValuesCodec(valuesCodec, slab);
    tsCodec = slabWrappedTsCodec(tsCodec, slab);
    log(`  [${mode}] slab size: ${fmtBytes(slabSize)} (wrap mode — double copy)`);
  } else if (codecMode.startsWith("direct-")) {
    const sizeStr = codecMode.replace("direct-", "");
    const slabSize = sizeStr.endsWith("k")
      ? parseInt(sizeStr) * 1024
      : sizeStr.endsWith("m")
        ? parseInt(sizeStr) * 1024 * 1024
        : parseInt(sizeStr);
    slab = new ByteSlab(slabSize);
    valuesCodec = directSlabValuesCodec(wasm, slab);
    tsCodec = directSlabTsCodec(wasm, slab);
    log(`  [${mode}] slab size: ${fmtBytes(slabSize)} (direct mode — single copy)`);
  }

  // Create store.
  const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
  const store: StorageBackend = new ColumnStore(
    {
      name: "alp-range",
      encodeValues: valuesCodec.encodeValues,
      decodeValues: valuesCodec.decodeValues,
      encodeValuesWithStats: valuesCodec.encodeValuesWithStats,
      encodeBatchValuesWithStats: valuesCodec.encodeBatchValuesWithStats,
      decodeBatchValues: valuesCodec.decodeBatchValues,
    },
    CHUNK_SIZE,
    () => 0,
    `bench-${mode}`,
    {
      name: tsCodec.name,
      encodeTimestamps: tsCodec.encodeTimestamps,
      decodeTimestamps: tsCodec.decodeTimestamps,
    },
    rangeCodec
  );

  // Register series.
  const rng = new Rng(42);
  const ids: number[] = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const labels = new Map<string, string>();
    labels.set("__name__", `metric_${s % 10}`);
    labels.set("host", `host-${s % 50}`);
    labels.set("region", `region-${s % 5}`);
    labels.set("instance", `inst-${s}`);
    ids.push(store.getOrCreateSeries(labels));
  }

  // Ingest — mode determines pattern.
  const useRoundRobin = mode.startsWith("roundrobin") || mode.startsWith("rr-");
  const ingestStart = performance.now();

  if (useRoundRobin) {
    // Round-robin: advance all series by CHUNK_SIZE, then repeat.
    // This mimics real-world scrape-based ingest where all series advance together,
    // allowing the ColumnStore to freeze early and keep hot buffers small.
    // Use per-series RNG state to avoid pre-allocating all data at once.
    const seriesRngs: Rng[] = [];
    const seriesVals: number[] = [];
    for (let s = 0; s < NUM_SERIES; s++) {
      seriesRngs.push(new Rng(42 + s));
      seriesVals.push(seriesRngs[s]!.next() * 100);
    }
    const chunkTs = new BigInt64Array(CHUNK_SIZE);
    const chunkVs = new Float64Array(CHUNK_SIZE);

    for (let offset = 0; offset < PTS_PER_SERIES; offset += CHUNK_SIZE) {
      const end = Math.min(CHUNK_SIZE, PTS_PER_SERIES - offset);
      // Pre-fill timestamps for this chunk (shared across series).
      for (let i = 0; i < end; i++) {
        chunkTs[i] = T0 + BigInt(offset + i) * INTERVAL;
      }
      for (let s = 0; s < NUM_SERIES; s++) {
        const pattern = s % 10;
        const r = seriesRngs[s]!;
        let v = seriesVals[s]!;
        for (let i = 0; i < end; i++) {
          v += r.gaussian(0, 0.05);
          v = Math.max(0, v);
          chunkVs[i] = pattern <= 5 ? Math.round(v * 1000) / 1000 : v;
        }
        seriesVals[s] = v;
        store.appendBatch(
          ids[s]!,
          chunkTs.subarray(0, end),
          chunkVs.subarray(0, end)
        );
      }
      if (offset % (CHUNK_SIZE * 10) === 0) {
        log(`  [${mode}] offset ${offset}/${PTS_PER_SERIES}`);
      }
    }
  } else {
    // Sequential: fill each series completely before moving to next.
    // Pathological for hot buffer growth — series 0 accumulates all points
    // before series 4999 gets any, preventing freeze until all series catch up.
    for (let s = 0; s < NUM_SERIES; s++) {
      const ts = new BigInt64Array(PTS_PER_SERIES);
      const vs = new Float64Array(PTS_PER_SERIES);
      const pattern = s % 10;
      let v = rng.next() * 100;
      for (let i = 0; i < PTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.05);
        v = Math.max(0, v);
        vs[i] = pattern <= 5 ? Math.round(v * 1000) / 1000 : v;
      }
      for (let offset = 0; offset < PTS_PER_SERIES; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, PTS_PER_SERIES);
        store.appendBatch(ids[s]!, ts.subarray(offset, end), vs.subarray(offset, end));
      }
      if ((s + 1) % 1000 === 0) {
        log(`  [${mode}] ${s + 1}/${NUM_SERIES}`);
      }
    }
  }
  const ingestMs = performance.now() - ingestStart;

  // Aggressive GC — give V8 every chance to reclaim temporaries.
  for (let i = 0; i < 10; i++) {
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 30));
  }

  const mem = process.memoryUsage();
  const storeMem = store.memoryBytes();

  // Measure hot buffer waste — access internal state.
  let hotBufBytes = 0;
  let hotUsedBytes = 0;
  try {
    const allSeries = (store as any).allSeries as Array<{ hot: { values: Float64Array; count: number } }>;
    for (const s of allSeries) {
      hotBufBytes += s.hot.values.byteLength; // capacity
      hotUsedBytes += s.hot.count * 8; // actual used
    }
    const groups = (store as any).groups as Array<{ hotTimestamps: BigInt64Array; hotCount: number }>;
    for (const g of groups) {
      hotBufBytes += g.hotTimestamps.byteLength;
      hotUsedBytes += g.hotCount * 8;
    }
  } catch { /* ignore if internal structure changes */ }
  log(`  [${mode}] hotBuf capacity: ${fmtBytes(hotBufBytes)}, used: ${fmtBytes(hotUsedBytes)}, waste: ${fmtBytes(hotBufBytes - hotUsedBytes)}`);

  // Query benchmarks.
  const { ScanEngine } = await import(pkgPath("dist/query.js"));
  const qe: QueryEngine = new ScanEngine();
  const fullEnd = T0 + BigInt(PTS_PER_SERIES) * INTERVAL;

  // Warmup.
  store.read(0, T0, fullEnd);
  qe.query(store, { metric: "metric_0", start: T0, end: fullEnd, agg: "sum" });

  const median = (fn: () => void, n: number): number => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      fn();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)]!;
  };

  const querySingleMs = median(() => store.read(0, T0, fullEnd), 10);
  const queryAggMs = median(
    () => qe.query(store, { metric: "metric_0", start: T0, end: fullEnd, agg: "sum" }),
    5
  );
  const queryStepAggMs = median(
    () =>
      qe.query(store, {
        metric: "metric_0",
        start: T0,
        end: fullEnd,
        agg: "sum",
        step: 60_000n,
      }),
    5
  );

  const result: VariantResult = {
    name: mode,
    rss: mem.rss,
    heap: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    storeMem,
    ingestMs,
    totalSamples: store.sampleCount,
    querySingleMs,
    queryAggMs,
    queryStepAggMs,
    hotBufBytes,
    hotUsedBytes,
  };

  if (slab) {
    result.slabCount = slab.slabCount;
    result.slabAllocated = slab.totalAllocated;
    result.slabUsed = slab.usedBytes;
  }

  log(`  [${mode}] done — RSS=${fmtBytes(mem.rss)}`);
  process.stdout.write(JSON.stringify(result));
}

// ── Driver: fork children, collect results, compare ──────────────────

async function runDriver(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  o11ytsdb — Slab vs Slice RSS Benchmark                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(
    `  Dataset: ${NUM_SERIES.toLocaleString()} series × ${PTS_PER_SERIES.toLocaleString()} pts ` +
      `= ${(NUM_SERIES * PTS_PER_SERIES).toLocaleString()} samples`
  );
  console.log(`  Node: ${process.version}`);
  console.log();

  const variants = ["baseline", "roundrobin", "rr-direct-1m"];
  const results: VariantResult[] = [];

  for (const variant of variants) {
    console.log(`  Running: ${variant}…`);
    try {
      const output = execFileSync(
        process.execPath,
        ["--expose-gc", "--max-old-space-size=4096", __filename, "--child", variant],
        {
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "inherit"],
          timeout: 300_000,
        }
      );
      const result: VariantResult = JSON.parse(output.trim());
      results.push(result);
    } catch (err) {
      console.error(`  ✗ ${variant} failed:`, (err as Error).message?.slice(0, 200));
    }
  }

  if (results.length < 2) {
    console.log("\n  Not enough results to compare.");
    return;
  }

  const baseline = results[0]!;

  // ── Memory table ──
  console.log("\n  ══ Memory At Rest (after GC) ══\n");
  const hdr =
    "    " +
    "Variant".padEnd(14) +
    "RSS".padEnd(12) +
    "RSS Δ".padEnd(12) +
    "ArrayBufs".padEnd(12) +
    "AB Δ".padEnd(12) +
    "External".padEnd(12) +
    "Heap".padEnd(10) +
    "Store".padEnd(10) +
    "RSS/Store";
  console.log(hdr);
  console.log("    " + "─".repeat(hdr.length - 4));

  for (const r of results) {
    const rssDelta = r.rss - baseline.rss;
    const abDelta = r.arrayBuffers - baseline.arrayBuffers;
    const fmtDelta = (d: number) => {
      const sign = d >= 0 ? "+" : "−";
      return `${sign}${fmtBytes(Math.abs(d))}`;
    };
    console.log(
      "    " +
        r.name.padEnd(14) +
        fmtBytes(r.rss).padEnd(12) +
        (r === baseline ? "—" : fmtDelta(rssDelta)).padEnd(12) +
        fmtBytes(r.arrayBuffers).padEnd(12) +
        (r === baseline ? "—" : fmtDelta(abDelta)).padEnd(12) +
        fmtBytes(r.external).padEnd(12) +
        fmtBytes(r.heap).padEnd(10) +
        fmtBytes(r.storeMem).padEnd(10) +
        `${(r.rss / r.storeMem).toFixed(1)}x`
    );
  }

  // ── Performance table ──
  console.log("\n  ══ Performance ══\n");
  const phdr =
    "    " +
    "Variant".padEnd(14) +
    "Ingest".padEnd(16) +
    "Single Read".padEnd(14) +
    "Agg Sum".padEnd(14) +
    "Step-Agg";
  console.log(phdr);
  console.log("    " + "─".repeat(phdr.length - 4));

  for (const r of results) {
    const ingestRate = r.totalSamples / (r.ingestMs / 1000);
    console.log(
      "    " +
        r.name.padEnd(14) +
        `${fmt(ingestRate)}/s`.padEnd(16) +
        `${r.querySingleMs.toFixed(2)} ms`.padEnd(14) +
        `${r.queryAggMs.toFixed(1)} ms`.padEnd(14) +
        `${r.queryStepAggMs.toFixed(1)} ms`
    );
  }

  // ── Slab stats ──
  const slabResults = results.filter((r) => r.slabCount != null);
  if (slabResults.length > 0) {
    console.log("\n  ══ Slab Allocator Stats ══\n");
    for (const r of slabResults) {
      const waste = r.slabAllocated! - r.slabUsed!;
      const pct = ((waste / r.slabAllocated!) * 100).toFixed(1);
      console.log(
        `    ${r.name.padEnd(14)} ${r.slabCount!.toLocaleString().padStart(6)} slabs ` +
          `  used=${fmtBytes(r.slabUsed!).padEnd(10)} ` +
          `allocated=${fmtBytes(r.slabAllocated!).padEnd(10)} ` +
          `waste=${fmtBytes(waste)} (${pct}%)`
      );
    }
  }

  // ── Hot buffer stats ──
  console.log("\n  ══ Hot Buffer Analysis ══\n");
  for (const r of results) {
    if (r.hotBufBytes != null && r.hotBufBytes > 0) {
      const waste = r.hotBufBytes - (r.hotUsedBytes ?? 0);
      const pct = ((waste / r.hotBufBytes) * 100).toFixed(0);
      const compressedEst = r.arrayBuffers - r.hotBufBytes;
      console.log(
        `    ${r.name.padEnd(14)} ` +
          `hotCap=${fmtBytes(r.hotBufBytes).padEnd(10)} ` +
          `hotUsed=${fmtBytes(r.hotUsedBytes ?? 0).padEnd(10)} ` +
          `waste=${fmtBytes(waste)} (${pct}%)  ` +
          `compressed≈${fmtBytes(Math.max(0, compressedEst))}`
      );
    }
  }

  // ── Key findings ──
  const best = results.reduce((a, b) => (a.rss < b.rss ? a : b));
  const savings = baseline.rss - best.rss;
  const pct = ((savings / baseline.rss) * 100).toFixed(0);

  console.log("\n  ══ Key Findings ══\n");
  console.log(`    Baseline RSS:         ${fmtBytes(baseline.rss)} (${(baseline.rss / baseline.storeMem).toFixed(1)}x store memory)`);
  console.log(`    Best variant:         ${best.name} — ${fmtBytes(best.rss)} (${(best.rss / best.storeMem).toFixed(1)}x store memory)`);
  if (savings > 0) {
    console.log(`    RSS saved:            ${fmtBytes(savings)} (${pct}%)`);
    console.log(`    ArrayBuffer savings:  ${fmtBytes(baseline.arrayBuffers - best.arrayBuffers)}`);
  } else {
    console.log(`    No RSS improvement from slab allocation.`);
  }

  // ── RSS breakdown for best variant ──
  console.log(`\n  ══ RSS Breakdown (${best.name}) ══\n`);
  const hotCap = best.hotBufBytes ?? 0;
  const wasmEst = 18 * 1024 * 1024; // ~18 MB constant WASM linear memory
  const heapObj = best.heap;
  const compressedAB = best.arrayBuffers - hotCap;
  const processBase = best.rss - best.external - heapObj;
  console.log(`    Store (compressed + metadata):  ${fmtBytes(best.storeMem).padEnd(12)} — logical data`);
  console.log(`    Hot buffers (capacity):         ${fmtBytes(hotCap).padEnd(12)} — expandable write buffers`);
  console.log(`    Compressed ArrayBuffers:        ${fmtBytes(compressedAB).padEnd(12)} — buffer.slice() per chunk`);
  console.log(`    WASM linear memory:             ${fmtBytes(wasmEst).padEnd(12)} — fixed codec scratch space`);
  console.log(`    JS heap objects:                ${fmtBytes(heapObj).padEnd(12)} — labels, stats, metadata`);
  console.log(`    V8 + process overhead:          ${fmtBytes(Math.max(0, processBase)).padEnd(12)} — runtime, code, stack`);
  console.log(`    ─────────────────────────────────────`);
  console.log(`    Total RSS:                      ${fmtBytes(best.rss)}`);
  console.log(`    Overhead above store:            ${fmtBytes(best.rss - best.storeMem)} (${((best.rss - best.storeMem) / best.storeMem * 100).toFixed(0)}%)`);
  console.log();
}

// ── Entry ────────────────────────────────────────────────────────────

const childIdx = process.argv.indexOf("--child");
if (childIdx !== -1) {
  const mode = process.argv[childIdx + 1] ?? "baseline";
  await runChild(mode);
} else {
  await runDriver();
}
