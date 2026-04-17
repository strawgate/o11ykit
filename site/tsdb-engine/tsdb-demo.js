/**
 * o11ytsdb interactive demo — self-contained TSDB engine running in the browser.
 *
 * Implements:
 *  - FlatStore & ChunkedStore with XOR-delta (Gorilla) compression
 *  - Label index with inverted postings
 *  - ScanEngine with aggregation, groupBy, step bucketing, and rate
 *  - Canvas-based chart renderer
 *
 * All code runs client-side with zero dependencies.
 */

// ── XOR-Delta Codec ──────────────────────────────────────────────────

const f64Buf = new ArrayBuffer(8);
const f64View = new DataView(f64Buf);

function floatToBits(f) {
  f64View.setFloat64(0, f, false);
  const hi = f64View.getUint32(0, false);
  const lo = f64View.getUint32(4, false);
  return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
}

function bitsToFloat(bits) {
  f64View.setUint32(0, Number((bits >> 32n) & 0xFFFFFFFFn), false);
  f64View.setUint32(4, Number(bits & 0xFFFFFFFFn), false);
  return f64View.getFloat64(0, false);
}

function clz64(x) {
  if (x === 0n) return 64;
  let n = 0;
  if ((x & 0xFFFFFFFF00000000n) === 0n) { n += 32; x <<= 32n; }
  if ((x & 0xFFFF000000000000n) === 0n) { n += 16; x <<= 16n; }
  if ((x & 0xFF00000000000000n) === 0n) { n += 8; x <<= 8n; }
  if ((x & 0xF000000000000000n) === 0n) { n += 4; x <<= 4n; }
  if ((x & 0xC000000000000000n) === 0n) { n += 2; x <<= 2n; }
  if ((x & 0x8000000000000000n) === 0n) { n += 1; }
  return n;
}

function ctz64(x) {
  if (x === 0n) return 64;
  let n = 0;
  if ((x & 0xFFFFFFFFn) === 0n) { n += 32; x >>= 32n; }
  if ((x & 0xFFFFn) === 0n) { n += 16; x >>= 16n; }
  if ((x & 0xFFn) === 0n) { n += 8; x >>= 8n; }
  if ((x & 0xFn) === 0n) { n += 4; x >>= 4n; }
  if ((x & 0x3n) === 0n) { n += 2; x >>= 2n; }
  if ((x & 0x1n) === 0n) { n += 1; }
  return n;
}

class BitWriter {
  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.bytePos = 0;
    this.bitPos = 0;
  }
  writeBit(bit) {
    if (this.bytePos >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    if (bit) this.buf[this.bytePos] |= 0x80 >>> this.bitPos;
    this.bitPos++;
    if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
  }
  writeBits(value, count) {
    for (let i = count - 1; i >= 0; i--) this.writeBit(Number((value >> BigInt(i)) & 1n));
  }
  writeBitsNum(value, count) {
    for (let i = count - 1; i >= 0; i--) this.writeBit((value >>> i) & 1);
  }
  finish() {
    const len = this.bitPos > 0 ? this.bytePos + 1 : this.bytePos;
    return this.buf.slice(0, len);
  }
}

class BitReader {
  constructor(buf) { this.buf = buf; this.bytePos = 0; this.bitPos = 0; }
  readBit() {
    const bit = (this.buf[this.bytePos] >>> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
    return bit;
  }
  readBits(count) {
    let v = 0n;
    for (let i = 0; i < count; i++) v = (v << 1n) | BigInt(this.readBit());
    return v;
  }
  readBitsNum(count) {
    let v = 0;
    for (let i = 0; i < count; i++) v = (v << 1) | this.readBit();
    return v;
  }
}

function encodeChunk(timestamps, values) {
  const n = timestamps.length;
  if (n === 0) return new Uint8Array(0);
  const w = new BitWriter(n * 2);
  w.writeBitsNum(n, 16);
  w.writeBits(BigInt(timestamps[0]) & 0xFFFFFFFFFFFFFFFFn, 64);
  w.writeBits(floatToBits(values[0]), 64);
  if (n === 1) return w.finish();

  let prevTs = timestamps[0], prevDelta = 0n;
  let prevValBits = floatToBits(values[0]), prevLeading = 64, prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    const ts = timestamps[i];
    const delta = ts - prevTs;
    const dod = delta - prevDelta;

    if (dod === 0n) {
      w.writeBit(0);
    } else {
      const absDod = dod < 0n ? -dod : dod;
      if (absDod <= 64n) {
        w.writeBit(1); w.writeBit(0);
        w.writeBitsNum(Number((dod << 1n) ^ (dod >> 63n)) & 0x7F, 7);
      } else if (absDod <= 256n) {
        w.writeBit(1); w.writeBit(1); w.writeBit(0);
        w.writeBitsNum(Number((dod << 1n) ^ (dod >> 63n)) & 0x1FF, 9);
      } else if (absDod <= 2048n) {
        w.writeBit(1); w.writeBit(1); w.writeBit(1); w.writeBit(0);
        w.writeBitsNum(Number((dod << 1n) ^ (dod >> 63n)) & 0xFFF, 12);
      } else {
        w.writeBit(1); w.writeBit(1); w.writeBit(1); w.writeBit(1);
        w.writeBits(BigInt.asUintN(64, dod), 64);
      }
    }
    prevDelta = delta;
    prevTs = ts;

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
        w.writeBits(xor >> BigInt(prevTrailing), prevMeaningful);
      } else {
        w.writeBit(1); w.writeBit(1);
        w.writeBitsNum(leading, 6);
        w.writeBitsNum(meaningful - 1, 6);
        w.writeBits(xor >> BigInt(trailing), meaningful);
        prevLeading = leading;
        prevTrailing = trailing;
      }
    }
    prevValBits = valBits;
  }
  return w.finish();
}

function decodeChunk(buf) {
  if (buf.length === 0) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  const r = new BitReader(buf);
  const n = r.readBitsNum(16);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  timestamps[0] = BigInt.asIntN(64, r.readBits(64));
  values[0] = bitsToFloat(r.readBits(64));
  if (n === 1) return { timestamps, values };

  let prevTs = timestamps[0], prevDelta = 0n;
  let prevValBits = floatToBits(values[0]), prevLeading = 0, prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    let dod;
    if (r.readBit() === 0) {
      dod = 0n;
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(7);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(9);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(12);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
    } else {
      dod = BigInt.asIntN(64, r.readBits(64));
    }
    const delta = prevDelta + dod;
    timestamps[i] = prevTs + delta;
    prevDelta = delta;
    prevTs = timestamps[i];

    if (r.readBit() === 0) {
      values[i] = bitsToFloat(prevValBits);
    } else if (r.readBit() === 0) {
      const meaningful = 64 - prevLeading - prevTrailing;
      const xor = r.readBits(meaningful) << BigInt(prevTrailing);
      prevValBits ^= xor;
      values[i] = bitsToFloat(prevValBits);
    } else {
      const leading = r.readBitsNum(6);
      const meaningful = r.readBitsNum(6) + 1;
      const trailing = 64 - leading - meaningful;
      const xor = r.readBits(meaningful) << BigInt(trailing);
      prevValBits ^= xor;
      values[i] = bitsToFloat(prevValBits);
      prevLeading = leading;
      prevTrailing = trailing;
    }
  }
  return { timestamps, values };
}

// ── Binary search helpers ────────────────────────────────────────────

