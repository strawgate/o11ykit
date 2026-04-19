/**
 * WASM codec loader for o11ytsdb.
 *
 * Loads a .wasm binary and wraps it in the CodecImpl interface.
 * Both Rust and Zig produce the same ABI:
 *   - encodeChunk(ts_ptr, val_ptr, count, out_ptr, out_cap) → bytes_written
 *   - decodeChunk(in_ptr, in_len, ts_ptr, val_ptr, max_samples) → n_samples
 *   - allocScratch(size) → ptr
 *   - resetScratch()
 *   - memory: exported WebAssembly.Memory
 */

import { readFileSync } from "node:fs";
import type { CodecImpl } from "./codec.bench.js";

export interface WasmExports {
  memory: WebAssembly.Memory;
  // XOR-delta (Gorilla) codec
  encodeChunk: (
    ts_ptr: number,
    val_ptr: number,
    count: number,
    out_ptr: number,
    out_cap: number
  ) => number;
  decodeChunk: (
    in_ptr: number,
    in_len: number,
    ts_ptr: number,
    val_ptr: number,
    max_samples: number
  ) => number;
  encodeChunkWithStats: (
    ts_ptr: number,
    val_ptr: number,
    count: number,
    out_ptr: number,
    out_cap: number,
    stats_ptr: number
  ) => number;
  encodeValues: (val_ptr: number, count: number, out_ptr: number, out_cap: number) => number;
  decodeValues: (in_ptr: number, in_len: number, val_ptr: number, max_samples: number) => number;
  encodeValuesWithStats: (
    val_ptr: number,
    count: number,
    out_ptr: number,
    out_cap: number,
    stats_ptr: number
  ) => number;
  // ALP (Adaptive Lossless floating-Point) codec
  encodeValuesALP: (val_ptr: number, count: number, out_ptr: number, out_cap: number) => number;
  decodeValuesALP: (in_ptr: number, in_len: number, val_ptr: number, max_samples: number) => number;
  encodeValuesALPWithStats: (
    val_ptr: number,
    count: number,
    out_ptr: number,
    out_cap: number,
    stats_ptr: number
  ) => number;
  encodeBatchValuesALPWithStats: (
    vals_ptr: number,
    chunk_size: number,
    num_arrays: number,
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
    chunk_size: number
  ) => number;
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
  // Timestamps
  encodeTimestamps: (ts_ptr: number, count: number, out_ptr: number, out_cap: number) => number;
  decodeTimestamps: (in_ptr: number, in_len: number, ts_ptr: number, max_samples: number) => number;
  // Memory management
  allocScratch: (size: number) => number;
  resetScratch: () => void;
}

/**
 * Load a WASM file and return the raw exports.
 */
export async function loadWasm(wasmPath: string): Promise<WasmExports> {
  const wasmBytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: {},
  });
  return instance.exports as unknown as WasmExports;
}

/**
 * Wrap WASM exports into a CodecImpl for the benchmark harness.
 *
 * The protocol:
 *   1. resetScratch()
 *   2. allocScratch() regions for input/output buffers
 *   3. Copy JS typed arrays into WASM memory
 *   4. Call encode/decode
 *   5. Copy results back to JS typed arrays
 */
export function makeCodecImpl(wasm: WasmExports, runtime: string, name: string): CodecImpl {
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    runtime,
    name,

    encode(timestamps: BigInt64Array, values: Float64Array): Uint8Array {
      const n = timestamps.length;
      wasm.resetScratch();

      // Allocate input buffers in WASM memory.
      const tsPtr = wasm.allocScratch(n * 8); // i64 = 8 bytes
      const valPtr = wasm.allocScratch(n * 8); // f64 = 8 bytes
      const outCap = n * 20; // generous: worst case ~18 bytes/point
      const outPtr = wasm.allocScratch(outCap);

      // Copy timestamps (as raw i64 bytes, little-endian in WASM).
      const wasmMem = mem();
      const tsSrc = new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength);
      wasmMem.set(tsSrc, tsPtr);

      // Copy values.
      const valSrc = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
      wasmMem.set(valSrc, valPtr);

      // Encode.
      const bytesWritten = wasm.encodeChunk(tsPtr, valPtr, n, outPtr, outCap);

      // Copy result out.
      return new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytesWritten));
    },

    decode(buf: Uint8Array): { timestamps: BigInt64Array; values: Float64Array } {
      wasm.resetScratch();

      // Allocate input buffer.
      const inPtr = wasm.allocScratch(buf.length);
      mem().set(buf, inPtr);

      // Allocate output buffers — we read count from first 2 bytes of the chunk.
      const maxSamples = (buf[0]! << 8) | buf[1]!;
      const tsPtr = wasm.allocScratch(maxSamples * 8);
      const valPtr = wasm.allocScratch(maxSamples * 8);

      // Decode.
      const n = wasm.decodeChunk(inPtr, buf.length, tsPtr, valPtr, maxSamples);

      // Copy results out.
      const tsBytes = new Uint8Array(wasm.memory.buffer.slice(tsPtr, tsPtr + n * 8));
      const valBytes = new Uint8Array(wasm.memory.buffer.slice(valPtr, valPtr + n * 8));

      const timestamps = new BigInt64Array(tsBytes.buffer);
      const values = new Float64Array(valBytes.buffer);

      return { timestamps, values };
    },
  };
}

