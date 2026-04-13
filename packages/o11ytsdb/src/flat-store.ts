/**
 * Flat array storage — baseline with zero compression.
 *
 * Each series stores raw BigInt64Array + Float64Array that grow by
 * doubling. No encoding overhead on write, no decoding overhead on
 * read. Memory usage is 16 bytes/sample (8 timestamp + 8 value).
 *
 * This is the "what if we just stored everything in TypedArrays"
 * baseline. Everything else should beat it on memory.
 */

import type { Labels, SeriesId, StorageBackend, TimeRange } from './types.js';

interface FlatSeries {
  labels: Labels;
  timestamps: BigInt64Array;
  values: Float64Array;
  count: number;
}

export class FlatStore implements StorageBackend {
  readonly name: string;

  private series: FlatSeries[] = [];
  private labelIndex = new Map<string, SeriesId[]>(); // "label\0value" → ids
  private labelHashToIds = new Map<string, SeriesId>(); // hash(labels) → id
  private _sampleCount = 0;

  constructor(name = 'flat') {
    this.name = name;
  }

  // ── Ingest ──

  getOrCreateSeries(labels: Labels): SeriesId {
    const key = seriesKey(labels);
    const existing = this.labelHashToIds.get(key);
    if (existing !== undefined) return existing;

    const id = this.series.length;
    this.series.push({
      labels,
      timestamps: new BigInt64Array(128),
      values: new Float64Array(128),
      count: 0,
    });
    this.labelHashToIds.set(key, id);

    // Update label index.
    for (const [k, v] of labels) {
      const indexKey = `${k}\0${v}`;
      let ids = this.labelIndex.get(indexKey);
      if (!ids) { ids = []; this.labelIndex.set(indexKey, ids); }
      ids.push(id);
    }
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    const s = this.series[id]!;
    if (s.count === s.timestamps.length) {
      this.grow(s);
    }
    s.timestamps[s.count] = timestamp;
    s.values[s.count] = value;
    s.count++;
    this._sampleCount++;
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    const s = this.series[id]!;
    const need = s.count + timestamps.length;
    while (need > s.timestamps.length) {
      this.grow(s);
    }
    s.timestamps.set(timestamps, s.count);
    s.values.set(values, s.count);
    s.count += timestamps.length;
    this._sampleCount += timestamps.length;
  }

  // ── Query ──

  matchLabel(label: string, value: string): SeriesId[] {
    return this.labelIndex.get(`${label}\0${value}`) ?? [];
  }

  read(id: SeriesId, start: bigint, end: bigint): TimeRange {
    const s = this.series[id]!;
    const lo = lowerBound(s.timestamps, start, 0, s.count);
    const hi = upperBound(s.timestamps, end, lo, s.count);
    return {
      timestamps: s.timestamps.slice(lo, hi),
      values: s.values.slice(lo, hi),
    };
  }

  labels(id: SeriesId): Labels | undefined {
    return this.series[id]?.labels;
  }

  // ── Stats ──

  get seriesCount(): number { return this.series.length; }
  get sampleCount(): number { return this._sampleCount; }

  memoryBytes(): number {
    let bytes = 0;
    for (const s of this.series) {
      // Actual buffer sizes (may be larger than count due to growth).
      bytes += s.timestamps.byteLength + s.values.byteLength;
      // Approximate label storage overhead.
      bytes += 100;
    }
    return bytes;
  }

  // ── Internal ──

  private grow(s: FlatSeries): void {
    const newLen = s.timestamps.length * 2;
    const newTs = new BigInt64Array(newLen);
    const newVals = new Float64Array(newLen);
    newTs.set(s.timestamps.subarray(0, s.count));
    newVals.set(s.values.subarray(0, s.count));
    s.timestamps = newTs;
    s.values = newVals;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function seriesKey(labels: Labels): string {
  // Sort for stability.
  const entries = [...labels.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

function lowerBound(arr: BigInt64Array, target: bigint, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr: BigInt64Array, target: bigint, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