function lowerBound(arr, target, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function upperBound(arr, target, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ── FlatStore ────────────────────────────────────────────────────────

class FlatStore {
  constructor() {
    this.name = 'FlatStore';
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;
  }
  get seriesCount() { return this._series.length; }
  get sampleCount() { return this._sampleCount; }

  getOrCreateSeries(labels) {
    const key = [...labels].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(',');
    for (let i = 0; i < this._labels.length; i++) {
      const lkey = [...this._labels[i]].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(',');
      if (lkey === key) return i;
    }
    const id = this._series.length;
    this._series.push({ timestamps: new BigInt64Array(128), values: new Float64Array(128), count: 0 });
    this._labels.push(new Map(labels));
    for (const [k, v] of labels) {
      const pk = `${k}\0${v}`;
      if (!this._postings.has(pk)) this._postings.set(pk, []);
      this._postings.get(pk).push(id);
    }
    return id;
  }

  appendBatch(id, timestamps, values) {
    const s = this._series[id];
    let need = s.count + timestamps.length;
    while (need > s.timestamps.length) {
      const newLen = s.timestamps.length * 2;
      const newTs = new BigInt64Array(newLen);
      const newVals = new Float64Array(newLen);
      newTs.set(s.timestamps.subarray(0, s.count));
      newVals.set(s.values.subarray(0, s.count));
      s.timestamps = newTs;
      s.values = newVals;
    }
    s.timestamps.set(timestamps, s.count);
    s.values.set(values, s.count);
    s.count += timestamps.length;
    this._sampleCount += timestamps.length;
  }

  matchLabel(label, value) {
    return this._postings.get(`${label}\0${value}`) ?? [];
  }

  read(id, start, end) {
    const s = this._series[id];
    const lo = lowerBound(s.timestamps, start, 0, s.count);
    const hi = upperBound(s.timestamps, end, lo, s.count);
    return { timestamps: s.timestamps.slice(lo, hi), values: s.values.slice(lo, hi) };
  }

  labels(id) { return this._labels[id]; }

  memoryBytes() {
    let bytes = 0;
    for (const s of this._series) bytes += s.timestamps.byteLength + s.values.byteLength;
    return bytes;
  }

  getChunkInfo(id) {
    const s = this._series[id];
    return {
      frozen: [],
      hot: {
        count: s.count,
        rawBytes: s.count * 16,
        allocatedBytes: s.timestamps.byteLength + s.values.byteLength,
      },
    };
  }
}

// ── ChunkedStore ─────────────────────────────────────────────────────

class ChunkedStore {
  constructor(chunkSize = 640) {
    this.name = 'ChunkedStore';
    this.chunkSize = chunkSize;
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;
  }
  get seriesCount() { return this._series.length; }
  get sampleCount() { return this._sampleCount; }

  getOrCreateSeries(labels) {
    const key = [...labels].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(',');
    for (let i = 0; i < this._labels.length; i++) {
      const lkey = [...this._labels[i]].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(',');
      if (lkey === key) return i;
    }
    const id = this._series.length;
    this._series.push({
      hot: { timestamps: new BigInt64Array(this.chunkSize), values: new Float64Array(this.chunkSize), count: 0 },
      frozen: [],
    });
    this._labels.push(new Map(labels));
    for (const [k, v] of labels) {
      const pk = `${k}\0${v}`;
      if (!this._postings.has(pk)) this._postings.set(pk, []);
      this._postings.get(pk).push(id);
    }
    return id;
  }

  appendBatch(id, timestamps, values) {
    const s = this._series[id];
    let offset = 0;
    while (offset < timestamps.length) {
      const space = this.chunkSize - s.hot.count;
      const take = Math.min(space, timestamps.length - offset);
      s.hot.timestamps.set(timestamps.subarray(offset, offset + take), s.hot.count);
      s.hot.values.set(values.subarray(offset, offset + take), s.hot.count);
      s.hot.count += take;
      offset += take;
      this._sampleCount += take;
      if (s.hot.count >= this.chunkSize) this._freeze(s);
    }
  }

  _freeze(s) {
    const ts = s.hot.timestamps.slice(0, s.hot.count);
    const vals = s.hot.values.slice(0, s.hot.count);
    const compressed = encodeChunk(ts, vals);
    s.frozen.push({
      compressed,
      minT: ts[0],
      maxT: ts[ts.length - 1],
      count: ts.length,
    });
    s.hot.count = 0;
  }

  matchLabel(label, value) {
    return this._postings.get(`${label}\0${value}`) ?? [];
  }

  read(id, start, end) {
    const s = this._series[id];
    const parts = [];
    for (const chunk of s.frozen) {
      if (chunk.maxT < start || chunk.minT > end) continue;
      const decoded = decodeChunk(chunk.compressed);
      const lo = lowerBound(decoded.timestamps, start, 0, decoded.timestamps.length);
      const hi = upperBound(decoded.timestamps, end, lo, decoded.timestamps.length);
      if (hi > lo) parts.push({ timestamps: decoded.timestamps.slice(lo, hi), values: decoded.values.slice(lo, hi) });
    }
    if (s.hot.count > 0) {
      const lo = lowerBound(s.hot.timestamps, start, 0, s.hot.count);
      const hi = upperBound(s.hot.timestamps, end, lo, s.hot.count);
      if (hi > lo) parts.push({ timestamps: s.hot.timestamps.slice(lo, hi), values: s.hot.values.slice(lo, hi) });
    }
    if (parts.length === 0) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (parts.length === 1) return parts[0];
    const totalLen = parts.reduce((s, p) => s + p.timestamps.length, 0);
    const ts = new BigInt64Array(totalLen);
    const vs = new Float64Array(totalLen);
    let off = 0;
    for (const p of parts) { ts.set(p.timestamps, off); vs.set(p.values, off); off += p.timestamps.length; }
    return { timestamps: ts, values: vs };
  }

  labels(id) { return this._labels[id]; }

  memoryBytes() {
    let bytes = 0;
    for (const s of this._series) {
      bytes += s.hot.timestamps.byteLength + s.hot.values.byteLength;
      for (const c of s.frozen) bytes += c.compressed.byteLength + 32;
    }
    return bytes;
  }

  getChunkInfo(id) {
    const s = this._series[id];
    return {
      frozen: s.frozen.map((c, i) => ({
        index: i,
        compressedBytes: c.compressed.byteLength,
        count: c.count,
        minT: c.minT,
        maxT: c.maxT,
        rawBytes: c.count * 16,
        ratio: (c.count * 16) / c.compressed.byteLength,
        compressed: c.compressed,
      })),
      hot: {
        count: s.hot.count,
        rawBytes: s.hot.count * 16,
        allocatedBytes: s.hot.timestamps.byteLength + s.hot.values.byteLength,
        timestamps: s.hot.timestamps,
        values: s.hot.values,
      },
    };
  }
}

// ── WASM ALP Codec Loader ────────────────────────────────────────────

let wasmExports = null;
let wasmReady = false;
let wasmLoadError = null;

async function loadWasm() {
  try {
    const resp = await fetch('./o11ytsdb.wasm');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), { env: {} });
    wasmExports = instance.exports;
    wasmReady = true;
    return true;
  } catch (e) {
    wasmLoadError = e;
    console.warn('WASM load failed:', e);
    return false;
  }
}

function wasmMem() { return new Uint8Array(wasmExports.memory.buffer); }

function wasmEncodeValuesALP(values) {
  const n = values.length;
  wasmExports.resetScratch();
  const valPtr = wasmExports.allocScratch(n * 8);
  const outCap = n * 20;
  const outPtr = wasmExports.allocScratch(outCap);
  wasmMem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
  const bytesWritten = wasmExports.encodeValuesALP(valPtr, n, outPtr, outCap);
  return new Uint8Array(wasmExports.memory.buffer.slice(outPtr, outPtr + bytesWritten));
}

function wasmDecodeValuesALP(buf) {
  wasmExports.resetScratch();
  const inPtr = wasmExports.allocScratch(buf.length);
  wasmMem().set(buf, inPtr);
  const maxSamples = (buf[0] << 8) | buf[1];
  const valPtr = wasmExports.allocScratch(maxSamples * 8);
  const n = wasmExports.decodeValuesALP(inPtr, buf.length, valPtr, maxSamples);
  return new Float64Array(wasmExports.memory.buffer.slice(valPtr, valPtr + n * 8));
}

function wasmEncodeTimestamps(timestamps) {
  const n = timestamps.length;
  wasmExports.resetScratch();
  const tsPtr = wasmExports.allocScratch(n * 8);
  const outCap = n * 20;
  const outPtr = wasmExports.allocScratch(outCap);
  wasmMem().set(new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength), tsPtr);
  const bytesWritten = wasmExports.encodeTimestamps(tsPtr, n, outPtr, outCap);
  return new Uint8Array(wasmExports.memory.buffer.slice(outPtr, outPtr + bytesWritten));
}

function wasmDecodeTimestamps(buf) {
  wasmExports.resetScratch();
  const inPtr = wasmExports.allocScratch(buf.length);
  wasmMem().set(buf, inPtr);
  const maxSamples = (buf[0] << 8) | buf[1];
  const tsPtr = wasmExports.allocScratch(maxSamples * 8);
  const n = wasmExports.decodeTimestamps(inPtr, buf.length, tsPtr, maxSamples);
  return new BigInt64Array(wasmExports.memory.buffer.slice(tsPtr, tsPtr + n * 8));
}

// ── ColumnStore (ALP + shared timestamps) ────────────────────────────
//
// The key insight: co-scraped series share the same timestamps.
// Instead of N copies of timestamps, we store ONE shared timestamp
// column per group and only compress values per series with ALP.

class ColumnStore {
  constructor(chunkSize = 640) {
    this.name = 'ColumnStore (ALP)';
    this.chunkSize = chunkSize;
    this._allSeries = [];
    this._groups = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;
  }

  get seriesCount() { return this._allSeries.length; }
  get sampleCount() { return this._sampleCount; }

  getOrCreateSeries(labels) {
    const key = [...labels].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(',');
    for (let i = 0; i < this._labels.length; i++) {
      const lkey = [...this._labels[i]].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(',');
      if (lkey === key) return i;
    }
    const id = this._allSeries.length;

    // All series in one group (maximum timestamp sharing)
    const groupId = 0;
    while (this._groups.length <= groupId) {
      this._groups.push({
        hotTimestamps: new BigInt64Array(this.chunkSize),
        hotCount: 0,
        frozenTimestamps: [],
        members: [],
      });
    }
    const group = this._groups[groupId];
    group.members.push(id);

    this._allSeries.push({
      groupId,
      hot: { values: new Float64Array(this.chunkSize), count: 0 },
      frozen: [],
    });

    this._labels.push(new Map(labels));
    for (const [k, v] of labels) {
      const pk = `${k}\0${v}`;
      if (!this._postings.has(pk)) this._postings.set(pk, []);
      this._postings.get(pk).push(id);
    }
    return id;
  }

  appendBatch(id, timestamps, values) {
    const s = this._allSeries[id];
    const group = this._groups[s.groupId];
    let offset = 0;

    while (offset < timestamps.length) {
      let space = s.hot.values.length - s.hot.count;

      if (space === 0) {
        const countBefore = s.hot.count;
        this._maybeFreeze(group);
        if (s.hot.count < countBefore) {
          space = s.hot.values.length - s.hot.count;
        } else {
          // Group can't freeze yet — expand buffer
          const newSize = s.hot.values.length + this.chunkSize;
          const newVals = new Float64Array(newSize);
          newVals.set(s.hot.values);
          s.hot.values = newVals;
          if (group.hotTimestamps.length < newSize) {
            const newTs = new BigInt64Array(newSize);
            newTs.set(group.hotTimestamps);
            group.hotTimestamps = newTs;
          }
          space = newSize - s.hot.count;
        }
      }

      const batch = Math.min(space, timestamps.length - offset);

      // Write timestamps to shared group buffer
      const tsSlice = timestamps.subarray(offset, offset + batch);
      if (s.hot.count <= group.hotCount) {
        group.hotTimestamps.set(tsSlice, s.hot.count);
      }

      s.hot.values.set(values.subarray(offset, offset + batch), s.hot.count);
      s.hot.count += batch;
      this._sampleCount += batch;
      offset += batch;

      if (s.hot.count > group.hotCount) {
        group.hotCount = s.hot.count;
      }

      if (s.hot.count >= this.chunkSize) {
        this._maybeFreeze(group);
      }
    }
  }

