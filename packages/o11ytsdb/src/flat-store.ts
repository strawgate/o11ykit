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
import { Interner } from './interner.js';
import { MemPostings } from './postings.js';

interface FlatSeries {
  labelPairs: Uint32Array;
  timestamps: BigInt64Array;
  values: Float64Array;
  count: number;
}

export class FlatStore implements StorageBackend {
  readonly name: string;

  private series: FlatSeries[] = [];
  private labelHashToIds = new Map<string, SeriesId>(); // hash(labels) → id
  private interner = new Interner();
  private postings = new MemPostings(this.interner);
  private _sampleCount = 0;

  constructor(name = 'flat') {
    this.name = name;
  }

  // ── Ingest ──

  getOrCreateSeries(labels: Labels): SeriesId {
    const labelPairs = internLabels(labels, this.interner);
    const key = seriesKeyFromPairs(labelPairs);
    const existing = this.labelHashToIds.get(key);
    if (existing !== undefined) return existing;

    const id = this.series.length;
    this.series.push({
      labelPairs,
      timestamps: new BigInt64Array(128),
      values: new Float64Array(128),
      count: 0,
    });
    this.labelHashToIds.set(key, id);
    this.postings.add(id, labels);
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
    return this.postings.get(label, value);
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
    const pairs = this.series[id]?.labelPairs;
    if (!pairs) return undefined;
    const out = new Map<string, string>();
    for (let i = 0; i < pairs.length; i += 2) {
      out.set(this.interner.resolve(pairs[i]!), this.interner.resolve(pairs[i + 1]!));
    }
    return out;
  }

  // ── Stats ──

  get seriesCount(): number { return this.series.length; }
  get sampleCount(): number { return this._sampleCount; }

  memoryBytes(): number {
    let bytes = 0;
    for (const s of this.series) {
      // Actual buffer sizes (may be larger than count due to growth).
      bytes += s.timestamps.byteLength + s.values.byteLength;
      bytes += s.labelPairs.byteLength;
    }
    bytes += this.postings.memoryBytes();
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

function seriesKeyFromPairs(labelPairs: Uint32Array): string {
  let out = '';
  for (let i = 0; i < labelPairs.length; i += 2) {
    out += `${labelPairs[i]}:${labelPairs[i + 1]},`;
  }
  return out;
}

function internLabels(labels: Labels, interner: Interner): Uint32Array {
  const pairs: Array<[number, number]> = [];
  for (const [k, v] of labels) {
    pairs.push([interner.intern(k), interner.intern(v)]);
  }
  pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const encoded = new Uint32Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) {
    const [k, v] = pairs[i]!;
    encoded[i * 2] = k;
    encoded[i * 2 + 1] = v;
  }
  return encoded;
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
