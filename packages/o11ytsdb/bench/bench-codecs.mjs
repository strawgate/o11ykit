/**
 * Shared WASM codec loader for benchmarks.
 *
 * Centralizes all WASM codec construction so benchmarks can import a single
 * module instead of duplicating ~150 lines of setup each.
 *
 * Usage:
 *   import { loadBenchCodecs } from './bench-codecs.mjs';
 *   const codecs = await loadBenchCodecs();
 *   // codecs.alpValuesCodec, codecs.tsCodec, codecs.alpRangeCodec,
 *   // codecs.stepAggCodec, codecs.valuesCodec, codecs.fullCodec
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// ── Step-aggregate function IDs (must match Rust enum) ───────────────

const AGG_FN_ID = { min: 0, max: 1, sum: 2, count: 3, last: 4, avg: 5 };

// ── Main loader ──────────────────────────────────────────────────────

/**
 * Load the WASM binary and return all codec objects.
 *
 * Returns: { alpValuesCodec, tsCodec, alpRangeCodec, stepAggCodec,
 *            valuesCodec, fullCodec }
 *
 * - alpValuesCodec: ALP encode/decode for values (primary codec)
 * - tsCodec: delta-of-delta timestamp codec
 * - alpRangeCodec: fused range-decode (timestamps + ALP values with time filter)
 * - stepAggCodec: fused decode+aggregate in WASM (for ColumnStore stepAggCodec param)
 * - valuesCodec: XOR-delta encode/decode for values (legacy, used by smoke/profile)
 * - fullCodec: chunk-level XOR encode/decode (timestamps+values, used by profile)
 */
export async function loadBenchCodecs() {
  const wasmPath = join(pkgDir, "wasm/o11ytsdb-rust.wasm");
  const wasmBytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
  const w = instance.exports;
  const mem = () => new Uint8Array(w.memory.buffer);

  // ── ALP values codec (primary) ───────────────────────────────────

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

  // ── Timestamp codec ──────────────────────────────────────────────

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

  // ── ALP range-decode codec (fused time-filtered decode) ──────────

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

  // ── Step-aggregate codec (fused decode+aggregate in WASM) ────────

  const stepAggCodec = {
    aggregateChunk(compressedTimestamps, compressedValues, aggFn, minT, step, values, counts) {
      const fnId = AGG_FN_ID[aggFn];
      if (fnId === undefined) return 0;
      const bucketCount = values.length;
      w.resetScratch();

      const tsInPtr = w.allocScratch(compressedTimestamps.length);
      mem().set(compressedTimestamps, tsInPtr);
      const valInPtr = w.allocScratch(compressedValues.length);
      mem().set(compressedValues, valInPtr);

      const valsPtr = w.allocScratch(bucketCount * 8);
      const cntsPtr = w.allocScratch(bucketCount * 8);
      const wasmMem = mem();
      wasmMem.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valsPtr);
      wasmMem.set(new Uint8Array(counts.buffer, counts.byteOffset, counts.byteLength), cntsPtr);

      const n = w.stepAggregateChunkALP(
        tsInPtr, compressedTimestamps.length, valInPtr, compressedValues.length,
        fnId, minT, step, valsPtr, cntsPtr, bucketCount,
      );

      values.set(new Float64Array(w.memory.buffer.slice(valsPtr, valsPtr + bucketCount * 8)));
      counts.set(new Float64Array(w.memory.buffer.slice(cntsPtr, cntsPtr + bucketCount * 8)));
      return n;
    },
  };

  // ── XOR values codec (legacy, for smoke/profile comparisons) ─────

  const valuesCodec = {
    name: "rust-wasm",
    encodeValues(values) {
      const n = values.length;
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + w.encodeValues(valPtr, n, outPtr, outCap)));
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
      w.encodeBatchValuesWithStats(valsPtr, chunkSize, numArrays, outPtr, outCap, offsetsPtr, sizesPtr, statsPtr);
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

  // ── Full chunk XOR codec (legacy, for profile comparisons) ───────

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
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + w.encodeChunk(tsPtr, valPtr, n, outPtr, outCap)));
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

  return { alpValuesCodec, tsCodec, alpRangeCodec, stepAggCodec, valuesCodec, fullCodec };
}

/** Resolve the package root (for dynamic imports of dist/). */
export const PKG_DIR = pkgDir;