  _maybeFreeze(group) {
    let minCount = Infinity;
    for (const memberId of group.members) {
      const c = this._allSeries[memberId].hot.count;
      if (c < minCount) minCount = c;
    }

    const chunksToFreeze = Math.floor(minCount / this.chunkSize);
    if (chunksToFreeze === 0) return;

    for (let c = 0; c < chunksToFreeze; c++) {
      const chunkStart = c * this.chunkSize;

      // Freeze shared timestamps for this chunk
      const ts = group.hotTimestamps.slice(chunkStart, chunkStart + this.chunkSize);
      const tsChunkIndex = group.frozenTimestamps.length;
      const compressedTs = wasmEncodeTimestamps(ts);
      group.frozenTimestamps.push({
        compressed: compressedTs,
        timestamps: null, // lazy decode cache
        minT: ts[0],
        maxT: ts[this.chunkSize - 1],
        count: this.chunkSize,
      });

      // Freeze each member's values with ALP
      for (const memberId of group.members) {
        const s = this._allSeries[memberId];
        const vals = s.hot.values.subarray(chunkStart, chunkStart + this.chunkSize);
        const compressedValues = wasmEncodeValuesALP(vals);
        s.frozen.push({ compressedValues, tsChunkIndex, count: this.chunkSize });
      }
    }

    // Shift remaining hot data
    const frozenSamples = chunksToFreeze * this.chunkSize;
    for (const memberId of group.members) {
      const s = this._allSeries[memberId];
      const remaining = s.hot.count - frozenSamples;
      if (remaining > 0) {
        s.hot.values.copyWithin(0, frozenSamples, s.hot.count);
        s.hot.count = remaining;
      } else {
        s.hot.count = 0;
      }
    }
    const tsRemaining = group.hotCount - frozenSamples;
    if (tsRemaining > 0) {
      group.hotTimestamps.copyWithin(0, frozenSamples, group.hotCount);
      group.hotCount = tsRemaining;
    } else {
      group.hotCount = 0;
    }
  }

  matchLabel(label, value) {
    return this._postings.get(`${label}\0${value}`) ?? [];
  }

  read(id, start, end) {
    const s = this._allSeries[id];
    const group = this._groups[s.groupId];
    const parts = [];

    for (const chunk of s.frozen) {
      const tsChunk = group.frozenTimestamps[chunk.tsChunkIndex];
      if (tsChunk.maxT < start || tsChunk.minT > end) continue;

      // Decode timestamps (cached)
      if (!tsChunk.timestamps) {
        tsChunk.timestamps = wasmDecodeTimestamps(tsChunk.compressed);
      }
      const timestamps = tsChunk.timestamps;
      const values = wasmDecodeValuesALP(chunk.compressedValues);

      const lo = lowerBound(timestamps, start, 0, tsChunk.count);
      const hi = upperBound(timestamps, end, lo, tsChunk.count);
      if (hi > lo) {
        parts.push({ timestamps: timestamps.slice(lo, hi), values: values.slice(lo, hi) });
      }
    }

    // Scan hot buffer
    if (s.hot.count > 0) {
      const lo = lowerBound(group.hotTimestamps, start, 0, s.hot.count);
      const hi = upperBound(group.hotTimestamps, end, lo, s.hot.count);
      if (hi > lo) {
        parts.push({
          timestamps: group.hotTimestamps.slice(lo, hi),
          values: s.hot.values.slice(lo, hi),
        });
      }
    }

    if (parts.length === 0) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (parts.length === 1) return parts[0];
    const totalLen = parts.reduce((s, p) => s + p.timestamps.length, 0);
    const ts = new BigInt64Array(totalLen);
    const vs = new Float64Array(totalLen);
    let off = 0;
    for (const p of parts) { ts.set(p.timestamps, off); vs.set(p.values, off); off += p.timestamps.length; }
    return { timestamps: ts, values: vs };
  }

  labels(id) { return this._labels[id]; }

  memoryBytes() {
    let bytes = 0;
    for (const g of this._groups) {
      bytes += g.hotCount * 8;
      for (const tc of g.frozenTimestamps) {
        bytes += tc.compressed.byteLength;
      }
    }
    for (const s of this._allSeries) {
      bytes += s.hot.count * 8;
      for (const c of s.frozen) {
        bytes += c.compressedValues.byteLength;
      }
    }
    return bytes;
  }

  getChunkInfo(id) {
    const s = this._allSeries[id];
    const group = this._groups[s.groupId];
    return {
      frozen: s.frozen.map((c, i) => {
        const tsChunk = group.frozenTimestamps[c.tsChunkIndex];
        const valBytes = c.compressedValues.byteLength;
        const tsBytes = tsChunk.compressed.byteLength;
        const sharedTsSeries = group.members.length;
        // Amortized timestamp cost: split equally among group members
        const amortizedTsBytes = tsBytes / sharedTsSeries;
        const totalCompressed = valBytes + amortizedTsBytes;
        const rawBytes = c.count * 16;
        return {
          index: i,
          compressedBytes: Math.round(totalCompressed),
          valuesBytes: valBytes,
          timestampBytes: tsBytes,
          sharedTsSeries,
          amortizedTsBytes: Math.round(amortizedTsBytes),
          count: c.count,
          minT: tsChunk.minT,
          maxT: tsChunk.maxT,
          rawBytes,
          ratio: rawBytes / totalCompressed,
          compressedValues: c.compressedValues,
          tsChunkCompressed: tsChunk.compressed,
        };
      }),
      hot: {
        count: s.hot.count,
        rawBytes: s.hot.count * 16,
        allocatedBytes: (s.hot.values.byteLength) + (group.hotTimestamps.byteLength / Math.max(1, group.members.length)),
        timestamps: group.hotTimestamps,
        values: s.hot.values,
      },
      // Extra info for storage explorer
      _isColumnStore: true,
      _groupMembers: group.members.length,
      _sharedTsChunks: group.frozenTimestamps.length,
      _sharedTsTotalBytes: group.frozenTimestamps.reduce((s, tc) => s + tc.compressed.byteLength, 0),
    };
  }
}

// ── ScanEngine ───────────────────────────────────────────────────────

function aggInit(fn) {
  if (fn === 'min') return Infinity;
  if (fn === 'max') return -Infinity;
  return 0;
}

function aggAccum(acc, v, fn) {
  switch (fn) {
    case 'sum': case 'avg': return acc + v;
    case 'min': return v < acc ? v : acc;
    case 'max': return v > acc ? v : acc;
    case 'count': return acc + 1;
    case 'last': return v;
    default: return acc;
  }
}

function aggFinalize(vals, counts, fn) {
  if (fn === 'avg') for (let i = 0; i < vals.length; i++) if (counts[i] > 0) vals[i] /= counts[i];
}

class ScanEngine {
  query(storage, opts) {
    let ids = storage.matchLabel('__name__', opts.metric);
    if (opts.matchers) {
      for (const m of opts.matchers) {
        const s = new Set(storage.matchLabel(m.label, m.value));
        ids = ids.filter(id => s.has(id));
      }
    }
    let scannedSamples = 0;
    if (!opts.agg) {
      const series = [];
      for (const id of ids) {
        const data = storage.read(id, opts.start, opts.end);
        scannedSamples += data.timestamps.length;
        series.push({ labels: storage.labels(id) ?? new Map(), timestamps: data.timestamps, values: data.values });
      }
      return { series, scannedSeries: ids.length, scannedSamples };
    }

    const groups = new Map();
    for (const id of ids) {
      const data = storage.read(id, opts.start, opts.end);
      scannedSamples += data.timestamps.length;
      const labels = storage.labels(id) ?? new Map();
      const groupKey = opts.groupBy ? opts.groupBy.map(k => labels.get(k) ?? '').join('\0') : '__all__';
      let group = groups.get(groupKey);
      if (!group) {
        const gl = new Map(); gl.set('__name__', opts.metric);
        if (opts.groupBy) for (const k of opts.groupBy) { const v = labels.get(k); if (v) gl.set(k, v); }
        group = { labels: gl, ranges: [] };
        groups.set(groupKey, group);
      }
      group.ranges.push(data);
    }

    const series = [];
    for (const [, group] of groups) {
      const result = this._aggregate(group.ranges, opts.agg, opts.step);
      series.push({ labels: group.labels, timestamps: result.timestamps, values: result.values });
    }
    return { series, scannedSeries: ids.length, scannedSamples };
  }

  _aggregate(ranges, fn, step) {
    if (ranges.length === 0) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (!step) return this._pointAggregate(ranges, fn);
    return this._stepAggregate(ranges, fn, step);
  }

  _pointAggregate(ranges, fn) {
    let longest = ranges[0];
    for (const r of ranges) if (r.timestamps.length > longest.timestamps.length) longest = r;
    const timestamps = longest.timestamps;
    const values = new Float64Array(timestamps.length);
    if (fn === 'rate') {
      const src = ranges[0];
      for (let i = 1; i < src.timestamps.length; i++) {
        const dt = Number(src.timestamps[i] - src.timestamps[i - 1]) / 1_000_000; // ns → ms → s
        values[i] = dt > 0 ? (src.values[i] - src.values[i - 1]) / (dt / 1000) : 0;
      }
      return { timestamps, values };
    }
    values.fill(aggInit(fn));
    const counts = new Float64Array(timestamps.length);
    for (const r of ranges) {
      const len = Math.min(r.values.length, timestamps.length);
      for (let i = 0; i < len; i++) { values[i] = aggAccum(values[i], r.values[i], fn); counts[i]++; }
    }
    aggFinalize(values, counts, fn);
    return { timestamps, values };
  }

  _stepAggregate(ranges, fn, step) {
    let minT = BigInt('9223372036854775807');
    let maxT = -minT;
    for (const r of ranges) {
      if (r.timestamps.length === 0) continue;
      if (r.timestamps[0] < minT) minT = r.timestamps[0];
      if (r.timestamps[r.timestamps.length - 1] > maxT) maxT = r.timestamps[r.timestamps.length - 1];
    }
    const bucketCount = Number((maxT - minT) / step) + 1;
    const timestamps = new BigInt64Array(bucketCount);
    const values = new Float64Array(bucketCount);
    const counts = new Float64Array(bucketCount);
    for (let i = 0; i < bucketCount; i++) timestamps[i] = minT + BigInt(i) * step;
    values.fill(aggInit(fn));
    for (const r of ranges) {
      for (let i = 0; i < r.timestamps.length; i++) {
        const bucket = Number((r.timestamps[i] - minT) / step);
        if (bucket < 0 || bucket >= bucketCount) continue;
        values[bucket] = aggAccum(values[bucket], r.values[i], fn);
        counts[bucket]++;
      }
    }
    aggFinalize(values, counts, fn);
    return { timestamps, values };
  }
}

// ── Data Generators ──────────────────────────────────────────────────

const REGIONS = ['us-east', 'us-west', 'eu-west', 'ap-south', 'ap-east'];
const INSTANCES = ['web-01', 'web-02', 'web-03', 'api-01', 'api-02', 'worker-01', 'worker-02', 'cache-01', 'db-01', 'db-02'];
const METRICS = [
  'http_requests_total',
  'cpu_usage_percent',
  'memory_usage_bytes',
];

