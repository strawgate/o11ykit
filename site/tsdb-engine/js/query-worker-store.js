import { decodeChunk } from "./codec.js";
import { lowerBound, upperBound } from "./utils.js";
import { loadWasm, wasmDecodeTimestamps, wasmDecodeValuesALP, wasmReady } from "./wasm.js";

const MAX_I64 = 9223372036854775807n;

function collectPosting(postings, labels, id) {
  for (const [key, value] of labels) {
    const postingKey = `${key}\0${value}`;
    if (!postings.has(postingKey)) postings.set(postingKey, []);
    postings.get(postingKey).push(id);
  }
}

function pushTransferables(transfer, seenBuffers, ...views) {
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  for (const view of views) {
    if (!view) continue;
    if (hasSharedArrayBuffer && view.buffer instanceof SharedArrayBuffer) continue;
    if (seenBuffers.has(view.buffer)) continue;
    seenBuffers.add(view.buffer);
    transfer.push(view.buffer);
  }
}

function cloneHotRange(hot) {
  if (!hot || hot.count <= 0 || !hot.timestamps || !hot.values) return null;
  return {
    count: hot.count,
    timestamps: hot.timestamps.slice(0),
    values: hot.values.slice(0),
  };
}

function materializeWorkerView(view, cloneCache) {
  if (!view) return view;
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  if (hasSharedArrayBuffer && view.buffer instanceof SharedArrayBuffer) return view;
  const cached = cloneCache.get(view);
  if (cached) return cached;
  const cloned = view.slice(0);
  cloneCache.set(view, cloned);
  return cloned;
}

function snapshotKind(store, chunkInfo) {
  if (chunkInfo?._isColumnStore || store?._backendType === "column") return "column";
  if (chunkInfo?.frozen?.[0]?.compressed || store?._backendType === "chunked") return "chunked";
  return "raw";
}

function buildRawSeriesSnapshot(store, id, labels) {
  const data = store.read(id, -MAX_I64, MAX_I64);
  return {
    labels: [...labels.entries()],
    timestamps: data.timestamps,
    values: data.values,
  };
}

function buildChunkedSeriesSnapshot(labels, chunkInfo, cloneCache) {
  return {
    labels: [...labels.entries()],
    frozen: chunkInfo.frozen.map((chunk) => ({
      minT: chunk.minT,
      maxT: chunk.maxT,
      count: chunk.count,
      compressed: materializeWorkerView(chunk.compressed, cloneCache),
    })),
    hot: cloneHotRange(chunkInfo.hot),
  };
}

function buildColumnSeriesSnapshot(labels, chunkInfo, cloneCache) {
  return {
    labels: [...labels.entries()],
    frozen: chunkInfo.frozen.map((chunk) => ({
      minT: chunk.minT,
      maxT: chunk.maxT,
      count: chunk.count,
      compressedValues: materializeWorkerView(chunk.compressedValues, cloneCache),
      compressedTimestamps: materializeWorkerView(chunk.tsChunkCompressed, cloneCache),
    })),
    hot: cloneHotRange(chunkInfo.hot),
  };
}

export function buildWorkerPartitionPayload(store, ids) {
  const series = [];
  const transfer = [];
  const seenBuffers = new Set();
  const cloneCache = new Map();
  let kind = "raw";
  let mixedKinds = false;

  for (const id of ids) {
    const labels = store.labels(id);
    if (!labels) continue;

    const chunkInfo = typeof store.getChunkInfo === "function" ? store.getChunkInfo(id) : null;
    const entryKind = snapshotKind(store, chunkInfo);
    if (series.length === 0) kind = entryKind;
    else if (entryKind !== kind) mixedKinds = true;

    if (entryKind === "column" && chunkInfo) {
      const entry = buildColumnSeriesSnapshot(labels, chunkInfo, cloneCache);
      for (const chunk of entry.frozen) {
        pushTransferables(
          transfer,
          seenBuffers,
          chunk.compressedValues,
          chunk.compressedTimestamps
        );
      }
      if (entry.hot)
        pushTransferables(transfer, seenBuffers, entry.hot.timestamps, entry.hot.values);
      series.push(entry);
      continue;
    }

    if (entryKind === "chunked" && chunkInfo) {
      const entry = buildChunkedSeriesSnapshot(labels, chunkInfo, cloneCache);
      for (const chunk of entry.frozen) {
        pushTransferables(transfer, seenBuffers, chunk.compressed);
      }
      if (entry.hot)
        pushTransferables(transfer, seenBuffers, entry.hot.timestamps, entry.hot.values);
      series.push(entry);
      continue;
    }

    const entry = buildRawSeriesSnapshot(store, id, labels);
    pushTransferables(transfer, seenBuffers, entry.timestamps, entry.values);
    series.push(entry);
  }

  if (mixedKinds) {
    throw new Error(
      `Worker partition payload contains mixed snapshot kinds; expected ${kind} for all entries`
    );
  }

  return { kind, series, transfer };
}

