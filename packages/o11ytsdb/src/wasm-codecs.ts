/**
 * Production WASM codec loader for o11ytsdb.
 *
 * Wraps the Rust WASM binary into typed codec interfaces (ValuesCodec,
 * TimestampCodec, RangeDecodeCodec) and SIMD accelerators (msToNs,
 * quantizeBatch).
 *
 * Usage:
 *   const module = await WebAssembly.compile(wasmBytes);
 *   const codecs = await initWasmCodecs(module);
 *   const store = new ColumnStore(codecs.valuesCodec, 640, ..., codecs.tsCodec, codecs.rangeCodec);
 */

import type {
  ChunkStats,
  RangeDecodeCodec,
  RangeDecodeResult,
  TimestampCodec,
  ValuesCodec,
} from "./types.js";

// ── Raw WASM export signatures ──────────────────────────────────────

interface WasmExports {
  memory: WebAssembly.Memory;
  allocScratch: (size: number) => number;
  resetScratch: () => void;
  // XOR-delta values
  encodeValues: (val_ptr: number, count: number, out_ptr: number, out_cap: number) => number;
  decodeValues: (in_ptr: number, in_len: number, val_ptr: number, max: number) => number;
  encodeValuesWithStats: (
    val_ptr: number,
    count: number,
    out_ptr: number,
    out_cap: number,
    stats_ptr: number
  ) => number;
  // ALP values
  encodeValuesALP: (val_ptr: number, count: number, out_ptr: number, out_cap: number) => number;
  decodeValuesALP: (in_ptr: number, in_len: number, val_ptr: number, max: number) => number;
  encodeValuesALPWithStats: (
    val_ptr: number,
    count: number,
    out_ptr: number,
    out_cap: number,
    stats_ptr: number
  ) => number;
  encodeBatchValuesALPWithStats: (
    vals_ptr: number,
    chunkSize: number,
    numArrays: number,
    out_ptr: number,
    out_cap: number,
    offsets_ptr: number,
    sizes_ptr: number,
    stats_ptr: number
  ) => number;
  decodeBatchValuesALP: (
    blobs_ptr: number,
    offsets_ptr: number,
    sizes_ptr: number,
    num_blobs: number,
    out_ptr: number,
    chunkSize: number
  ) => number;
  // Timestamps
  encodeTimestamps: (ts_ptr: number, count: number, out_ptr: number, out_cap: number) => number;
  decodeTimestamps: (in_ptr: number, in_len: number, ts_ptr: number, max: number) => number;
  // Fused range decode
  rangeDecodeALP: (
    ts_ptr: number,
    ts_len: number,
    val_ptr: number,
    val_len: number,
    start_t: bigint,
    end_t: bigint,
    out_ts_ptr: number,
    out_val_ptr: number,
    max_out: number
  ) => number;
  // SIMD accelerators
  msToNs: (in_ptr: number, out_ptr: number, count: number) => void;
  quantizeBatch: (in_ptr: number, out_ptr: number, count: number, scale: number) => void;
}

// ── Public result type ──────────────────────────────────────────────