function generateValue(pattern, i, seriesIdx, total) {
  const phase = (seriesIdx * 0.7);
  const t = i / total;
  switch (pattern) {
    case 'sine':
      return 100 + Math.sin((i / 50) + phase) * 40 + Math.sin((i / 200) + phase) * 20 + (Math.random() - 0.5) * 8;
    case 'sawtooth':
      return ((i + seriesIdx * 100) % 200) + Math.random() * 5;
    case 'random-walk': {
      const seed = seriesIdx * 7919 + 1;
      const v = 50 + seriesIdx * 10
        + Math.sin(i * 0.01 + seed) * 30
        + Math.sin(i * 0.003 + seed * 1.7) * 20
        + Math.cos(i * 0.0007 + seed * 2.3) * 15;
      return Math.max(0, v);
    }
    case 'spiky': {
      const base = 20 + seriesIdx * 5;
      const spike = (i % 100 < 5) ? 200 + Math.random() * 100 : 0;
      return base + Math.random() * 10 + spike;
    }
    case 'constant':
      return 42.0 + seriesIdx * 0.001;
    default:
      return Math.random() * 100;
  }
}

// ── Chart Renderer ───────────────────────────────────────────────────

const CHART_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#e11d48', '#a855f7', '#0ea5e9', '#eab308',
];

function renderChart(canvas, seriesData, title) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.min(rect.width - 32, 1100);
  const h = 380;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  const pad = { top: 40, right: 20, bottom: 50, left: 70 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Find global min/max
  let minT = Infinity, maxT = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const s of seriesData) {
    for (let i = 0; i < s.timestamps.length; i++) {
      const t = Number(s.timestamps[i]);
      const v = s.values[i];
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }

  if (minV === maxV) { minV -= 1; maxV += 1; }
  const vPad = (maxV - minV) * 0.08;
  minV -= vPad;
  maxV += vPad;

  const tRange = maxT - minT || 1;
  const vRange = maxV - minV || 1;

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  const yTicks = 6;
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (plotH * i / yTicks);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  const xTicks = Math.min(8, seriesData[0]?.timestamps.length || 8);
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (plotW * i / xTicks);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, h - pad.bottom);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = '#6b8a9e';
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (plotH * i / yTicks);
    const val = maxV - (i / yTicks) * vRange;
    ctx.fillText(formatNum(val), pad.left - 8, y);
  }

  // X-axis labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (plotW * i / xTicks);
    const tNs = minT + (i / xTicks) * tRange;
    const tMs = tNs / 1_000_000;
    const d = new Date(tMs);
    ctx.fillText(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), x, h - pad.bottom + 8);
  }

  // Title
  ctx.fillStyle = '#0f3a5e';
  ctx.font = '600 14px "Space Grotesk", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title || 'Query Results', pad.left, 10);

  // Point count
  const totalPoints = seriesData.reduce((s, d) => s + d.timestamps.length, 0);
  ctx.fillStyle = '#6b8a9e';
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${totalPoints.toLocaleString()} points rendered`, w - pad.right, 12);

  // Draw series
  for (let si = 0; si < seriesData.length; si++) {
    const s = seriesData[si];
    const color = CHART_COLORS[si % CHART_COLORS.length];

    // Area fill
    ctx.beginPath();
    let firstX, firstY;
    for (let i = 0; i < s.timestamps.length; i++) {
      const x = pad.left + ((Number(s.timestamps[i]) - minT) / tRange) * plotW;
      const y = pad.top + ((maxV - s.values[i]) / vRange) * plotH;
      if (i === 0) { ctx.moveTo(x, y); firstX = x; firstY = y; }
      else ctx.lineTo(x, y);
    }
    if (s.timestamps.length > 0) {
      const lastX = pad.left + ((Number(s.timestamps[s.timestamps.length - 1]) - minT) / tRange) * plotW;
      ctx.lineTo(lastX, pad.top + plotH);
      ctx.lineTo(firstX, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = color + '12';
      ctx.fill();
    }

    // Line
    ctx.beginPath();
    for (let i = 0; i < s.timestamps.length; i++) {
      const x = pad.left + ((Number(s.timestamps[i]) - minT) / tRange) * plotW;
      const y = pad.top + ((maxV - s.values[i]) / vRange) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Axes border
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.lineTo(w - pad.right, h - pad.bottom);
  ctx.stroke();

  // Save state for tooltip
  lastChartState = { seriesData, minT, maxT, minV, maxV, pad, w, h, plotW, plotH, tRange, vRange };
}

function formatNum(n) {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(1);
  return n.toFixed(1);
}

function formatBytes(b) {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

// ── Chart Tooltip ─────────────────────────────────────────────────

let lastChartState = null;
let tooltipEl = null;
let crosshairEl = null;

function setupChartTooltip() {
  const canvas = $('#chartCanvas');
  const container = canvas.closest('.chart-container');
  container.style.position = 'relative';

  if (!crosshairEl) {
    crosshairEl = document.createElement('div');
    crosshairEl.className = 'chart-crosshair';
    container.appendChild(crosshairEl);
  }
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'chart-tooltip';
    container.appendChild(tooltipEl);
  }

  canvas.addEventListener('mousemove', handleChartHover);
  canvas.addEventListener('mouseleave', () => {
    if (crosshairEl) crosshairEl.style.display = 'none';
    if (tooltipEl) tooltipEl.style.display = 'none';
  });
}

function handleChartHover(e) {
  if (!lastChartState || !tooltipEl || !crosshairEl) return;
  const { seriesData, minT, maxT, pad, w, h, plotW, plotH, tRange, vRange, minV, maxV } = lastChartState;
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.clientWidth / lastChartState.w;
  const scaleY = canvas.clientHeight / lastChartState.h;
  const mx = (e.clientX - rect.left) / scaleX;
  const my = (e.clientY - rect.top) / scaleY;

  if (mx < pad.left || mx > w - pad.right || my < pad.top || my > h - pad.bottom) {
    crosshairEl.style.display = 'none';
    tooltipEl.style.display = 'none';
    return;
  }

  const mouseT = minT + ((mx - pad.left) / plotW) * tRange;
  const points = [];

  for (let si = 0; si < seriesData.length; si++) {
    const s = seriesData[si];
    if (s.timestamps.length === 0) continue;
    // Binary search for nearest timestamp
    let lo = 0, hi = s.timestamps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (Number(s.timestamps[mid]) < mouseT) lo = mid + 1; else hi = mid;
    }
    // Check neighbors for closest
    let nearest = lo;
    if (lo > 0 && Math.abs(Number(s.timestamps[lo - 1]) - mouseT) < Math.abs(Number(s.timestamps[lo]) - mouseT)) {
      nearest = lo - 1;
    }
    const labelStr = s.labels
      ? [...s.labels].filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ')
      : `series ${si}`;
    points.push({
      value: s.values[nearest],
      label: labelStr || 'all',
      color: CHART_COLORS[si % CHART_COLORS.length],
      timestamp: Number(s.timestamps[nearest]),
      y: pad.top + ((maxV - s.values[nearest]) / vRange) * plotH,
    });
  }

  if (points.length === 0) return;

  // Position crosshair (in CSS coordinates)
  const cssLeft = mx * scaleX;
  const cssTop = pad.top * scaleY;
  const cssHeight = plotH * scaleY;
  crosshairEl.style.display = 'block';
  crosshairEl.style.left = cssLeft + 'px';
  crosshairEl.style.top = cssTop + 'px';
  crosshairEl.style.height = cssHeight + 'px';

  // Build tooltip
  const time = new Date(points[0].timestamp / 1_000_000);
  let html = `<div class="tooltip-time">${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>`;
  for (const p of points) {
    html += `<div class="tooltip-row"><span class="tooltip-swatch" style="background:${p.color}"></span><span class="tooltip-label">${p.label}</span><strong>${p.value.toFixed(2)}</strong></div>`;
  }
  tooltipEl.innerHTML = html;
  tooltipEl.style.display = 'block';

  // Position tooltip
  const tooltipW = tooltipEl.offsetWidth;
  const containerW = canvas.closest('.chart-container').offsetWidth;
  const left = cssLeft + 20 + tooltipW > containerW ? cssLeft - tooltipW - 12 : cssLeft + 20;
  const top = Math.max(4, (e.clientY - canvas.closest('.chart-container').getBoundingClientRect().top) - 30);
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}

// ── UI Wiring ────────────────────────────────────────────────────────

let currentStore = null;
let currentEngine = new ScanEngine();
let generatedMetrics = [];

const $ = (sel) => document.querySelector(sel);

$('#btnGenerate').addEventListener('click', () => {
  const numSeries = parseInt($('#numSeries').value);
  const numPoints = parseInt($('#numPoints').value);
  const pattern = $('#dataPattern').value;
  const backendType = $('#backend').value;
  const intervalMs = parseInt($('#sampleInterval').value);

  const btn = $('#btnGenerate');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  // Use requestAnimationFrame to let the UI update before heavy computation
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        generateData(numSeries, numPoints, pattern, backendType, intervalMs);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Data';
      }
    }, 50);
  });
});

function generateData(numSeries, numPoints, pattern, backendType, intervalMs = 10000) {
  let store;
  if (backendType === 'column') {
    if (!wasmReady) {
      alert('WASM codec not loaded — ColumnStore requires WebAssembly. Try ChunkedStore instead.');
      return;
    }
    store = new ColumnStore(640);
  } else if (backendType === 'chunked') {
    store = new ChunkedStore(640);
  } else {
    store = new FlatStore();
  }
  const now = BigInt(Date.now()) * 1_000_000n; // nanoseconds
  const intervalNs = BigInt(intervalMs) * 1_000_000n;

  const t0 = performance.now();

  generatedMetrics = [];
  const metricsUsed = new Set();

  // Pre-generate series metadata and data
  const allSeriesData = [];
  for (let si = 0; si < numSeries; si++) {
    const metricName = METRICS[si % METRICS.length];
    const region = REGIONS[Math.floor(si / METRICS.length) % REGIONS.length];
    const instance = INSTANCES[si % INSTANCES.length];
    metricsUsed.add(metricName);

    const labels = new Map([
      ['__name__', metricName],
      ['region', region],
      ['instance', instance],
      ['job', 'demo'],
    ]);

    const id = store.getOrCreateSeries(labels);
    const timestamps = new BigInt64Array(numPoints);
    const values = new Float64Array(numPoints);
    const startT = now - BigInt(numPoints) * intervalNs;
    for (let i = 0; i < numPoints; i++) {
      timestamps[i] = startT + BigInt(i) * intervalNs;
      values[i] = generateValue(pattern, i, si, numPoints);
    }
    allSeriesData.push({ id, timestamps, values });
  }

  // ColumnStore needs interleaved ingestion (co-scraped timestamps).
  // Append in chunk-sized rounds across all series so freeze triggers.
  if (backendType === 'column') {
    const chunkSize = 640;
    for (let offset = 0; offset < numPoints; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, numPoints);
      for (const sd of allSeriesData) {
        store.appendBatch(sd.id, sd.timestamps.subarray(offset, end), sd.values.subarray(offset, end));
      }
    }
  } else {
    for (const sd of allSeriesData) {
      store.appendBatch(sd.id, sd.timestamps, sd.values);
    }
  }

  const ingestTime = performance.now() - t0;
  currentStore = store;
  generatedMetrics = [...metricsUsed];

  // Compute stats
  const totalPoints = store.sampleCount;
  const memBytes = store.memoryBytes();
  const rawBytes = totalPoints * 16; // 8 bytes ts + 8 bytes val
  const compressionRatio = rawBytes / memBytes;

  // Update stats UI
  $('#statsGrid').style.display = '';
  $('#statTotalPoints').textContent = totalPoints.toLocaleString();
  $('#statSeries').textContent = store.seriesCount.toLocaleString();
  $('#statMemory').textContent = formatBytes(memBytes);
  $('#statCompression').textContent = compressionRatio.toFixed(1) + '×';
  $('#statIngestTime').textContent = ingestTime.toFixed(0) + ' ms';
  $('#statIngestRate').textContent = formatNum(totalPoints / (ingestTime / 1000)) + ' pts/s';

  // Populate metric selector
  const metricSelect = $('#queryMetric');
  metricSelect.innerHTML = '';
  for (const m of generatedMetrics) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    metricSelect.appendChild(opt);
  }

  // Show query controls
  $('#queryControls').style.display = '';

  // Show compression breakdown
  showCompressionBreakdown(rawBytes, memBytes);

  // Auto-select a sensible query step based on interval & point count
  autoSelectQueryStep(intervalMs, numPoints);

  // Build storage explorer
  buildStorageExplorer(store);

  // Auto-run a query
  runQuery();
}

$('#btnQuery').addEventListener('click', runQuery);

function runQuery() {
  if (!currentStore) return;

  const metric = $('#queryMetric').value;
  const agg = $('#queryAgg').value || undefined;
  const groupBy = $('#queryGroupBy').value ? [$('#queryGroupBy').value] : undefined;
  const stepMs = parseInt($('#queryStep').value);
  const step = stepMs > 0 ? BigInt(stepMs) * 1_000_000n : undefined;

  // Find time range from all data
  const ids = currentStore.matchLabel('__name__', metric);
  if (ids.length === 0) return;

  let minT = BigInt('9223372036854775807');
  let maxT = -minT;
  for (const id of ids) {
    const data = currentStore.read(id, -minT, minT);
    if (data.timestamps.length > 0) {
      if (data.timestamps[0] < minT) minT = data.timestamps[0];
      if (data.timestamps[data.timestamps.length - 1] > maxT) maxT = data.timestamps[data.timestamps.length - 1];
    }
  }

  const t0 = performance.now();
  const result = currentEngine.query(currentStore, {
    metric,
    start: minT,
    end: maxT,
    agg,
    groupBy,
    step,
  });
  const queryTime = performance.now() - t0;

  // Update query stats
  $('#queryResults').style.display = '';
  $('#qStatScannedSeries').innerHTML = `Scanned: <strong>${result.scannedSeries}</strong> series`;
  $('#qStatScannedSamples').innerHTML = `Samples: <strong>${result.scannedSamples.toLocaleString()}</strong>`;
  $('#qStatResultSeries').innerHTML = `Result: <strong>${result.series.length}</strong> series`;
  $('#qStatQueryTime').innerHTML = `Time: <strong>${queryTime.toFixed(1)} ms</strong>`;

  // Build chart title
  const aggLabel = agg ? `${agg}(${metric})` : metric;
  const groupLabel = groupBy ? ` by ${groupBy.join(', ')}` : '';
  const stepLabel = step ? ` [${formatDuration(stepMs)} step]` : '';
  const chartTitle = `${aggLabel}${groupLabel}${stepLabel}`;

  // Render chart
  renderChart($('#chartCanvas'), result.series, chartTitle);
  setupChartTooltip();

  // Build legend
  const legendEl = $('#chartLegend');
  legendEl.innerHTML = '';
  for (let i = 0; i < result.series.length; i++) {
    const s = result.series[i];
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const labelStr = [...s.labels].filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ') || 'all';
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-swatch" style="background:${color}"></span>${labelStr} (${s.timestamps.length.toLocaleString()} pts)`;
    legendEl.appendChild(item);
  }
}