class RawPartitionStore {
  constructor() {
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;
  }

  loadSeries(entries) {
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;

    for (const entry of entries) {
      const id = this._series.length;
      const labels = new Map(entry.labels);
      this._series.push({
        timestamps: entry.timestamps,
        values: entry.values,
      });
      this._labels.push(labels);
      this._sampleCount += entry.timestamps.length;
      collectPosting(this._postings, labels, id);
    }
  }

  get seriesCount() {
    return this._series.length;
  }

  get sampleCount() {
    return this._sampleCount;
  }

  matchLabel(label, value) {
    return this._postings.get(`${label}\0${value}`) ?? [];
  }

  read(id, start, end) {
    const series = this._series[id];
    const lo = lowerBound(series.timestamps, start, 0, series.timestamps.length);
    const hi = upperBound(series.timestamps, end, lo, series.timestamps.length);
    return {
      timestamps: series.timestamps.slice(lo, hi),
      values: series.values.slice(lo, hi),
    };
  }

  labels(id) {
    return this._labels[id];
  }

  appendBatch(id, timestamps, values, labels = null) {
    if (timestamps.length !== values.length) {
      throw new Error(
        `appendBatch: timestamps.length (${timestamps.length}) !== values.length (${values.length})`
      );
    }
    let series = this._series[id];
    if (!series) {
      if (!labels) return;
      this._series[id] = { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
      this._labels[id] = labels;
      collectPosting(this._postings, labels, id);
      series = this._series[id];
    }
    const totalLen = series.timestamps.length + timestamps.length;
    const newTimestamps = new BigInt64Array(totalLen);
    const newValues = new Float64Array(totalLen);
    newTimestamps.set(series.timestamps);
    newTimestamps.set(timestamps, series.timestamps.length);
    newValues.set(series.values);
    newValues.set(values, series.values.length);
    series.timestamps = newTimestamps;
    series.values = newValues;
    this._sampleCount += timestamps.length;
  }
}

class ChunkedPartitionStore {
  constructor() {
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;
  }

  loadSeries(entries) {
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;

    for (const entry of entries) {
      const id = this._series.length;
      const labels = new Map(entry.labels);
      const frozen = entry.frozen.map((chunk) => ({
        ...chunk,
      }));
      const hot = entry.hot
        ? {
            count: entry.hot.count,
            timestamps: entry.hot.timestamps,
            values: entry.hot.values,
          }
        : null;
      this._series.push({ frozen, hot });
      this._labels.push(labels);
      this._sampleCount += frozen.reduce((sum, chunk) => sum + chunk.count, 0) + (hot?.count || 0);
      collectPosting(this._postings, labels, id);
    }
  }

  get seriesCount() {
    return this._series.length;
  }

  get sampleCount() {
    return this._sampleCount;
  }

  matchLabel(label, value) {
    return this._postings.get(`${label}\0${value}`) ?? [];
  }

  read(id, start, end) {
    const series = this._series[id];
    const parts = [];

    for (const chunk of series.frozen) {
      if (chunk.maxT < start || chunk.minT > end) continue;
      const decoded = decodeChunk(chunk.compressed);
      const lo = lowerBound(decoded.timestamps, start, 0, decoded.timestamps.length);
      const hi = upperBound(decoded.timestamps, end, lo, decoded.timestamps.length);
      if (hi > lo) {
        parts.push({
          timestamps: decoded.timestamps.slice(lo, hi),
          values: decoded.values.slice(lo, hi),
        });
      }
    }

    if (series.hot?.count) {
      const lo = lowerBound(series.hot.timestamps, start, 0, series.hot.count);
      const hi = upperBound(series.hot.timestamps, end, lo, series.hot.count);
      if (hi > lo) {
        parts.push({
          timestamps: series.hot.timestamps.slice(lo, hi),
          values: series.hot.values.slice(lo, hi),
        });
      }
    }

    if (parts.length === 0)
      return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (parts.length === 1) return parts[0];

    const totalLen = parts.reduce((sum, part) => sum + part.timestamps.length, 0);
    const timestamps = new BigInt64Array(totalLen);
    const values = new Float64Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      timestamps.set(part.timestamps, offset);
      values.set(part.values, offset);
      offset += part.timestamps.length;
    }
    return { timestamps, values };
  }

  labels(id) {
    return this._labels[id];
  }

