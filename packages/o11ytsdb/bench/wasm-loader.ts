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

import { readFileSync } from 'node:fs';
import type { CodecImpl } from './codec.bench.js';

export interface WasmExports {
  memory: WebAssembly.Memory;
  encodeChunk: (ts_ptr: number, val_ptr: number, count: number, out_ptr: number, out_cap: number) => number;
  decodeChunk: (in_ptr: number, in_len: number, ts_ptr: number, val_ptr: number, max_samples: number) => number;
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
export function makeCodecImpl(
  wasm: WasmExports,
  runtime: string,
  name: string,
): CodecImpl {
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    runtime,
    name,

    encode(timestamps: BigInt64Array, values: Float64Array): Uint8Array {
      const n = timestamps.length;
      wasm.resetScratch();

      // Allocate input buffers in WASM memory.
      const tsPtr = wasm.allocScratch(n * 8);   // i64 = 8 bytes
      const valPtr = wasm.allocScratch(n * 8);   // f64 = 8 bytes
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
