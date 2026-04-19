// ── Storage Backends ─────────────────────────────────────────────────

import { decodeChunk, encodeChunk } from "./codec.js";
import { lowerBound, makeLabelKey, upperBound } from "./utils.js";
import {
  wasmDecodeTimestamps,
  wasmDecodeValuesALP,
  wasmEncodeTimestamps,
  wasmEncodeValuesALP,
} from "./wasm.js";

// ── Shared helpers ───────────────────────────────────────────────────

function _findExistingSeriesId(labelsList, key) {
  for (let i = 0; i < labelsList.length; i++) {
    if (makeLabelKey(labelsList[i]) === key) return i;
  }
  return -1;
}

function _registerLabels(id, labels, labelsList, postings) {
  labelsList.push(new Map(labels));
  for (const [k, v] of labels) {
    const pk = `${k}\0${v}`;
    if (!postings.has(pk)) postings.set(pk, []);
    postings.get(pk).push(id);
  }
}

// ── FlatStore ────────────────────────────────────────────────────────

export class FlatStore {
  constructor() {
    this.name = "FlatStore";
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._labelKeyMap = new Map();
    this._sampleCount = 0;
  }
  get seriesCount() {
    return this._series.length;
  }
  get sampleCount() {
    return this._sampleCount;
  }

  getOrCreateSeries(labels) {
    const key = makeLabelKey(labels);
    const cached = this._labelKeyMap.get(key);
    if (cached !== undefined) return cached;
    const existing = _findExistingSeriesId(this._labels, key);
    if (existing >= 0) {
      this._labelKeyMap.set(key, existing);
      return existing;
    }
    const id = this._series.length;
    this._series.push({
      timestamps: new BigInt64Array(128),
      values: new Float64Array(128),
      count: 0,
    });
    _registerLabels(id, labels, this._labels, this._postings);
    this._labelKeyMap.set(key, id);
    return id;
  }

  appendBatch(id, timestamps, values) {
    const s = this._series[id];
    const need = s.count + timestamps.length;
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

  labels(id) {
    return this._labels[id];
  }

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

export class ChunkedStore {
  constructor(chunkSize = 640) {
    this.name = "ChunkedStore";
    this.chunkSize = chunkSize;
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._labelKeyMap = new Map();
    this._sampleCount = 0;
  }
  get seriesCount() {
    return this._series.length;
  }
  get sampleCount() {
    return this._sampleCount;
  }

  getOrCreateSeries(labels) {
    const key = makeLabelKey(labels);
    const cached = this._labelKeyMap.get(key);
    if (cached !== undefined) return cached;
    const existing = _findExistingSeriesId(this._labels, key);
    if (existing >= 0) {
      this._labelKeyMap.set(key, existing);
      return existing;
    }
    const id = this._series.length;
    this._series.push({
      hot: {
        timestamps: new BigInt64Array(this.chunkSize),
        values: new Float64Array(this.chunkSize),
        count: 0,
      },
      frozen: [],
    });
    _registerLabels(id, labels, this._labels, this._postings);
    this._labelKeyMap.set(key, id);
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
      if (hi > lo)
        parts.push({
          timestamps: decoded.timestamps.slice(lo, hi),
          values: decoded.values.slice(lo, hi),
        });
    }
    if (s.hot.count > 0) {
      const lo = lowerBound(s.hot.timestamps, start, 0, s.hot.count);
      const hi = upperBound(s.hot.timestamps, end, lo, s.hot.count);
      if (hi > lo)
        parts.push({
          timestamps: s.hot.timestamps.slice(lo, hi),
          values: s.hot.values.slice(lo, hi),
        });
    }
    if (parts.length === 0)
      return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (parts.length === 1) return parts[0];
    const totalLen = parts.reduce((s, p) => s + p.timestamps.length, 0);
    const ts = new BigInt64Array(totalLen);
    const vs = new Float64Array(totalLen);
    let off = 0;
    for (const p of parts) {
      ts.set(p.timestamps, off);
      vs.set(p.values, off);
      off += p.timestamps.length;
    }
    return { timestamps: ts, values: vs };
  }

  labels(id) {
    return this._labels[id];
  }

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

// ── ColumnStore (ALP + shared timestamps) ────────────────────────────

export class ColumnStore {
  constructor(chunkSize = 640) {
    this.name = "ColumnStore (ALP)";
    this.chunkSize = chunkSize;
    this._allSeries = [];
    this._groups = [];
    this._labels = [];
    this._postings = new Map();
    this._labelKeyMap = new Map();
    this._sampleCount = 0;
  }

  get seriesCount() {
    return this._allSeries.length;
  }
  get sampleCount() {
    return this._sampleCount;
  }

  getOrCreateSeries(labels) {
    const key = makeLabelKey(labels);
    const cached = this._labelKeyMap.get(key);
    if (cached !== undefined) return cached;
    const existing = _findExistingSeriesId(this._labels, key);
    if (existing >= 0) {
      this._labelKeyMap.set(key, existing);
      return existing;
    }
    const id = this._allSeries.length;

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

    _registerLabels(id, labels, this._labels, this._postings);
    this._labelKeyMap.set(key, id);
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

      const ts = group.hotTimestamps.slice(chunkStart, chunkStart + this.chunkSize);
      const tsChunkIndex = group.frozenTimestamps.length;
      const compressedTs = wasmEncodeTimestamps(ts);
      group.frozenTimestamps.push({
        compressed: compressedTs,
        timestamps: null,
        minT: ts[0],
        maxT: ts[this.chunkSize - 1],
        count: this.chunkSize,
      });

      for (const memberId of group.members) {
        const s = this._allSeries[memberId];
        const vals = s.hot.values.subarray(chunkStart, chunkStart + this.chunkSize);
        const compressedValues = wasmEncodeValuesALP(vals);
        s.frozen.push({ compressedValues, tsChunkIndex, count: this.chunkSize });
      }
    }

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

    if (parts.length === 0)
      return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (parts.length === 1) return parts[0];
    const totalLen = parts.reduce((s, p) => s + p.timestamps.length, 0);
    const ts = new BigInt64Array(totalLen);
    const vs = new Float64Array(totalLen);
    let off = 0;
    for (const p of parts) {
      ts.set(p.timestamps, off);
      vs.set(p.values, off);
      off += p.timestamps.length;
    }
    return { timestamps: ts, values: vs };
  }

  labels(id) {
    return this._labels[id];
  }

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
        allocatedBytes:
          s.hot.values.byteLength +
          group.hotTimestamps.byteLength / Math.max(1, group.members.length),
        timestamps: group.hotTimestamps,
        values: s.hot.values,
      },
      _isColumnStore: true,
      _groupMembers: group.members.length,
      _sharedTsChunks: group.frozenTimestamps.length,
      _sharedTsTotalBytes: group.frozenTimestamps.reduce(
        (s, tc) => s + tc.compressed.byteLength,
        0
      ),
    };
  }
}