export interface WasmCodecs {
  /** ALP values codec with fused stats + batch encode/decode. */
  valuesCodec: ValuesCodec;
  /** Delta-of-delta timestamp codec. */
  tsCodec: TimestampCodec;
  /** Fused ALP range-decode codec. */
  rangeCodec: RangeDecodeCodec;
  /**
   * SIMD-accelerated ms→ns conversion.
   * Converts Float64Array of millisecond Number timestamps to BigInt64Array nanoseconds.
   * ~12× faster than a JS BigInt loop.
   */
  msToNs: (ms: Float64Array) => BigInt64Array;
  /**
   * SIMD-accelerated batch quantize.
   * Rounds values to the given decimal precision in-place.
   * ~17× faster than per-element Math.round.
   * @param values - Mutable Float64Array to quantize in-place.
   * @param precision - Number of decimal digits (e.g. 3 → round to 0.001).
   */
  quantizeBatch: (values: Float64Array, precision: number) => void;
  /** XOR-delta (Gorilla) values codec as an alternative to ALP. */
  xorValuesCodec: ValuesCodec;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseStats(wasm: WasmExports, statsPtr: number): ChunkStats {
  const s = new Float64Array(wasm.memory.buffer.slice(statsPtr, statsPtr + 64));
  return {
    minV: s[0]!,
    maxV: s[1]!,
    sum: s[2]!,
    count: s[3]!,
    firstV: s[4]!,
    lastV: s[5]!,
    sumOfSquares: s[6]!,
    resetCount: s[7]!,
  };
}

const DELTA_ALP_TAG = 0xda;

/**
 * Read the sample count from an ALP (or delta-ALP) blob header.
 *
 * Regular ALP: bytes 0..1 are big-endian count.
 * Delta-ALP:   byte 0 is 0xDA tag, bytes 1..8 are base value,
 *              bytes 9..10 are big-endian delta count; total = deltas + 1.
 */
function readAlpSampleCount(buf: Uint8Array): number {
  if (buf.length < 2) return 0;
  if (buf[0] !== DELTA_ALP_TAG) return (buf[0]! << 8) | buf[1]!;
  if (buf.length < 11) return 0;
  return ((buf[9]! << 8) | buf[10]!) + 1;
}

/** Throw if the scratch allocator overflowed (returned 0). */
function checkScratch(ptr: number, label: string): void {
  if (ptr === 0) {
    throw new RangeError(`WASM scratch allocator overflow in ${label}`);
  }
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Instantiate the WASM binary and return production-ready codec interfaces.
 *
 * @param wasmModule - Pre-compiled WebAssembly.Module (caller handles loading).
 *                     In Node.js: `new WebAssembly.Module(readFileSync(path))`
 *                     In browser: `await WebAssembly.compileStreaming(fetch(url))`
 */
export async function initWasmCodecs(wasmModule: WebAssembly.Module): Promise<WasmCodecs> {
  const instance = await WebAssembly.instantiate(wasmModule, { env: {} });
  const wasm = instance.exports as unknown as WasmExports;
  const mem = () => new Uint8Array(wasm.memory.buffer);

  // ── ALP ValuesCodec ──────────────────────────────────────────────

  const valuesCodec: ValuesCodec = {
    name: "alp-wasm",

    encodeValues(values: Float64Array): Uint8Array {
      const n = values.length;
      wasm.resetScratch();
      const valPtr = wasm.allocScratch(n * 8);
      checkScratch(valPtr, "encodeValues/valPtr");
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      checkScratch(outPtr, "encodeValues/outPtr");
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytes = wasm.encodeValuesALP(valPtr, n, outPtr, outCap);
      return new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytes));
    },

    decodeValues(buf: Uint8Array): Float64Array {
      if (buf.length < 2) return new Float64Array(0);
      wasm.resetScratch();
      const inPtr = wasm.allocScratch(buf.length);
      checkScratch(inPtr, "decodeValues/inPtr");
      mem().set(buf, inPtr);
      const maxSamples = readAlpSampleCount(buf);
      if (maxSamples === 0) return new Float64Array(0);
      const valPtr = wasm.allocScratch(maxSamples * 8);
      checkScratch(valPtr, "decodeValues/valPtr");
      const n = wasm.decodeValuesALP(inPtr, buf.length, valPtr, maxSamples);
      return new Float64Array(wasm.memory.buffer.slice(valPtr, valPtr + n * 8));
    },

    encodeValuesWithStats(values: Float64Array) {
      const n = values.length;
      wasm.resetScratch();
      const valPtr = wasm.allocScratch(n * 8);
      checkScratch(valPtr, "encodeValuesWithStats/valPtr");
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      checkScratch(outPtr, "encodeValuesWithStats/outPtr");
      const statsPtr = wasm.allocScratch(64);
      checkScratch(statsPtr, "encodeValuesWithStats/statsPtr");
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytes = wasm.encodeValuesALPWithStats(valPtr, n, outPtr, outCap, statsPtr);
      return {
        compressed: new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytes)),
        stats: parseStats(wasm, statsPtr),
      };
    },

    /** All arrays must have identical length (column-store invariant). */
    encodeBatchValuesWithStats(arrays: Float64Array[]) {
      const numArrays = arrays.length;
      if (numArrays === 0) return [];
      const chunkSize = arrays[0]?.length ?? 0;
      if (!arrays.every((a) => a.length === chunkSize)) {
        throw new RangeError(
          `encodeBatchValuesWithStats: all arrays must have the same length (expected ${chunkSize})`,
        );
      }
      wasm.resetScratch();

      const valsPtr = wasm.allocScratch(numArrays * chunkSize * 8);
      checkScratch(valsPtr, "encodeBatchValuesWithStats/valsPtr");
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
      checkScratch(outPtr, "encodeBatchValuesWithStats/outPtr");
      const offsetsPtr = wasm.allocScratch(numArrays * 4);
      checkScratch(offsetsPtr, "encodeBatchValuesWithStats/offsetsPtr");
      const sizesPtr = wasm.allocScratch(numArrays * 4);
      checkScratch(sizesPtr, "encodeBatchValuesWithStats/sizesPtr");
      const statsPtr = wasm.allocScratch(numArrays * 64);
      checkScratch(statsPtr, "encodeBatchValuesWithStats/statsPtr");

      wasm.encodeBatchValuesALPWithStats(
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
        wasm.memory.buffer.slice(offsetsPtr, offsetsPtr + numArrays * 4)
      );
      const sizes = new Uint32Array(wasm.memory.buffer.slice(sizesPtr, sizesPtr + numArrays * 4));
      const allStats = new Float64Array(
        wasm.memory.buffer.slice(statsPtr, statsPtr + numArrays * 64)
      );

      const results: Array<{ compressed: Uint8Array; stats: ChunkStats }> = [];
      for (let i = 0; i < numArrays; i++) {
        const si = i * 8;
        results.push({
          compressed: new Uint8Array(
            wasm.memory.buffer.slice(outPtr + offsets[i]!, outPtr + offsets[i]! + sizes[i]!)
          ),
          stats: {
            minV: allStats[si]!,
            maxV: allStats[si + 1]!,
            sum: allStats[si + 2]!,
            count: allStats[si + 3]!,
            firstV: allStats[si + 4]!,
            lastV: allStats[si + 5]!,
            sumOfSquares: allStats[si + 6]!,
            resetCount: allStats[si + 7]!,
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
      checkScratch(blobsPtr, "decodeBatchValues/blobsPtr");
      const offsetsPtr = wasm.allocScratch(numBlobs * 4);
      checkScratch(offsetsPtr, "decodeBatchValues/offsetsPtr");
      const sizesPtr = wasm.allocScratch(numBlobs * 4);
      checkScratch(sizesPtr, "decodeBatchValues/sizesPtr");

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
      wasmMem.set(new Uint8Array(offsets.buffer), offsetsPtr);
      wasmMem.set(new Uint8Array(sizes.buffer), sizesPtr);

      const outPtr = wasm.allocScratch(numBlobs * chunkSize * 8);
      checkScratch(outPtr, "decodeBatchValues/outPtr");
      wasm.decodeBatchValuesALP(blobsPtr, offsetsPtr, sizesPtr, numBlobs, outPtr, chunkSize);

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

  // ── XOR-delta ValuesCodec ────────────────────────────────────────

  const xorValuesCodec: ValuesCodec = {
    name: "xor-wasm",

    encodeValues(values: Float64Array): Uint8Array {
      const n = values.length;
      wasm.resetScratch();
      const valPtr = wasm.allocScratch(n * 8);
      checkScratch(valPtr, "xor/encodeValues/valPtr");
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      checkScratch(outPtr, "xor/encodeValues/outPtr");
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytes = wasm.encodeValues(valPtr, n, outPtr, outCap);
      return new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytes));
    },

    decodeValues(buf: Uint8Array): Float64Array {
      if (buf.length < 2) return new Float64Array(0);
      wasm.resetScratch();
      const inPtr = wasm.allocScratch(buf.length);
      checkScratch(inPtr, "xor/decodeValues/inPtr");
      mem().set(buf, inPtr);
      const maxSamples = (buf[0]! << 8) | buf[1]!;
      const valPtr = wasm.allocScratch(maxSamples * 8);
      checkScratch(valPtr, "xor/decodeValues/valPtr");
      const n = wasm.decodeValues(inPtr, buf.length, valPtr, maxSamples);
      return new Float64Array(wasm.memory.buffer.slice(valPtr, valPtr + n * 8));
    },

    encodeValuesWithStats(values: Float64Array) {
      const n = values.length;
      wasm.resetScratch();
      const valPtr = wasm.allocScratch(n * 8);
      checkScratch(valPtr, "xor/encodeValuesWithStats/valPtr");
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      checkScratch(outPtr, "xor/encodeValuesWithStats/outPtr");
      const statsPtr = wasm.allocScratch(64);
      checkScratch(statsPtr, "xor/encodeValuesWithStats/statsPtr");
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytes = wasm.encodeValuesWithStats(valPtr, n, outPtr, outCap, statsPtr);
      return {
        compressed: new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytes)),
        stats: parseStats(wasm, statsPtr),
      };
    },
  };

  // ── Timestamp codec ──────────────────────────────────────────────

  const tsCodec: TimestampCodec = {
    name: "dod-wasm",

    encodeTimestamps(timestamps: BigInt64Array): Uint8Array {
      const n = timestamps.length;
      wasm.resetScratch();
      const tsPtr = wasm.allocScratch(n * 8);
      checkScratch(tsPtr, "encodeTimestamps/tsPtr");
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      checkScratch(outPtr, "encodeTimestamps/outPtr");
      mem().set(
        new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength),
        tsPtr
      );
      const bytes = wasm.encodeTimestamps(tsPtr, n, outPtr, outCap);
      return new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytes));
    },

    decodeTimestamps(buf: Uint8Array): BigInt64Array {
      if (buf.length < 2) return new BigInt64Array(0);
      wasm.resetScratch();
      const inPtr = wasm.allocScratch(buf.length);
      checkScratch(inPtr, "decodeTimestamps/inPtr");
      mem().set(buf, inPtr);
      const maxSamples = (buf[0]! << 8) | buf[1]!;
      const tsPtr = wasm.allocScratch(maxSamples * 8);
      checkScratch(tsPtr, "decodeTimestamps/tsPtr");
      const n = wasm.decodeTimestamps(inPtr, buf.length, tsPtr, maxSamples);
      return new BigInt64Array(wasm.memory.buffer.slice(tsPtr, tsPtr + n * 8));
    },
  };

  // ── Range-decode codec ───────────────────────────────────────────

  const rangeCodec: RangeDecodeCodec = {
    rangeDecodeValues(
      compressedTimestamps: Uint8Array,
      compressedValues: Uint8Array,
      startT: bigint,
      endT: bigint
    ): RangeDecodeResult {
      wasm.resetScratch();

      const tsInPtr = wasm.allocScratch(compressedTimestamps.length);
      checkScratch(tsInPtr, "rangeDecodeValues/tsInPtr");
      mem().set(compressedTimestamps, tsInPtr);

      const valInPtr = wasm.allocScratch(compressedValues.length);
      checkScratch(valInPtr, "rangeDecodeValues/valInPtr");
      mem().set(compressedValues, valInPtr);

      // Derive sample count from the timestamp blob (always regular ALP, never delta-ALP).
      const maxSamples = (compressedTimestamps[0]! << 8) | compressedTimestamps[1]!;
      if (maxSamples === 0) {
        return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
      }
      const outTsPtr = wasm.allocScratch(maxSamples * 8);
      checkScratch(outTsPtr, "rangeDecodeValues/outTsPtr");
      const outValPtr = wasm.allocScratch(maxSamples * 8);
      checkScratch(outValPtr, "rangeDecodeValues/outValPtr");

      const n = wasm.rangeDecodeALP(
        tsInPtr,
        compressedTimestamps.length,
        valInPtr,
        compressedValues.length,
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
        timestamps: new BigInt64Array(wasm.memory.buffer.slice(outTsPtr, outTsPtr + n * 8)),
        values: new Float64Array(wasm.memory.buffer.slice(outValPtr, outValPtr + n * 8)),
      };
    },
  };

  // ── SIMD accelerators ────────────────────────────────────────────

  function msToNsFn(ms: Float64Array): BigInt64Array {
    const n = ms.length;
    wasm.resetScratch();
    const inPtr = wasm.allocScratch(n * 8);
    checkScratch(inPtr, "msToNs/inPtr");
    const outPtr = wasm.allocScratch(n * 8);
    checkScratch(outPtr, "msToNs/outPtr");
    mem().set(new Uint8Array(ms.buffer, ms.byteOffset, ms.byteLength), inPtr);
    wasm.msToNs(inPtr, outPtr, n);
    return new BigInt64Array(wasm.memory.buffer.slice(outPtr, outPtr + n * 8));
  }

  function quantizeBatchFn(values: Float64Array, precision: number): void {
    const n = values.length;
    const scale = 10 ** precision;
    wasm.resetScratch();
    const inPtr = wasm.allocScratch(n * 8);
    const outPtr = wasm.allocScratch(n * 8);
    mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), inPtr);
    wasm.quantizeBatch(inPtr, outPtr, n, scale);
    // Copy result back into the caller's buffer (in-place).
    const result = new Float64Array(wasm.memory.buffer, outPtr, n);
    values.set(result);
  }

  return {
    valuesCodec,
    tsCodec,
    rangeCodec,
    msToNs: msToNsFn,
    quantizeBatch: quantizeBatchFn,
    xorValuesCodec,
  };
}