function showCompressionBreakdown(rawBytes, compressedBytes) {
  const el = $('#compressionBench');
  el.style.display = '';
  const bars = $('#compressionBars');
  const maxVal = rawBytes;

  const rows = [
    { label: 'Raw (16 B/pt)', bytes: rawBytes, cls: 'raw' },
    { label: currentStore instanceof ColumnStore ? 'ALP + shared ts' : 'XOR-Delta', bytes: compressedBytes, cls: 'compressed' },
  ];

  bars.innerHTML = rows.map(r => {
    const pct = Math.max(2, (r.bytes / maxVal) * 100);
    return `
      <div class="comp-bar-row">
        <span class="comp-bar-label">${r.label}</span>
        <div class="comp-bar-track">
          <div class="comp-bar-fill ${r.cls}" style="width:${pct}%">${formatBytes(r.bytes)}</div>
        </div>
        <span class="comp-bar-value">${(rawBytes / r.bytes).toFixed(1)}×</span>
      </div>`;
  }).join('');
}

// Re-run query when controls change
for (const id of ['queryMetric', 'queryAgg', 'queryGroupBy', 'queryStep']) {
  $(`#${id}`).addEventListener('change', () => { if (currentStore) runQuery(); });
}

// Handle canvas resize
window.addEventListener('resize', () => {
  if (currentStore && $('#queryResults').style.display !== 'none') runQuery();
});

// ── Duration Formatting ──────────────────────────────────────────────

function formatDuration(ms) {
  if (ms >= 86400000) return (ms / 86400000) + 'd';
  if (ms >= 3600000) return (ms / 3600000) + 'h';
  if (ms >= 60000) return (ms / 60000) + 'm';
  return (ms / 1000) + 's';
}

function formatTimeRange(nsStart, nsEnd) {
  const start = new Date(Number(nsStart) / 1_000_000);
  const end = new Date(Number(nsEnd) / 1_000_000);
  const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return `${start.toLocaleString([], opts)} → ${end.toLocaleString([], opts)}`;
}

// ── Auto Query Step Selection ────────────────────────────────────────

function autoSelectQueryStep(intervalMs, numPoints) {
  const totalMs = intervalMs * numPoints;
  const stepSelect = $('#queryStep');
  // Pick a step that yields ~50-200 buckets for good chart resolution
  const targetBuckets = 100;
  const idealStepMs = totalMs / targetBuckets;
  const stepOptions = [...stepSelect.options].map(o => parseInt(o.value)).filter(v => v > 0);
  let bestStep = stepOptions[0];
  let bestDiff = Infinity;
  for (const s of stepOptions) {
    const diff = Math.abs(s - idealStepMs);
    if (diff < bestDiff) { bestDiff = diff; bestStep = s; }
  }
  stepSelect.value = String(bestStep);
}

// ── Storage Explorer ─────────────────────────────────────────────────