  appendBatch(id, timestamps, values, labels = null) {
    if (timestamps.length !== values.length) {
      throw new Error(
        `appendBatch: timestamps.length (${timestamps.length}) !== values.length (${values.length})`
      );
    }
    let series = this._series[id];
    if (!series) {
      if (!labels) return;
      this._series[id] = { frozen: [], hot: null };
      this._labels[id] = labels;
      collectPosting(this._postings, labels, id);
      series = this._series[id];
    }
    if (!series.hot) {
      series.hot = {
        count: values.length,
        timestamps: timestamps.slice(0),
        values: values.slice(0),
      };
    } else {
      const totalLen = series.hot.count + values.length;
      const newTs = new BigInt64Array(totalLen);
      const newVs = new Float64Array(totalLen);
      newTs.set(series.hot.timestamps.subarray(0, series.hot.count));
      newTs.set(timestamps, series.hot.count);
      newVs.set(series.hot.values.subarray(0, series.hot.count));
      newVs.set(values, series.hot.count);
      series.hot.timestamps = newTs;
      series.hot.values = newVs;
      series.hot.count = totalLen;
    }
    this._sampleCount += values.length;
  }
}

class ColumnPartitionStore {
  constructor() {
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;
  }

  loadSeries(entries) {
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;

    for (const entry of entries) {
      const id = this._series.length;
      const labels = new Map(entry.labels);
      const frozen = entry.frozen.map((chunk) => ({
        ...chunk,
      }));
      const hot = entry.hot
        ? {
            count: entry.hot.count,
            timestamps: entry.hot.timestamps,
            values: entry.hot.values,
          }
        : null;
      this._series.push({ frozen, hot });
      this._labels.push(labels);
      this._sampleCount += frozen.reduce((sum, chunk) => sum + chunk.count, 0) + (hot?.count || 0);
      collectPosting(this._postings, labels, id);
    }
  }

  get seriesCount() {
    return this._series.length;
  }

  get sampleCount() {
    return this._sampleCount;
  }

  matchLabel(label, value) {
    return this._postings.get(`${label}\0${value}`) ?? [];
  }

  read(id, start, end) {
    const series = this._series[id];
    const parts = [];

    for (const chunk of series.frozen) {
      if (chunk.maxT < start || chunk.minT > end) continue;
      const timestamps = wasmDecodeTimestamps(chunk.compressedTimestamps);
      const values = wasmDecodeValuesALP(chunk.compressedValues);
      const lo = lowerBound(timestamps, start, 0, chunk.count);
      const hi = upperBound(timestamps, end, lo, chunk.count);
      if (hi > lo) {
        parts.push({
          timestamps: timestamps.slice(lo, hi),
          values: values.slice(lo, hi),
        });
      }
    }

    if (series.hot?.count) {
      const lo = lowerBound(series.hot.timestamps, start, 0, series.hot.count);
      const hi = upperBound(series.hot.timestamps, end, lo, series.hot.count);
      if (hi > lo) {
        parts.push({
          timestamps: series.hot.timestamps.slice(lo, hi),
          values: series.hot.values.slice(lo, hi),
        });
      }
    }

    if (parts.length === 0)
      return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (parts.length === 1) return parts[0];

    const totalLen = parts.reduce((sum, part) => sum + part.timestamps.length, 0);
    const timestamps = new BigInt64Array(totalLen);
    const values = new Float64Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      timestamps.set(part.timestamps, offset);
      values.set(part.values, offset);
      offset += part.timestamps.length;
    }
    return { timestamps, values };
  }

  labels(id) {
    return this._labels[id];
  }

  appendBatch(id, timestamps, values, labels = null) {
    if (timestamps.length !== values.length) {
      throw new Error(
        `appendBatch: timestamps.length (${timestamps.length}) !== values.length (${values.length})`
      );
    }
    let series = this._series[id];
    if (!series) {
      if (!labels) return;
      this._series[id] = { frozen: [], hot: null };
      this._labels[id] = labels;
      collectPosting(this._postings, labels, id);
      series = this._series[id];
    }
    if (!series.hot) {
      series.hot = {
        count: values.length,
        timestamps: timestamps.slice(0),
        values: values.slice(0),
      };
    } else {
      const totalLen = series.hot.count + values.length;
      const newTs = new BigInt64Array(totalLen);
      const newVs = new Float64Array(totalLen);
      newTs.set(series.hot.timestamps.subarray(0, series.hot.count));
      newTs.set(timestamps, series.hot.count);
      newVs.set(series.hot.values.subarray(0, series.hot.count));
      newVs.set(values, series.hot.count);
      series.hot.timestamps = newTs;
      series.hot.values = newVs;
      series.hot.count = totalLen;
    }
    this._sampleCount += values.length;
  }
}

export async function createWorkerSnapshotStore(kind) {
  if (kind === "column" && !wasmReady) {
    const ok = await loadWasm();
    if (!ok) throw new Error("WASM decoder unavailable for column snapshot worker store");
  }

  if (kind === "column") return new ColumnPartitionStore();
  if (kind === "chunked") return new ChunkedPartitionStore();
  return new RawPartitionStore();
}
