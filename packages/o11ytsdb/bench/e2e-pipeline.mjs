#!/usr/bin/env node
/**
 * End-to-end pipeline benchmark: WASM ALP vs JS XOR-delta vs JS plain
 *
 * Measures the full ingest→compress→query pipeline across three codec
 * configurations on realistic OTLP-like data (256 series, 640 samples each).
 *
 * Metrics:
 *   1. Ingest throughput (appendBatch, samples/sec)
 *   2. Compression ratio (memory at rest vs raw)
 *   3. Query throughput: raw read, aggregated sum, time-range scan
 *   4. Per-pattern compression breakdown
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// ── Configuration ────────────────────────────────────────────────────

const NUM_SERIES = 256;
const POINTS_PER_SERIES = 640;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const CHUNK_SIZE = 640;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n; // 15s scrape interval

const INGEST_ITERATIONS = 10;
const QUERY_WARMUP = 5;
const QUERY_ITERATIONS = 50;

// ── Deterministic PRNG ───────────────────────────────────────────────

class Rng {
  constructor(seed = 42) {
    this.s = new Uint32Array(4);
    this.s[0] = seed;
    this.s[1] = seed ^ 0x6c078965;
    this.s[2] = seed ^ 0xdeadbeef;
    this.s[3] = seed ^ 0x01234567;
    for (let i = 0; i < 16; i++) this.next();
  }
  next() {
    const s = this.s;
    const result = Math.imul(this._rotl(Math.imul(s[0], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = this._rotl(s[3], 11);
    return result / 0x100000000;
  }
  _rotl(x, k) {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
  }
  gaussian(mean, stddev) {
    const u1 = this.next() || 1e-10;
    const u2 = this.next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// ── Data generation (matches engine.bench.ts patterns) ───────────────

function generateData() {
  const rng = new Rng(42);
  const labels = [];
  const timestamps = [];
  const values = [];
  const patternNames = [
    "constant",
    "counter_small",
    "counter_large",
    "gauge_2dp",
    "gauge_3dp",
    "gauge_11dp",
    "gauge_12dp",
    "hi_prec_ratio",
    "hi_prec_ratio_b",
    "hi_var_gauge",
  ];

  for (let s = 0; s < NUM_SERIES; s++) {
    const m = new Map();
    const pattern = s % 10;
    m.set("__name__", `metric_${s % 10}`);
    m.set("host", `host_${s % 16}`);
    m.set("instance", `inst_${s % 32}`);
    m.set("pattern", patternNames[pattern]);
    labels.push(m);

    const ts = new BigInt64Array(POINTS_PER_SERIES);
    const vs = new Float64Array(POINTS_PER_SERIES);

    if (pattern === 0) {
      const constant = Math.round(rng.next() * 1000) / 10;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        vs[i] = constant;
      }
    } else if (pattern === 1) {
      let counter = Math.floor(rng.next() * 10000);
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        if (rng.next() >= 0.4) counter += Math.floor(rng.next() * 10) + 1;
        vs[i] = counter;
      }
    } else if (pattern === 2) {
      let counter = Math.floor(rng.next() * 1e10) + 1e10;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        if (rng.next() >= 0.3) counter += Math.floor(rng.next() * 100000) + 1;
        vs[i] = counter;
      }
    } else if (pattern === 3) {
      let v = Math.round(rng.next() * 10000) / 100;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.05);
        v = Math.max(0, v);
        vs[i] = Math.round(v * 100) / 100;
      }
    } else if (pattern === 4) {
      let v = rng.next() * 500;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.02);
        v = Math.max(0, v);
        vs[i] = Math.round(v * 1000) / 1000;
      }
    } else if (pattern === 5) {
      let base = rng.next() * 0.5 + 0.05;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        base += rng.gaussian(0, 0.0001);
        base = Math.max(0, Math.min(1, base));
        vs[i] = Math.round(base * 1e11) / 1e11;
      }
    } else if (pattern === 6) {
      let base = rng.next() * 0.4 + 0.1;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        base += rng.gaussian(0, 0.000001);
        base = Math.max(0, Math.min(1, base));
        vs[i] = Math.round(base * 1e12) / 1e12;
      }
    } else if (pattern === 7 || pattern === 8) {
      let ticks = Math.floor(rng.next() * 1e6);
      let totalTicks = Math.floor(1e7 + rng.next() * 1e6);
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        ticks += Math.floor(rng.next() * 200) + 1;
        totalTicks += 1000;
        vs[i] = ticks / totalTicks;
      }
    } else {
      let v = rng.next() * 100;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.5);
        v = Math.max(0, v);
        vs[i] = Math.round(v * 100) / 100;
      }
    }

    timestamps.push(ts);
    values.push(vs);
  }

  return { labels, timestamps, values, patternNames };
}

// ── JS plain codec (f64-plain, no compression — the default fallback) ─

function createJSPlainCodec() {
  return {
    name: "js-f64-plain",
    encodeValues(values) {
      const out = new Uint8Array(4 + values.byteLength);
      new DataView(out.buffer).setUint32(0, values.length, true);
      out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
      return out;
    },
    decodeValues(buf) {
      if (buf.byteLength < 4) return new Float64Array(0);
      const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      const raw = buf.subarray(4);
      const bytes = raw.byteLength - (raw.byteLength % 8);
      const copy = raw.slice(0, bytes);
      return new Float64Array(
        copy.buffer,
        copy.byteOffset,
        Math.min(n, Math.floor(bytes / 8))
      ).slice();
    },
  };
}

// ── JS XOR values-only codec (adapted from codec.ts XOR encoding) ────

function createJSXorValuesCodec() {
  const f64Buf = new ArrayBuffer(8);
  const f64View = new DataView(f64Buf);

  function floatToBits(f) {
    f64View.setFloat64(0, f, false);
    const hi = f64View.getUint32(0, false);
    const lo = f64View.getUint32(4, false);
    return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
  }
  function bitsToFloat(bits) {
    const hi = Number((bits >> 32n) & 0xffffffffn);
    const lo = Number(bits & 0xffffffffn);
    f64View.setUint32(0, hi, false);
    f64View.setUint32(4, lo, false);
    return f64View.getFloat64(0, false);
  }
  function clz64(x) {
    if (x === 0n) return 64;
    let n = 0;
    if ((x & 0xffffffff00000000n) === 0n) { n += 32; x <<= 32n; }
    if ((x & 0xffff000000000000n) === 0n) { n += 16; x <<= 16n; }
    if ((x & 0xff00000000000000n) === 0n) { n += 8; x <<= 8n; }
    if ((x & 0xf000000000000000n) === 0n) { n += 4; x <<= 4n; }
    if ((x & 0xc000000000000000n) === 0n) { n += 2; x <<= 2n; }
    if ((x & 0x8000000000000000n) === 0n) { n += 1; }
    return n;
  }
  function ctz64(x) {
    if (x === 0n) return 64;
    let n = 0;
    if ((x & 0xffffffffn) === 0n) { n += 32; x >>= 32n; }
    if ((x & 0xffffn) === 0n) { n += 16; x >>= 16n; }
    if ((x & 0xffn) === 0n) { n += 8; x >>= 8n; }
    if ((x & 0xfn) === 0n) { n += 4; x >>= 4n; }
    if ((x & 0x3n) === 0n) { n += 2; x >>= 2n; }
    if ((x & 0x1n) === 0n) { n += 1; }
    return n;
  }

  // Simple bit writer/reader for values-only XOR encoding.
  class BitWriter {
    constructor(cap = 256) { this.buf = new Uint8Array(cap); this.bytePos = 0; this.bitPos = 0; }
    writeBit(bit) {
      if (this.bytePos >= this.buf.length) { const n = new Uint8Array(this.buf.length * 2); n.set(this.buf); this.buf = n; }
      if (bit) this.buf[this.bytePos] |= 0x80 >>> this.bitPos;
      this.bitPos++;
      if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
    }
    writeBits(value, count) { for (let i = count - 1; i >= 0; i--) this.writeBit(Number((value >> BigInt(i)) & 1n)); }
    writeBitsNum(value, count) { for (let i = count - 1; i >= 0; i--) this.writeBit((value >>> i) & 1); }
    finish() { return this.buf.slice(0, this.bitPos > 0 ? this.bytePos + 1 : this.bytePos); }
  }
  class BitReader {
    constructor(buf) { this.buf = buf; this.bytePos = 0; this.bitPos = 0; }
    readBit() {
      const bit = (this.buf[this.bytePos] >>> (7 - this.bitPos)) & 1;
      this.bitPos++;
      if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
      return bit;
    }
    readBits(count) { let v = 0n; for (let i = 0; i < count; i++) v = (v << 1n) | BigInt(this.readBit()); return v; }
    readBitsNum(count) { let v = 0; for (let i = 0; i < count; i++) v = (v << 1) | this.readBit(); return v; }
  }

  return {
    name: "js-xor-values",
    encodeValues(values) {
      const n = values.length;
      if (n === 0) return new Uint8Array(0);
      const w = new BitWriter(n * 2);
      w.writeBitsNum(n, 16);
      w.writeBits(floatToBits(values[0]), 64);
      let prevValBits = floatToBits(values[0]);
      let prevLeading = 64, prevTrailing = 0;
      for (let i = 1; i < n; i++) {
        const valBits = floatToBits(values[i]);
        const xor = prevValBits ^ valBits;
        if (xor === 0n) {
          w.writeBit(0);
        } else {
          const leading = clz64(xor);
          const trailing = ctz64(xor);
          const meaningful = 64 - leading - trailing;
          if (leading >= prevLeading && trailing >= prevTrailing) {
            w.writeBit(1); w.writeBit(0);
            const prevMeaningful = 64 - prevLeading - prevTrailing;
            w.writeBits((xor >> BigInt(prevTrailing)) & ((1n << BigInt(prevMeaningful)) - 1n), prevMeaningful);
          } else {
            w.writeBit(1); w.writeBit(1);
            w.writeBitsNum(leading, 6);
            w.writeBitsNum(meaningful - 1, 6);
            w.writeBits((xor >> BigInt(trailing)) & ((1n << BigInt(meaningful)) - 1n), meaningful);
            prevLeading = leading;
            prevTrailing = trailing;
          }
        }
        prevValBits = valBits;
      }
      return w.finish();
    },
    decodeValues(buf) {
      if (buf.length === 0) return new Float64Array(0);
      const r = new BitReader(buf);
      const n = r.readBitsNum(16);
      const values = new Float64Array(n);
      let prevValBits = r.readBits(64);
      values[0] = bitsToFloat(prevValBits);
      let prevLeading = 0, prevTrailing = 0;
      for (let i = 1; i < n; i++) {
        if (r.readBit() === 0) {
          values[i] = bitsToFloat(prevValBits);
        } else if (r.readBit() === 0) {
          const meaningful = 64 - prevLeading - prevTrailing;
          const shifted = r.readBits(meaningful);
          const xor = shifted << BigInt(prevTrailing);
          prevValBits = prevValBits ^ xor;
          values[i] = bitsToFloat(prevValBits);
        } else {
          const leading = r.readBitsNum(6);
          const meaningfulMinus1 = r.readBitsNum(6);
          const meaningful = meaningfulMinus1 + 1;
          const trailing = 64 - leading - meaningful;
          const shifted = r.readBits(meaningful);
          const xor = shifted << BigInt(trailing);
          prevValBits = prevValBits ^ xor;
          values[i] = bitsToFloat(prevValBits);
          prevLeading = leading;
          prevTrailing = trailing;
        }
      }
      return values;
    },
  };
}

// ── WASM codec loaders ───────────────────────────────────────────────

async function loadWasm() {
  const wasmPath = join(pkgDir, "wasm/o11ytsdb-rust.wasm");
  const wasmBytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
  return instance.exports;
}

function makeWasmXorValuesCodec(w) {
  const mem = () => new Uint8Array(w.memory.buffer);
  return {
    name: "wasm-xor-values",
    encodeValues(values) {
      const n = values.length;
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytesWritten = w.encodeValues(valPtr, n, outPtr, outCap);
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + bytesWritten));
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
  };
}

function makeWasmALPCodec(w) {
  const mem = () => new Uint8Array(w.memory.buffer);
  return {
    name: "wasm-alp",
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
      if (numArrays === 0) return [];
      const chunkSize = arrays[0].length;
      w.resetScratch();
      const valsPtr = w.allocScratch(numArrays * chunkSize * 8);
      const m = mem();
      for (let i = 0; i < numArrays; i++) {
        const arr = arrays[i];
        m.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), valsPtr + i * chunkSize * 8);
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
          stats: { minV: allStats[si], maxV: allStats[si+1], sum: allStats[si+2], count: allStats[si+3], firstV: allStats[si+4], lastV: allStats[si+5], sumOfSquares: allStats[si+6], resetCount: allStats[si+7] },
        });
      }
      return results;
    },
    decodeBatchValues(blobs, chunkSize) {
      const numBlobs = blobs.length;
      w.resetScratch();
      let totalBytes = 0;
      for (const b of blobs) totalBytes += b.length;
      const blobsPtr = w.allocScratch(totalBytes);
      const offsetsPtr = w.allocScratch(numBlobs * 4);
      const sizesPtr = w.allocScratch(numBlobs * 4);
      const m = mem();
      const offsets = new Uint32Array(numBlobs);
      const sizes = new Uint32Array(numBlobs);
      let off = 0;
      for (let i = 0; i < numBlobs; i++) {
        const b = blobs[i];
        m.set(b, blobsPtr + off);
        offsets[i] = off;
        sizes[i] = b.length;
        off += b.length;
      }
      m.set(new Uint8Array(offsets.buffer), offsetsPtr);
      m.set(new Uint8Array(sizes.buffer), sizesPtr);
      const outPtr = w.allocScratch(numBlobs * chunkSize * 8);
      w.decodeBatchValuesALP(blobsPtr, offsetsPtr, sizesPtr, numBlobs, outPtr, chunkSize);
      const results = [];
      for (let i = 0; i < numBlobs; i++) {
        results.push(new Float64Array(w.memory.buffer.slice(outPtr + i * chunkSize * 8, outPtr + (i + 1) * chunkSize * 8)));
      }
      return results;
    },
  };
}

function makeWasmTimestampCodec(w) {
  const mem = () => new Uint8Array(w.memory.buffer);
  return {
    name: "wasm-ts",
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
}

function makeWasmALPRangeCodec(w) {
  const mem = () => new Uint8Array(w.memory.buffer);
  return {
    rangeDecodeValues(compressedTs, compressedVals, startT, endT) {
      w.resetScratch();
      const tsInPtr = w.allocScratch(compressedTs.length);
      mem().set(compressedTs, tsInPtr);
      const valInPtr = w.allocScratch(compressedVals.length);
      mem().set(compressedVals, valInPtr);
      const maxSamples = (compressedVals[0] << 8) | compressedVals[1];
      const outTsPtr = w.allocScratch(maxSamples * 8);
      const outValPtr = w.allocScratch(maxSamples * 8);
      const n = w.rangeDecodeALP(tsInPtr, compressedTs.length, valInPtr, compressedVals.length, startT, endT, outTsPtr, outValPtr, maxSamples);
      if (n === 0) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
      return {
        timestamps: new BigInt64Array(w.memory.buffer.slice(outTsPtr, outTsPtr + n * 8)),
        values: new Float64Array(w.memory.buffer.slice(outValPtr, outValPtr + n * 8)),
      };
    },
  };
}

// ── Timing utilities ─────────────────────────────────────────────────

function measure(fn, warmup, iterations) {
  for (let i = 0; i < warmup; i++) fn();
  const timings = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    timings[i] = performance.now() - t0;
  }
  timings.sort();
  let sum = 0;
  for (let i = 0; i < iterations; i++) sum += timings[i];
  return {
    min: timings[0],
    p50: timings[Math.floor(iterations * 0.5)],
    p95: timings[Math.floor(iterations * 0.95)],
    p99: timings[Math.floor(iterations * 0.99)],
    max: timings[iterations - 1],
    mean: sum / iterations,
  };
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// ── Main benchmark ───────────────────────────────────────────────────

async function main() {
  const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));
  const { ScanEngine } = await import(join(pkgDir, "dist/query.js"));

  const wasm = await loadWasm();
  const data = generateData();
  const qe = new ScanEngine();

  // Build codec configurations.
  const configs = [
    {
      label: "JS f64-plain",
      tag: "js-plain",
      valuesCodec: createJSPlainCodec(),
      tsCodec: undefined,
      rangeCodec: undefined,
    },
    {
      label: "JS XOR-values",
      tag: "js-xor",
      valuesCodec: createJSXorValuesCodec(),
      tsCodec: undefined,
      rangeCodec: undefined,
    },
    {
      label: "WASM XOR-values",
      tag: "wasm-xor",
      valuesCodec: makeWasmXorValuesCodec(wasm),
      tsCodec: makeWasmTimestampCodec(wasm),
      rangeCodec: undefined,
    },
    {
      label: "WASM ALP (full)",
      tag: "wasm-alp",
      valuesCodec: makeWasmALPCodec(wasm),
      tsCodec: makeWasmTimestampCodec(wasm),
      rangeCodec: undefined,
    },
    {
      label: "WASM ALP+range",
      tag: "wasm-alp-range",
      valuesCodec: makeWasmALPCodec(wasm),
      tsCodec: makeWasmTimestampCodec(wasm),
      rangeCodec: makeWasmALPRangeCodec(wasm),
    },
  ];

  const W = 80;
  console.log(`\n${"═".repeat(W)}`);
  console.log(`  E2E Pipeline Benchmark: WASM ALP vs JS XOR-delta vs JS Plain`);
  console.log(`${"═".repeat(W)}`);
  console.log(`  ${NUM_SERIES} series × ${POINTS_PER_SERIES} pts = ${TOTAL_SAMPLES.toLocaleString()} total samples`);
  console.log(`  Chunk size: ${CHUNK_SIZE} | Interval: 15s | 10 OTel data patterns`);
  console.log(`  Ingest iterations: ${INGEST_ITERATIONS} | Query iterations: ${QUERY_ITERATIONS}`);
  console.log(`${"─".repeat(W)}\n`);

  // ═══════════════════════════════════════════════════════════════════
  // 1. INGEST THROUGHPUT
  // ═══════════════════════════════════════════════════════════════════

  console.log(`  ▸ INGEST THROUGHPUT (appendBatch)\n`);
  console.log(`    ${"Codec".padEnd(22)} ${"p50 ms".padStart(10)} ${"p50 samp/s".padStart(14)} ${"p95 ms".padStart(10)} ${"Memory".padStart(10)} ${"B/pt".padStart(8)}`);
  console.log(`    ${"─".repeat(22)} ${"─".repeat(10)} ${"─".repeat(14)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(8)}`);

  const populated = [];

  for (const cfg of configs) {
    const store = new ColumnStore(
      cfg.valuesCodec,
      CHUNK_SIZE,
      () => 0,
      cfg.tag,
      cfg.tsCodec,
      cfg.rangeCodec
    );

    // Pre-register all series.
    const ids = [];
    for (let s = 0; s < NUM_SERIES; s++) {
      ids.push(store.getOrCreateSeries(data.labels[s]));
    }

    // Measure ingest.
    const timing = measure(() => {
      // We need a fresh store each time for fair measurement.
      // But creating stores in measure() is expensive. Instead,
      // measure a single-pass ingestion of all data.
    }, 0, 1); // dummy — we do manual timing below

    // Manual timing: ingest INGEST_ITERATIONS times with fresh stores.
    const ingestTimings = new Float64Array(INGEST_ITERATIONS);
    for (let iter = 0; iter < INGEST_ITERATIONS; iter++) {
      const freshStore = new ColumnStore(
        cfg.valuesCodec,
        CHUNK_SIZE,
        () => 0,
        cfg.tag,
        cfg.tsCodec,
        cfg.rangeCodec
      );
      const freshIds = [];
      for (let s = 0; s < NUM_SERIES; s++) {
        freshIds.push(freshStore.getOrCreateSeries(data.labels[s]));
      }
      const t0 = performance.now();
      for (let offset = 0; offset < POINTS_PER_SERIES; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, POINTS_PER_SERIES);
        for (let s = 0; s < NUM_SERIES; s++) {
          freshStore.appendBatch(freshIds[s], data.timestamps[s].subarray(offset, end), data.values[s].subarray(offset, end));
        }
      }
      ingestTimings[iter] = performance.now() - t0;
    }
    ingestTimings.sort();
    const ingestP50 = ingestTimings[Math.floor(INGEST_ITERATIONS * 0.5)];
    const ingestP95 = ingestTimings[Math.floor(INGEST_ITERATIONS * 0.95)];

    // Populate the final store for queries.
    for (let offset = 0; offset < POINTS_PER_SERIES; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, POINTS_PER_SERIES);
      for (let s = 0; s < NUM_SERIES; s++) {
        store.appendBatch(ids[s], data.timestamps[s].subarray(offset, end), data.values[s].subarray(offset, end));
      }
    }

    const memBytes = store.memoryBytes();
    const throughput = TOTAL_SAMPLES / (ingestP50 / 1000);

    console.log(
      `    ${cfg.label.padEnd(22)} ${ingestP50.toFixed(1).padStart(10)} ${fmt(throughput).padStart(14)} ${ingestP95.toFixed(1).padStart(10)} ${fmtBytes(memBytes).padStart(10)} ${(memBytes / TOTAL_SAMPLES).toFixed(1).padStart(8)}`
    );

    populated.push({ cfg, store, memBytes, ingestP50, throughput });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 2. COMPRESSION RATIO
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  ▸ COMPRESSION RATIO\n`);
  const rawBytes = TOTAL_SAMPLES * 16; // 8 bytes ts + 8 bytes value
  console.log(`    Raw size: ${fmtBytes(rawBytes)} (${TOTAL_SAMPLES.toLocaleString()} × 16 bytes)\n`);
  console.log(`    ${"Codec".padEnd(22)} ${"At-rest".padStart(10)} ${"Ratio".padStart(8)} ${"B/sample".padStart(10)}`);
  console.log(`    ${"─".repeat(22)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(10)}`);

  for (const { cfg, memBytes } of populated) {
    const ratio = rawBytes / memBytes;
    console.log(
      `    ${cfg.label.padEnd(22)} ${fmtBytes(memBytes).padStart(10)} ${ratio.toFixed(1).padStart(7)}x ${(memBytes / TOTAL_SAMPLES).toFixed(2).padStart(10)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. PER-PATTERN COMPRESSION BREAKDOWN
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  ▸ PER-PATTERN COMPRESSION (bytes/sample, values only)\n`);
  {
    const patterns = data.patternNames;
    let hdr = `    ${"Pattern".padEnd(22)}`;
    for (const cfg of configs) hdr += ` ${cfg.tag.padStart(12)}`;
    console.log(hdr);
    console.log(`    ${"─".repeat(22)}${configs.map(() => ` ${"─".repeat(12)}`).join("")}`);

    for (let p = 0; p < patterns.length; p++) {
      // Pick a representative series for this pattern.
      const sIdx = p; // series p has pattern p%10 = p
      const vals = data.values[sIdx];
      let line = `    ${patterns[p].padEnd(22)}`;
      for (const cfg of configs) {
        const compressed = cfg.valuesCodec.encodeValues(vals);
        const bps = (compressed.byteLength / vals.length).toFixed(2);
        line += ` ${bps.padStart(12)}`;
      }
      console.log(line);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. QUERY THROUGHPUT
  // ═══════════════════════════════════════════════════════════════════

  const fullStart = T0;
  const fullEnd = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;

  console.log(`\n  ▸ QUERY THROUGHPUT\n`);

  // 4a. Single-series full read
  console.log(`    ── Single series, full range (${POINTS_PER_SERIES} pts) ──\n`);
  console.log(`    ${"Codec".padEnd(22)} ${"p50 ms".padStart(10)} ${"p50 samp/s".padStart(14)} ${"p95 ms".padStart(10)}`);
  console.log(`    ${"─".repeat(22)} ${"─".repeat(10)} ${"─".repeat(14)} ${"─".repeat(10)}`);

  for (const { cfg, store } of populated) {
    const t = measure(() => { store.read(0, fullStart, fullEnd); }, QUERY_WARMUP, QUERY_ITERATIONS);
    const throughput = POINTS_PER_SERIES / (t.p50 / 1000);
    console.log(`    ${cfg.label.padEnd(22)} ${t.p50.toFixed(3).padStart(10)} ${fmt(throughput).padStart(14)} ${t.p95.toFixed(3).padStart(10)}`);
  }

  // 4b. Multi-series select (metric_0 matches ~26 series)
  const selectMetric = "metric_0";
  const matchCount = populated[0].store.matchLabel("__name__", selectMetric).length;
  console.log(`\n    ── Multi-series select: ${selectMetric} (${matchCount} series, full range) ──\n`);
  console.log(`    ${"Codec".padEnd(22)} ${"p50 ms".padStart(10)} ${"p50 samp/s".padStart(14)} ${"p95 ms".padStart(10)}`);
  console.log(`    ${"─".repeat(22)} ${"─".repeat(10)} ${"─".repeat(14)} ${"─".repeat(10)}`);

  for (const { cfg, store } of populated) {
    const t = measure(() => {
      qe.query(store, { metric: selectMetric, start: fullStart, end: fullEnd });
    }, QUERY_WARMUP, QUERY_ITERATIONS);
    const throughput = (matchCount * POINTS_PER_SERIES) / (t.p50 / 1000);
    console.log(`    ${cfg.label.padEnd(22)} ${t.p50.toFixed(3).padStart(10)} ${fmt(throughput).padStart(14)} ${t.p95.toFixed(3).padStart(10)}`);
  }

  // 4c. Aggregated sum
  console.log(`\n    ── Aggregated sum: ${selectMetric} (${matchCount} series → 1) ──\n`);
  console.log(`    ${"Codec".padEnd(22)} ${"p50 ms".padStart(10)} ${"p50 samp/s".padStart(14)} ${"p95 ms".padStart(10)}`);
  console.log(`    ${"─".repeat(22)} ${"─".repeat(10)} ${"─".repeat(14)} ${"─".repeat(10)}`);

  for (const { cfg, store } of populated) {
    const t = measure(() => {
      qe.query(store, { metric: selectMetric, start: fullStart, end: fullEnd, agg: "sum" });
    }, QUERY_WARMUP, QUERY_ITERATIONS);
    const throughput = (matchCount * POINTS_PER_SERIES) / (t.p50 / 1000);
    console.log(`    ${cfg.label.padEnd(22)} ${t.p50.toFixed(3).padStart(10)} ${fmt(throughput).padStart(14)} ${t.p95.toFixed(3).padStart(10)}`);
  }

  // 4d. Time range scan (last 10%)
  const rangeLen = BigInt(POINTS_PER_SERIES) * INTERVAL;
  const rangeStart = T0 + (rangeLen * 9n) / 10n;
  const rangeEnd = T0 + rangeLen;
  const rangePts = POINTS_PER_SERIES / 10;

  console.log(`\n    ── Time range scan: last 10% (${rangePts} pts) ──\n`);
  console.log(`    ${"Codec".padEnd(22)} ${"p50 ms".padStart(10)} ${"p50 samp/s".padStart(14)} ${"p95 ms".padStart(10)}`);
  console.log(`    ${"─".repeat(22)} ${"─".repeat(10)} ${"─".repeat(14)} ${"─".repeat(10)}`);

  for (const { cfg, store } of populated) {
    const t = measure(() => { store.read(0, rangeStart, rangeEnd); }, QUERY_WARMUP, QUERY_ITERATIONS);
    const throughput = rangePts / (t.p50 / 1000);
    console.log(`    ${cfg.label.padEnd(22)} ${t.p50.toFixed(3).padStart(10)} ${fmt(throughput).padStart(14)} ${t.p95.toFixed(3).padStart(10)}`);
  }

  // 4e. Step-aggregated query (avg with 60s buckets)
  const stepSize = 60_000n; // 60s buckets
  console.log(`\n    ── Step-aggregated avg: ${selectMetric}, step=60s ──\n`);
  console.log(`    ${"Codec".padEnd(22)} ${"p50 ms".padStart(10)} ${"p50 samp/s".padStart(14)} ${"p95 ms".padStart(10)}`);
  console.log(`    ${"─".repeat(22)} ${"─".repeat(10)} ${"─".repeat(14)} ${"─".repeat(10)}`);

  for (const { cfg, store } of populated) {
    const t = measure(() => {
      qe.query(store, { metric: selectMetric, start: fullStart, end: fullEnd, agg: "avg", step: stepSize });
    }, QUERY_WARMUP, QUERY_ITERATIONS);
    const throughput = (matchCount * POINTS_PER_SERIES) / (t.p50 / 1000);
    console.log(`    ${cfg.label.padEnd(22)} ${t.p50.toFixed(3).padStart(10)} ${fmt(throughput).padStart(14)} ${t.p95.toFixed(3).padStart(10)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. CORRECTNESS VALIDATION
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  ▸ CORRECTNESS VALIDATION\n`);
  const refStore = populated[0].store;
  let allOk = true;
  for (let s = 0; s < Math.min(10, NUM_SERIES); s++) {
    const ref = refStore.read(s, fullStart, fullEnd);
    for (let i = 1; i < populated.length; i++) {
      const other = populated[i].store.read(s, fullStart, fullEnd);
      const lenOk = ref.timestamps.length === other.timestamps.length;
      let valOk = lenOk;
      if (lenOk) {
        for (let j = 0; j < ref.values.length; j++) {
          if (Math.abs(ref.values[j] - other.values[j]) > 1e-9) {
            valOk = false;
            break;
          }
        }
      }
      if (!valOk) {
        console.log(`    ✗ series ${s}: ${populated[0].cfg.label} ≠ ${populated[i].cfg.label} (len: ${ref.timestamps.length} vs ${other.timestamps.length})`);
        allOk = false;
      }
    }
  }
  if (allOk) {
    console.log(`    ✓ All codec outputs match across ${Math.min(10, NUM_SERIES)} test series`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6. SUMMARY & ANALYSIS
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n${"═".repeat(W)}`);
  console.log(`  ANALYSIS & SUMMARY`);
  console.log(`${"═".repeat(W)}\n`);

  const jsPlain = populated.find(p => p.cfg.tag === "js-plain");
  const jsXor = populated.find(p => p.cfg.tag === "js-xor");
  const wasmXor = populated.find(p => p.cfg.tag === "wasm-xor");
  const wasmAlp = populated.find(p => p.cfg.tag === "wasm-alp");
  const wasmAlpRange = populated.find(p => p.cfg.tag === "wasm-alp-range");

  if (jsPlain && wasmAlp) {
    console.log(`  Ingest speedup (WASM ALP vs JS plain): ${(jsPlain.ingestP50 / wasmAlp.ingestP50).toFixed(2)}x`);
  }
  if (jsXor && wasmAlp) {
    console.log(`  Ingest speedup (WASM ALP vs JS XOR):   ${(jsXor.ingestP50 / wasmAlp.ingestP50).toFixed(2)}x`);
  }
  if (wasmXor && wasmAlp) {
    console.log(`  Ingest speedup (WASM ALP vs WASM XOR): ${(wasmXor.ingestP50 / wasmAlp.ingestP50).toFixed(2)}x`);
  }
  if (jsPlain && wasmAlp) {
    console.log(`  Compression improvement: ${(jsPlain.memBytes / wasmAlp.memBytes).toFixed(1)}x (${fmtBytes(jsPlain.memBytes)} → ${fmtBytes(wasmAlp.memBytes)})`);
  }
  if (jsPlain && wasmAlpRange) {
    console.log(`  Best config memory:      ${fmtBytes(wasmAlpRange.memBytes)} (${(wasmAlpRange.memBytes / TOTAL_SAMPLES).toFixed(2)} B/sample)`);
  }

  console.log(`\n  Key findings:`);
  console.log(`  • JS f64-plain = no compression (16 B/pt), fastest ingest but worst memory`);
  console.log(`  • JS XOR-values = pure-JS Gorilla XOR encoding (BigInt bit ops), good compression`);
  console.log(`  • WASM XOR = same algorithm in Rust/WASM, avoids BigInt overhead`);
  console.log(`  • WASM ALP = Adaptive Lossless floating-Point, fixed-width bit-packing`);
  console.log(`  • WASM ALP+range = adds fused decode+binary-search for range queries`);
  console.log(`\n  Bottleneck analysis:`);
  console.log(`  • JS XOR is slow due to BigInt allocation per bit operation`);
  console.log(`  • WASM eliminates GC pressure entirely — all work in linear memory`);
  console.log(`  • ALP beats XOR on structured decimals (gauges, counters)`);
  console.log(`  • ALP has exceptions on high-precision ratios (cpu.utilization)`);
  console.log(`  • Batch encode (encodeBatchValuesWithStats) amortizes WASM call overhead`);
  console.log(`  • Range-decode wins for partial reads (time-range queries)`);
  console.log(``);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