function buildStorageExplorer(store) {
  const explorer = $('#storageExplorer');
  const overview = $('#storageOverview');
  const seriesList = $('#storageSeriesList');
  const detailPanel = $('#chunkDetailPanel');
  explorer.style.display = '';
  detailPanel.style.display = 'none';

  // Overview stats
  let totalChunks = 0, totalFrozen = 0, totalHotSamples = 0, totalCompressedBytes = 0, totalRawBytes = 0;
  const seriesInfos = [];

  for (let id = 0; id < store.seriesCount; id++) {
    const labels = store.labels(id);
    const info = store.getChunkInfo(id);
    const frozenSamples = info.frozen.reduce((s, c) => s + c.count, 0);
    const frozenBytes = info.frozen.reduce((s, c) => s + c.compressedBytes, 0);
    const frozenRaw = info.frozen.reduce((s, c) => s + c.rawBytes, 0);
    totalFrozen += info.frozen.length;
    totalChunks += info.frozen.length + (info.hot.count > 0 ? 1 : 0);
    totalHotSamples += info.hot.count;
    totalCompressedBytes += frozenBytes + (info.hot.count > 0 ? info.hot.rawBytes : 0);
    totalRawBytes += frozenRaw + info.hot.rawBytes;

    seriesInfos.push({ id, labels, info, frozenSamples, frozenBytes, frozenRaw });
  }

  // Extra stats for ColumnStore
  const firstInfo = seriesInfos.length > 0 ? seriesInfos[0].info : null;
  const isColumnStore = firstInfo && firstInfo._isColumnStore;
  const columnStatsHtml = isColumnStore ? `
      <div class="explorer-stat column-stat">
        <span class="explorer-stat-value">${firstInfo._groupMembers}</span>
        <span class="explorer-stat-label">Series sharing timestamps</span>
      </div>
      <div class="explorer-stat column-stat">
        <span class="explorer-stat-value">${firstInfo._sharedTsChunks}</span>
        <span class="explorer-stat-label">Shared ts chunks</span>
      </div>
      <div class="explorer-stat column-stat">
        <span class="explorer-stat-value">${formatBytes(firstInfo._sharedTsTotalBytes)}</span>
        <span class="explorer-stat-label">Shared ts storage</span>
      </div>` : '';

  overview.innerHTML = `
    <div class="explorer-stats">
      <div class="explorer-stat">
        <span class="explorer-stat-value">${store.seriesCount}</span>
        <span class="explorer-stat-label">Series</span>
      </div>
      <div class="explorer-stat">
        <span class="explorer-stat-value">${totalChunks}</span>
        <span class="explorer-stat-label">Total chunks</span>
      </div>
      <div class="explorer-stat">
        <span class="explorer-stat-value">${totalFrozen}</span>
        <span class="explorer-stat-label">Frozen (compressed)</span>
      </div>
      <div class="explorer-stat">
        <span class="explorer-stat-value">${formatBytes(totalCompressedBytes)}</span>
        <span class="explorer-stat-label">Total storage</span>
      </div>
      <div class="explorer-stat">
        <span class="explorer-stat-value">${totalRawBytes > 0 ? (totalRawBytes / totalCompressedBytes).toFixed(1) + '×' : '—'}</span>
        <span class="explorer-stat-label">Avg compression</span>
      </div>
      ${columnStatsHtml}
    </div>`;

  // Build series rows
  seriesList.innerHTML = '';
  for (const si of seriesInfos) {
    const row = document.createElement('div');
    row.className = 'storage-series-row';

    const labelStr = [...si.labels]
      .filter(([k]) => k !== '__name__')
      .map(([k, v]) => `<span class="label-pair"><span class="label-key">${k}</span>=<span class="label-val">${v}</span></span>`)
      .join(' ');
    const metricName = si.labels.get('__name__') || 'unknown';

    const totalSamples = si.frozenSamples + si.info.hot.count;
    const totalBytes = si.frozenBytes + (si.info.hot.count > 0 ? si.info.hot.rawBytes : 0);

    row.innerHTML = `
      <div class="series-header">
        <span class="series-metric">${metricName}</span>
        <span class="series-labels">${labelStr}</span>
        <span class="series-summary">${totalSamples.toLocaleString()} pts · ${formatBytes(totalBytes)} · ${si.info.frozen.length} chunks${si.info.hot.count > 0 ? ' + hot' : ''}</span>
      </div>
      <div class="chunk-bar-container"></div>`;

    // Render chunk blocks
    const barContainer = row.querySelector('.chunk-bar-container');
    const maxSamples = Math.max(...seriesInfos.map(s => s.frozenSamples + s.info.hot.count));
    const totalChunksInSeries = si.info.frozen.length + (si.info.hot.count > 0 ? 1 : 0);
    const compact = totalChunksInSeries > 40;
    if (compact) barContainer.classList.add('compact-chunks');

    const isCol = si.info._isColumnStore;
    for (let ci = 0; ci < si.info.frozen.length; ci++) {
      const chunk = si.info.frozen[ci];
      const block = document.createElement('div');
      block.className = isCol ? 'chunk-block frozen column-store' : 'chunk-block frozen';
      if (!compact) {
        const widthPct = Math.max(2, (chunk.count / maxSamples) * 100);
        block.style.width = widthPct + '%';
      }
      block.title = `Chunk ${ci}: ${chunk.count} pts, ${formatBytes(chunk.compressedBytes)}, ${chunk.ratio.toFixed(1)}× compression`;
      if (!compact) block.innerHTML = `<span class="chunk-label">${chunk.count}</span>`;
      block.addEventListener('click', () => showChunkDetail(si, ci, 'frozen', store));
      barContainer.appendChild(block);
    }

    if (si.info.hot.count > 0) {
      const block = document.createElement('div');
      block.className = 'chunk-block hot';
      if (!compact) {
        const widthPct = Math.max(2, (si.info.hot.count / maxSamples) * 100);
        block.style.width = widthPct + '%';
      }
      block.title = `Hot buffer: ${si.info.hot.count} pts, ${formatBytes(si.info.hot.rawBytes)} (uncompressed)`;
      if (!compact) block.innerHTML = `<span class="chunk-label">${si.info.hot.count}</span>`;
      block.addEventListener('click', () => showChunkDetail(si, -1, 'hot', store));
      barContainer.appendChild(block);
    }

    // Compact summary
    if (compact) {
      const summary = document.createElement('div');
      summary.className = 'chunk-summary-bar';
      summary.innerHTML = `<span class="chunk-count-badge">${si.info.frozen.length} frozen</span>` +
        (si.info.hot.count > 0 ? `<span class="chunk-count-badge hot">1 hot (${si.info.hot.count.toLocaleString()} pts)</span>` : '') +
        `<span>Click any block to explore</span>`;
      row.appendChild(summary);
    }

    seriesList.appendChild(row);
  }
}

function showChunkDetail(seriesInfo, chunkIndex, type, store) {
  const panel = $('#chunkDetailPanel');
  panel.style.display = '';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const metricName = seriesInfo.labels.get('__name__') || 'unknown';
  const labelStr = [...seriesInfo.labels]
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');

  if (type === 'frozen') {
    const chunk = seriesInfo.info.frozen[chunkIndex];
    const isColumn = !!chunk.compressedValues; // ColumnStore chunks have compressedValues
    const isChunked = !!chunk.compressed; // ChunkedStore chunks have compressed

    let decoded;
    if (isColumn) {
      const values = wasmDecodeValuesALP(chunk.compressedValues);
      const timestamps = wasmDecodeTimestamps(chunk.tsChunkCompressed);
      decoded = { timestamps, values };
    } else {
      decoded = decodeChunk(chunk.compressed);
    }

    const sparkId = 'sparkline-' + Date.now();
    const codecName = isColumn ? 'ALP' : 'XOR-Delta';

    // Extra stats for ColumnStore
    const columnExtra = isColumn ? `
        <div class="detail-stat">
          <div class="detail-stat-label">Values (ALP)</div>
          <div class="detail-stat-value">${formatBytes(chunk.valuesBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Timestamps (shared)</div>
          <div class="detail-stat-value">${formatBytes(chunk.timestampBytes)} ÷ ${chunk.sharedTsSeries} = ${formatBytes(chunk.amortizedTsBytes)}</div>
        </div>` : '';

    // Byte layout segments differ by codec
    const byteLayoutLegend = isColumn ? `
          <span class="byte-legend-item"><span class="byte-swatch header"></span>ALP header</span>
          <span class="byte-legend-item"><span class="byte-swatch values"></span>ALP-encoded values</span>
          <span class="byte-legend-item"><span class="byte-swatch timestamps"></span>Shared timestamps (amortized)</span>
        ` : `
          <span class="byte-legend-item"><span class="byte-swatch header"></span>Header (ts₀+v₀)</span>
          <span class="byte-legend-item"><span class="byte-swatch timestamps"></span>Timestamp deltas</span>
          <span class="byte-legend-item"><span class="byte-swatch values"></span>XOR values</span>
        `;

    panel.innerHTML = `
      <div class="chunk-detail-header">
        <div class="chunk-detail-title">
          <span class="tag-frozen">Frozen</span> Chunk ${chunkIndex} — ${metricName}
          <span class="chunk-detail-labels">{${labelStr}}</span>
          <span class="tag-codec">${codecName}</span>
        </div>
        <button class="chunk-close" onclick="this.closest('.chunk-detail-panel').style.display='none'">✕</button>
      </div>
      <div class="chunk-detail-grid">
        <div class="detail-stat">
          <div class="detail-stat-label">Samples</div>
          <div class="detail-stat-value">${chunk.count.toLocaleString()}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Time range</div>
          <div class="detail-stat-value detail-stat-small">${formatTimeRange(chunk.minT, chunk.maxT)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Raw size</div>
          <div class="detail-stat-value">${formatBytes(chunk.rawBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Compressed</div>
          <div class="detail-stat-value">${formatBytes(chunk.compressedBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Ratio</div>
          <div class="detail-stat-value ratio-highlight">${chunk.ratio.toFixed(1)}×</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Bits/sample</div>
          <div class="detail-stat-value">${((chunk.compressedBytes * 8) / chunk.count).toFixed(1)}</div>
        </div>
        ${columnExtra}
      </div>
      <div class="chunk-byte-layout">
        <h4>Byte Layout</h4>
        <div class="byte-map" id="byteMap"></div>
        <div class="byte-legend">
          ${byteLayoutLegend}
        </div>
      </div>
      <div class="byte-explorer" id="byteExplorer"></div>
      <div class="chunk-sparkline-container">
        <h4>Decoded Values</h4>
        <canvas id="${sparkId}" width="600" height="120"></canvas>
      </div>`;

    // Render byte map
    if (isColumn) {
      renderByteMapALP(chunk.compressedValues, chunk.tsChunkCompressed, chunk.sharedTsSeries);
      renderByteExplorer(chunk.compressedValues, chunk.tsChunkCompressed, chunk.sharedTsSeries, chunk.count, 'alp');
    } else {
      renderByteMap(chunk.compressed, chunk.count);
      renderByteExplorer(chunk.compressed, null, 0, chunk.count, 'xor');
    }

    // Render sparkline
    requestAnimationFrame(() => renderSparkline(sparkId, decoded));
  } else {
    // Hot chunk
    const hot = seriesInfo.info.hot;
    const sparkId = 'sparkline-' + Date.now();
    const minT = hot.count > 0 ? hot.timestamps[0] : 0n;
    const maxT = hot.count > 0 ? hot.timestamps[hot.count - 1] : 0n;

    panel.innerHTML = `
      <div class="chunk-detail-header">
        <div class="chunk-detail-title">
          <span class="tag-hot">Hot Buffer</span> — ${metricName}
          <span class="chunk-detail-labels">{${labelStr}}</span>
        </div>
        <button class="chunk-close" onclick="this.closest('.chunk-detail-panel').style.display='none'">✕</button>
      </div>
      <div class="chunk-detail-grid">
        <div class="detail-stat">
          <div class="detail-stat-label">Samples</div>
          <div class="detail-stat-value">${hot.count.toLocaleString()}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Time range</div>
          <div class="detail-stat-value detail-stat-small">${hot.count > 0 ? formatTimeRange(minT, maxT) : '—'}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Raw size</div>
          <div class="detail-stat-value">${formatBytes(hot.rawBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Allocated</div>
          <div class="detail-stat-value">${formatBytes(hot.allocatedBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Compression</div>
          <div class="detail-stat-value">None (raw)</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Status</div>
          <div class="detail-stat-value">🔥 Active write</div>
        </div>
      </div>
      <div class="chunk-sparkline-container">
        <h4>Raw Values</h4>
        <canvas id="${sparkId}" width="600" height="120"></canvas>
      </div>`;

    requestAnimationFrame(() => {
      renderSparkline(sparkId, {
        timestamps: hot.timestamps.slice(0, hot.count),
        values: hot.values.slice(0, hot.count),
      });
    });
  }
}