/**
 * Wrap WASM exports into a ValuesCodec for the ColumnStore.
 * Includes encodeValuesWithStats for fused compression + stats.
 */
export function makeValuesCodec(wasm: WasmExports): {
  encodeValues(values: Float64Array): Uint8Array;
  decodeValues(buf: Uint8Array): Float64Array;
  encodeValuesWithStats(values: Float64Array): {
    compressed: Uint8Array;
    stats: {
      minV: number;
      maxV: number;
      sum: number;
      count: number;
      firstV: number;
      lastV: number;
      sumOfSquares: number;
      resetCount: number;
    };
  };
} {
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    encodeValues(values: Float64Array): Uint8Array {
      const n = values.length;
      wasm.resetScratch();

      const valPtr = wasm.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);

      const wasmMem = mem();
      const valSrc = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
      wasmMem.set(valSrc, valPtr);

      const bytesWritten = wasm.encodeValues(valPtr, n, outPtr, outCap);
      return new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytesWritten));
    },

    decodeValues(buf: Uint8Array): Float64Array {
      wasm.resetScratch();

      const inPtr = wasm.allocScratch(buf.length);
      mem().set(buf, inPtr);

      const maxSamples = (buf[0]! << 8) | buf[1]!;
      const valPtr = wasm.allocScratch(maxSamples * 8);

      const n = wasm.decodeValues(inPtr, buf.length, valPtr, maxSamples);
      const valBytes = new Uint8Array(wasm.memory.buffer.slice(valPtr, valPtr + n * 8));
      return new Float64Array(valBytes.buffer);
    },

    encodeValuesWithStats(values: Float64Array) {
      const n = values.length;
      wasm.resetScratch();

      const valPtr = wasm.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);
      const statsPtr = wasm.allocScratch(8 * 8); // 8 f64s = 64 bytes

      const wasmMem = mem();
      wasmMem.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);

      const bytesWritten = wasm.encodeValuesWithStats(valPtr, n, outPtr, outCap, statsPtr);

      const compressed = new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytesWritten));
      const statsArr = new Float64Array(wasm.memory.buffer.slice(statsPtr, statsPtr + 64));

      return {
        compressed,
        stats: {
          minV: statsArr[0]!,
          maxV: statsArr[1]!,
          sum: statsArr[2]!,
          count: statsArr[3]!,
          firstV: statsArr[4]!,
          lastV: statsArr[5]!,
          sumOfSquares: statsArr[6]!,
          resetCount: statsArr[7]!,
        },
      };
    },
  };
}

/**
 * Wrap WASM exports into a TimestampCodec for the ColumnStore.
 * Delta-of-delta encoding for shared timestamp columns.
 */
export function makeTimestampCodec(wasm: WasmExports): {
  encodeTimestamps(timestamps: BigInt64Array): Uint8Array;
  decodeTimestamps(buf: Uint8Array): BigInt64Array;
} {
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    encodeTimestamps(timestamps: BigInt64Array): Uint8Array {
      const n = timestamps.length;
      wasm.resetScratch();

      const tsPtr = wasm.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);

      const wasmMem = mem();
      wasmMem.set(
        new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength),
        tsPtr
      );

      const bytesWritten = wasm.encodeTimestamps(tsPtr, n, outPtr, outCap);
      return new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytesWritten));
    },

    decodeTimestamps(buf: Uint8Array): BigInt64Array {
      wasm.resetScratch();

      const inPtr = wasm.allocScratch(buf.length);
      mem().set(buf, inPtr);

      const maxSamples = (buf[0]! << 8) | buf[1]!;
      const tsPtr = wasm.allocScratch(maxSamples * 8);

      const n = wasm.decodeTimestamps(inPtr, buf.length, tsPtr, maxSamples);
      const tsBytes = new Uint8Array(wasm.memory.buffer.slice(tsPtr, tsPtr + n * 8));
      return new BigInt64Array(tsBytes.buffer);
    },
  };
}

// ── ALP values codec ─────────────────────────────────────────────────