function renderByteMap(compressed, sampleCount) {
  const container = $('#byteMap');
  if (!container) return;

  const totalBytes = compressed.byteLength;
  // Approximate: first 16 bytes = header (ts₀ + v₀), rest alternates ts/val bits
  const headerBytes = Math.min(16, totalBytes);
  const remainingBytes = totalBytes - headerBytes;
  // Rough estimate: timestamps tend to be ~1/4, values ~3/4 of remaining bytes
  const tsDeltaBytes = Math.round(remainingBytes * 0.25);
  const valXorBytes = remainingBytes - tsDeltaBytes;

  const segments = [
    { label: 'Header', bytes: headerBytes, cls: 'header' },
    { label: 'Timestamps', bytes: tsDeltaBytes, cls: 'timestamps' },
    { label: 'XOR Values', bytes: valXorBytes, cls: 'values' },
  ];

  container.innerHTML = segments.map(seg => {
    const pct = Math.max(1, (seg.bytes / totalBytes) * 100);
    return `<div class="byte-segment ${seg.cls}" style="width:${pct}%" title="${seg.label}: ${formatBytes(seg.bytes)}">${seg.bytes > 20 ? formatBytes(seg.bytes) : ''}</div>`;
  }).join('');
}

function renderByteMapALP(compressedValues, compressedTs, sharedCount) {
  const container = $('#byteMap');
  if (!container) return;

  const valBytes = compressedValues.byteLength;
  const tsBytes = compressedTs.byteLength;
  const amortizedTs = Math.round(tsBytes / sharedCount);
  // ALP header is first 4 bytes (count + exponent + factor)
  const headerBytes = Math.min(4, valBytes);
  const alpDataBytes = valBytes - headerBytes;
  const totalBytes = headerBytes + alpDataBytes + amortizedTs;

  const segments = [
    { label: 'ALP Header', bytes: headerBytes, cls: 'header' },
    { label: 'ALP Values', bytes: alpDataBytes, cls: 'values' },
    { label: `Shared Timestamps (÷${sharedCount})`, bytes: amortizedTs, cls: 'timestamps' },
  ];

  container.innerHTML = segments.map(seg => {
    const pct = Math.max(1, (seg.bytes / totalBytes) * 100);
    return `<div class="byte-segment ${seg.cls}" style="width:${pct}%" title="${seg.label}: ${formatBytes(seg.bytes)}">${seg.bytes > 20 ? formatBytes(seg.bytes) : ''}</div>`;
  }).join('');
}

// ── Interactive Byte Explorer ──────────────────────────────────────

function renderByteExplorer(primaryBlob, tsBlob, sharedCount, sampleCount, codec) {
  const explorer = $('#byteExplorer');
  if (!explorer) return;

  // Build a unified byte array with region annotations
  const regions = [];
  let bytes;

  if (codec === 'alp') {
    const valBytes = primaryBlob.byteLength;
    const headerLen = Math.min(4, valBytes);
    const tsLen = tsBlob ? tsBlob.byteLength : 0;
    const amortizedTsLen = sharedCount > 0 ? Math.round(tsLen / sharedCount) : tsLen;

    const totalDisplay = valBytes + amortizedTsLen;
    bytes = new Uint8Array(totalDisplay);
    bytes.set(primaryBlob, 0);
    if (tsBlob && amortizedTsLen > 0) {
      bytes.set(tsBlob.slice(0, amortizedTsLen), valBytes);
    }

    regions.push({
      name: 'ALP Header', cls: 'header', start: 0, end: headerLen,
      decode: function() {
        if (headerLen >= 2) {
          const count = (primaryBlob[0] << 8) | primaryBlob[1];
          return 'Sample count: ' + count + (headerLen >= 3 ? ', exponent: ' + primaryBlob[2] : '') + (headerLen >= 4 ? ', factor: ' + primaryBlob[3] : '');
        }
        return 'Header bytes';
      }
    });
    regions.push({
      name: 'ALP Encoded Values', cls: 'values', start: headerLen, end: valBytes,
      decode: function() {
        const dataLen = valBytes - headerLen;
        return dataLen + ' bytes encoding ' + sampleCount + ' float64 values\n' + (dataLen * 8 / sampleCount).toFixed(1) + ' bits/value';
      }
    });
    if (amortizedTsLen > 0) {
      regions.push({
        name: 'Shared Timestamps (\u00f7' + sharedCount + ')', cls: 'timestamps', start: valBytes, end: totalDisplay,
        decode: function() {
          return formatBytes(tsLen) + ' total shared across ' + sharedCount + ' series\nAmortized: ' + formatBytes(amortizedTsLen) + ' per series';
        }
      });
    }
  } else {
    bytes = primaryBlob;
    const totalBytes = bytes.byteLength;
    const headerLen = Math.min(16, totalBytes);
    const remainingBytes = totalBytes - headerLen;
    const tsDeltaBytes = Math.round(remainingBytes * 0.25);
    const valXorBytes = remainingBytes - tsDeltaBytes;

    regions.push({
      name: 'Header (ts\u2080 + v\u2080)', cls: 'header', start: 0, end: headerLen,
      decode: function() {
        if (headerLen >= 2) {
          var count = (bytes[0] << 8) | bytes[1];
          var info = 'Sample count: ' + count;
          if (headerLen >= 10) info += '\nBase timestamp: first 8 bytes after count';
          if (headerLen >= 16) info += '\nBase value: IEEE-754 float64 (8 bytes)';
          return info;
        }
        return 'Header bytes';
      }
    });
    regions.push({
      name: 'Timestamp Deltas', cls: 'timestamps', start: headerLen, end: headerLen + tsDeltaBytes,
      decode: function() {
        return '~' + tsDeltaBytes + ' bytes of delta-of-delta encoded timestamps\nGorilla-style variable-length bit packing\n' + (tsDeltaBytes * 8 / Math.max(1, sampleCount - 1)).toFixed(1) + ' bits/delta';
      }
    });
    regions.push({
      name: 'XOR-Encoded Values', cls: 'values', start: headerLen + tsDeltaBytes, end: totalBytes,
      decode: function() {
        return '~' + valXorBytes + ' bytes of XOR-delta compressed float64 values\nLeading/trailing zero optimization\n' + (valXorBytes * 8 / Math.max(1, sampleCount - 1)).toFixed(1) + ' bits/value';
      }
    });
  }

  // Region lookup per byte
  const byteRegion = new Uint8Array(bytes.length);
  for (var ri = 0; ri < regions.length; ri++) {
    for (var i = regions[ri].start; i < regions[ri].end; i++) {
      byteRegion[i] = ri;
    }
  }

  var COLS = 32;
  var totalRows = Math.ceil(bytes.length / COLS);
  var viewId = 'hexView-' + Date.now();

  explorer.innerHTML =
    '<div class="byte-explorer-header">' +
      '<h4>\uD83D\uDD2C Byte Explorer <span style="font-weight:400;color:#6b8a9e;font-size:11px">' + formatBytes(bytes.length) + ' \u00b7 ' + bytes.length.toLocaleString() + ' bytes</span></h4>' +
      '<div class="byte-explorer-controls">' +
        '<button class="active" data-view="hex">Hex</button>' +
        '<button data-view="decimal">Dec</button>' +
        '<button data-view="bits">Bits</button>' +
      '</div>' +
    '</div>' +
    '<div class="byte-minimap" id="byteMinimap"></div>' +
    '<div class="hex-grid-scroll" id="' + viewId + '">' +
      '<div class="hex-grid" id="hexGrid" style="grid-template-columns: 56px repeat(' + COLS + ', 1fr) minmax(60px, auto);"></div>' +
    '</div>' +
    '<div id="regionDetail"></div>';

  // Build minimap
  var minimap = explorer.querySelector('#byteMinimap');
  var totalLen = bytes.length;
  regions.forEach(function(r) {
    var seg = document.createElement('div');
    seg.className = 'mm-seg';
    seg.style.width = Math.max(1, ((r.end - r.start) / totalLen) * 100) + '%';
    seg.style.background = r.cls === 'header' ? '#8b5cf6' : r.cls === 'timestamps' ? '#06b6d4' : '#10b981';
    seg.title = r.name + ': ' + formatBytes(r.end - r.start);
    seg.addEventListener('click', function() {
      var targetRow = Math.floor(r.start / COLS);
      var gridEl = explorer.querySelector('.hex-grid-scroll');
      var rowEls = gridEl.querySelectorAll('.hex-offset');
      if (rowEls[targetRow]) rowEls[targetRow].scrollIntoView({ behavior: 'smooth', block: 'start' });
      showRegionDetail(r);
    });
    minimap.appendChild(seg);
  });

  // Viewport indicator
  var viewport = document.createElement('div');
  viewport.className = 'mm-viewport';
  minimap.appendChild(viewport);

  // Build hex grid
  var grid = explorer.querySelector('#hexGrid');
  var scrollContainer = explorer.querySelector('.hex-grid-scroll');
  var MAX_INITIAL_ROWS = Math.min(totalRows, 100);

  for (var row = 0; row < MAX_INITIAL_ROWS; row++) {
    renderHexRow(grid, row, COLS, bytes, byteRegion, regions, 'hex');
  }

  // Lazy render remaining rows on scroll
  var renderedRows = MAX_INITIAL_ROWS;
  if (totalRows > MAX_INITIAL_ROWS) {
    var sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    sentinel.style.gridColumn = '1 / -1';
    grid.appendChild(sentinel);

    scrollContainer.addEventListener('scroll', function lazyLoad() {
      var sRect = sentinel.getBoundingClientRect();
      var cRect = scrollContainer.getBoundingClientRect();
      if (sRect.top < cRect.bottom + 200 && renderedRows < totalRows) {
        var batch = Math.min(50, totalRows - renderedRows);
        grid.removeChild(sentinel);
        for (var r = renderedRows; r < renderedRows + batch; r++) {
          renderHexRow(grid, r, COLS, bytes, byteRegion, regions, 'hex');
        }
        renderedRows += batch;
        if (renderedRows < totalRows) grid.appendChild(sentinel);
      }
    });
  }

  // Update viewport indicator on scroll
  scrollContainer.addEventListener('scroll', function() {
    var scrollFraction = scrollContainer.scrollTop / Math.max(1, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    var vf = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
    viewport.style.left = (scrollFraction * (1 - vf) * 100) + '%';
    viewport.style.width = Math.max(3, vf * 100) + '%';
  });
  var initVF = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
  viewport.style.left = '0%';
  viewport.style.width = Math.max(3, initVF * 100) + '%';

  // View mode switcher
  var buttons = explorer.querySelectorAll('.byte-explorer-controls button');
  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      buttons.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var mode = btn.dataset.view;

      if (mode === 'bits') {
        renderBitView(explorer, bytes, byteRegion, regions, sampleCount, codec);
      } else {
        var bitView = explorer.querySelector('.bit-view');
        if (bitView) bitView.remove();
        scrollContainer.style.display = '';
        grid.innerHTML = '';
        renderedRows = 0;
        var batchSize = Math.min(totalRows, 100);
        for (var r = 0; r < batchSize; r++) {
          renderHexRow(grid, r, COLS, bytes, byteRegion, regions, mode);
        }
        renderedRows = batchSize;
      }
    });
  });

  // Tooltip
  var tooltip = document.querySelector('.byte-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'byte-tooltip';
    document.body.appendChild(tooltip);
  }

  grid.addEventListener('mouseover', function(e) {
    var cell = e.target.closest('.hex-cell');
    if (!cell) { tooltip.classList.remove('visible'); return; }
    var offset = parseInt(cell.dataset.offset);
    if (isNaN(offset)) return;
    var val = bytes[offset];
    var rIdx = byteRegion[offset];
    var region = regions[rIdx];
    tooltip.innerHTML =
      '<span class="bt-offset">offset ' + offset + '</span> &nbsp;' +
      '<span class="bt-hex">0x' + val.toString(16).toUpperCase().padStart(2, '0') + '</span>' +
      '<span style="color:#94a3b8"> = ' + val + '</span>' +
      '<span class="bt-region ' + region.cls + '">' + region.name + '</span>' +
      '<div class="bt-decoded">' + (region.cls === 'header' ? 'Metadata / encoding parameters' : region.cls === 'timestamps' ? 'Temporal encoding' : 'Value encoding') + '</div>';
    tooltip.classList.add('visible');
  });

  grid.addEventListener('mousemove', function(e) {
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top = (e.clientY - 40) + 'px';
  });

  grid.addEventListener('mouseleave', function() {
    tooltip.classList.remove('visible');
  });

  // Click a cell to show region detail
  grid.addEventListener('click', function(e) {
    var cell = e.target.closest('.hex-cell');
    if (!cell) return;
    var offset = parseInt(cell.dataset.offset);
    if (isNaN(offset)) return;
    var rIdx = byteRegion[offset];
    showRegionDetail(regions[rIdx]);
    grid.querySelectorAll('.hex-cell.highlighted').forEach(function(c) { c.classList.remove('highlighted'); });
    grid.querySelectorAll('.hex-cell[data-region="' + rIdx + '"]').forEach(function(c) { c.classList.add('highlighted'); });
  });

  function showRegionDetail(region) {
    var detail = explorer.querySelector('#regionDetail');
    detail.innerHTML =
      '<div class="region-detail-card">' +
        '<h5><span class="region-badge ' + region.cls + '">' + region.name + '</span> ' + formatBytes(region.end - region.start) + ' \u00b7 bytes ' + region.start + '\u2013' + (region.end - 1) + '</h5>' +
        '<div class="region-detail-grid">' +
          '<div class="rd-item"><div class="rd-label">Offset</div><div class="rd-value">' + region.start + '</div></div>' +
          '<div class="rd-item"><div class="rd-label">Length</div><div class="rd-value">' + (region.end - region.start) + '</div></div>' +
          '<div class="rd-item"><div class="rd-label">% of total</div><div class="rd-value">' + ((region.end - region.start) / bytes.length * 100).toFixed(1) + '%</div></div>' +
        '</div>' +
        '<div style="margin-top:8px;font-size:11px;color:#6b8a9e;white-space:pre-line;line-height:1.5;font-family:\'IBM Plex Mono\',monospace">' + region.decode() + '</div>' +
      '</div>';
  }
}

function renderHexRow(grid, row, cols, bytes, byteRegion, regions, mode) {
  var startOffset = row * cols;

  var offsetEl = document.createElement('div');
  offsetEl.className = 'hex-offset';
  offsetEl.textContent = '0x' + startOffset.toString(16).toUpperCase().padStart(4, '0');
  grid.appendChild(offsetEl);

  var asciiStr = '';
  for (var col = 0; col < cols; col++) {
    var byteIdx = startOffset + col;
    var cell = document.createElement('div');
    cell.className = 'hex-cell';

    if (byteIdx < bytes.length) {
      var val = bytes[byteIdx];
      var rIdx = byteRegion[byteIdx];
      cell.classList.add('region-' + regions[rIdx].cls);
      cell.dataset.offset = byteIdx;
      cell.dataset.region = rIdx;

      if (mode === 'hex') {
        cell.textContent = val.toString(16).toUpperCase().padStart(2, '0');
      } else {
        cell.textContent = val.toString().padStart(3, ' ');
        cell.style.fontSize = '8px';
      }
      asciiStr += (val >= 32 && val <= 126) ? String.fromCharCode(val) : '\u00b7';
    } else {
      cell.classList.add('region-padding');
      cell.textContent = '  ';
      asciiStr += ' ';
    }

    grid.appendChild(cell);
  }

  var asciiEl = document.createElement('div');
  asciiEl.className = 'hex-ascii';
  asciiEl.textContent = asciiStr;
  grid.appendChild(asciiEl);
}

function renderBitView(explorer, bytes, byteRegion, regions, sampleCount, codec) {
  var scrollContainer = explorer.querySelector('.hex-grid-scroll');
  scrollContainer.style.display = 'none';

  var existing = explorer.querySelector('.bit-view');
  if (existing) existing.remove();

  var container = document.createElement('div');
  container.className = 'bit-view';

  var maxBits = Math.min(bytes.length * 8, 2048);
  var truncated = bytes.length * 8 > maxBits;

  regions.forEach(function(region) {
    var regionHeader = document.createElement('div');
    regionHeader.style.cssText = 'margin:6px 0 4px;font-weight:700;font-size:11px;color:#f59e0b;';
    regionHeader.textContent = '\u2500\u2500 ' + region.name + ' (bytes ' + region.start + '\u2013' + (region.end - 1) + ') \u2500\u2500';
    container.appendChild(regionHeader);

    var regionBytes = bytes.slice(region.start, Math.min(region.end, Math.ceil(maxBits / 8)));
    var bitsPerRow = 64;

    for (var rowStart = 0; rowStart < regionBytes.length * 8; rowStart += bitsPerRow) {
      var rowEl = document.createElement('div');
      rowEl.className = 'bit-row';

      var label = document.createElement('span');
      label.className = 'bit-sample-label';
      label.textContent = 'b' + (region.start * 8 + rowStart);
      rowEl.appendChild(label);

      var rowEnd = Math.min(rowStart + bitsPerRow, regionBytes.length * 8);
      for (var b = rowStart; b < rowEnd; b++) {
        var byteOff = Math.floor(b / 8);
        var bitOff = 7 - (b % 8);
        var bitVal = (regionBytes[byteOff] >> bitOff) & 1;

        var bitEl = document.createElement('span');
        bitEl.className = 'bit ' + (bitVal ? 'b1' : 'b0');
        bitEl.textContent = bitVal;
        rowEl.appendChild(bitEl);

        if ((b + 1) % 8 === 0 && b + 1 < rowEnd) {
          var sep = document.createElement('span');
          sep.style.cssText = 'width:4px;';
          rowEl.appendChild(sep);
        }
      }

      container.appendChild(rowEl);
    }

    if (region.end * 8 > maxBits) return;
  });

  if (truncated) {
    var note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;color:#94a3b8;font-size:10px;';
    note.textContent = 'Showing first ' + maxBits + ' of ' + (bytes.length * 8) + ' bits...';
    container.appendChild(note);
  }

  explorer.querySelector('#regionDetail').before(container);
}

function renderSparkline(canvasId, decoded) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || decoded.values.length === 0) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.min(rect.width - 32, 600);
  const h = 100;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  const vals = decoded.values;
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] < minV) minV = vals[i];
    if (vals[i] > maxV) maxV = vals[i];
  }
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const vRange = maxV - minV;

  const pad = { left: 4, right: 4, top: 8, bottom: 8 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Background
  ctx.fillStyle = '#f8fcff';
  ctx.fillRect(0, 0, w, h);

  // Gradient area
  const gradient = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
  gradient.addColorStop(0, 'rgba(59, 130, 246, 0.15)');
  gradient.addColorStop(1, 'rgba(59, 130, 246, 0.02)');

  ctx.beginPath();
  const step = Math.max(1, Math.floor(vals.length / plotW));
  let firstX;
  for (let i = 0; i < vals.length; i += step) {
    const x = pad.left + (i / (vals.length - 1)) * plotW;
    const y = pad.top + ((maxV - vals[i]) / vRange) * plotH;
    if (i === 0) { ctx.moveTo(x, y); firstX = x; }
    else ctx.lineTo(x, y);
  }
  const lastI = vals.length - 1;
  const lastX = pad.left + plotW;
  ctx.lineTo(lastX, pad.top + plotH);
  ctx.lineTo(firstX, pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.beginPath();
  for (let i = 0; i < vals.length; i += step) {
    const x = pad.left + (i / (vals.length - 1)) * plotW;
    const y = pad.top + ((maxV - vals[i]) / vRange) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// Load WASM codec eagerly, then auto-generate demo data
loadWasm().then(ok => {
  const statusEl = $('#wasmStatus');
  if (ok) {
    statusEl.style.display = 'inline-block';
    statusEl.className = 'wasm-status wasm-ok';
    statusEl.textContent = '✓ WASM loaded (26 KB)';
  } else {
    statusEl.style.display = 'inline-block';
    statusEl.className = 'wasm-status wasm-err';
    statusEl.textContent = '✗ WASM unavailable';
    // Disable ColumnStore option
    const colOpt = document.querySelector('#backend option[value="column"]');
    if (colOpt) { colOpt.disabled = true; colOpt.textContent += ' (WASM required)'; }
  }

  // Auto-generate demo data
  requestAnimationFrame(() => {
    setTimeout(() => {
      generateData(
        parseInt($('#numSeries').value),
        parseInt($('#numPoints').value),
        $('#dataPattern').value,
        $('#backend').value,
        parseInt($('#sampleInterval').value),
      );
    }, 100);
  });
});