/** Stats shape returned by ALP and XOR encodeWithStats. */
interface BlockStats {
  minV: number;
  maxV: number;
  sum: number;
  count: number;
  firstV: number;
  lastV: number;
  sumOfSquares: number;
  resetCount: number;
}

function parseStats(wasm: WasmExports, statsPtr: number): BlockStats {
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

/**
 * Wrap WASM exports into an ALP ValuesCodec for the ColumnStore.
 * ALP (Adaptive Lossless floating-Point) — fixed-width bit-packing
 * that enables random access decode and range queries.
 */
export function makeALPValuesCodec(wasm: WasmExports): {
  encodeValues(values: Float64Array): Uint8Array;
  decodeValues(buf: Uint8Array): Float64Array;
  encodeValuesWithStats(values: Float64Array): { compressed: Uint8Array; stats: BlockStats };
  encodeBatchValuesWithStats(
    arrays: Float64Array[]
  ): Array<{ compressed: Uint8Array; stats: BlockStats }>;
  decodeBatchValues(blobs: Uint8Array[], chunkSize: number): Float64Array[];
} {
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    encodeValues(values: Float64Array): Uint8Array {
      const n = values.length;
      wasm.resetScratch();

      const valPtr = wasm.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = wasm.allocScratch(outCap);

      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);

      const bytesWritten = wasm.encodeValuesALP(valPtr, n, outPtr, outCap);
      return new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytesWritten));
    },

    decodeValues(buf: Uint8Array): Float64Array {
      wasm.resetScratch();

      const inPtr = wasm.allocScratch(buf.length);
      mem().set(buf, inPtr);

      const maxSamples = (buf[0]! << 8) | buf[1]!;
      const valPtr = wasm.allocScratch(maxSamples * 8);

      const n = wasm.decodeValuesALP(inPtr, buf.length, valPtr, maxSamples);
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

      const bytesWritten = wasm.encodeValuesALPWithStats(valPtr, n, outPtr, outCap, statsPtr);
      return {
        compressed: new Uint8Array(wasm.memory.buffer.slice(outPtr, outPtr + bytesWritten)),
        stats: parseStats(wasm, statsPtr),
      };
    },

    encodeBatchValuesWithStats(arrays: Float64Array[]) {
      const numArrays = arrays.length;
      if (numArrays === 0) return [];
      const chunkSize = arrays[0]?.length;
      for (let i = 1; i < numArrays; i++) {
        if (arrays[i]?.length !== chunkSize) {
          throw new RangeError("encodeBatchValuesWithStats requires equal-length arrays");
        }
      }
      wasm.resetScratch();

      // Copy all value arrays contiguously into WASM memory.
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

      const results: Array<{ compressed: Uint8Array; stats: BlockStats }> = [];
      const allStats = new Float64Array(
        wasm.memory.buffer.slice(statsPtr, statsPtr + numArrays * 64)
      );
      for (let i = 0; i < numArrays; i++) {
        const compressed = new Uint8Array(
          wasm.memory.buffer.slice(outPtr + offsets[i]!, outPtr + offsets[i]! + sizes[i]!)
        );
        const si = i * 8;
        results.push({
          compressed,
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

      // Concatenate all blobs contiguously and build offset/size arrays.
      let totalBytes = 0;
      for (const b of blobs) totalBytes += b.length;

      const blobsPtr = wasm.allocScratch(totalBytes);
      const offsetsPtr = wasm.allocScratch(numBlobs * 4);
      const sizesPtr = wasm.allocScratch(numBlobs * 4);

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
}

// ── ALP range-decode codec ───────────────────────────────────────────

/**
 * Wrap WASM rangeDecodeALP into a RangeDecodeCodec for the ColumnStore.
 * Fused decode + binary search in WASM — decodes only the samples
 * within [startT, endT] without materializing the full chunk.
 */
export function makeALPRangeCodec(wasm: WasmExports): {
  rangeDecodeValues(
    compressedTimestamps: Uint8Array,
    compressedValues: Uint8Array,
    startT: bigint,
    endT: bigint
  ): { timestamps: BigInt64Array; values: Float64Array };
} {
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    rangeDecodeValues(
      compressedTimestamps: Uint8Array,
      compressedValues: Uint8Array,
      startT: bigint,
      endT: bigint
    ) {
      wasm.resetScratch();

      const tsInPtr = wasm.allocScratch(compressedTimestamps.length);
      mem().set(compressedTimestamps, tsInPtr);

      const valInPtr = wasm.allocScratch(compressedValues.length);
      mem().set(compressedValues, valInPtr);

      const maxSamples = (compressedValues[0]! << 8) | compressedValues[1]!;
      const outTsPtr = wasm.allocScratch(maxSamples * 8);
      const outValPtr = wasm.allocScratch(maxSamples * 8);

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
}
