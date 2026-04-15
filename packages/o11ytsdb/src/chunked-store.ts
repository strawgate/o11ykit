/**
 * Chunked storage — XOR-delta compressed with pluggable codec.
 *
 * Each series has a hot chunk (pre-allocated typed arrays accepting
 * appends) and a list of frozen chunks (compressed with the codec).
 * Reading frozen chunks requires decode. The codec is injected so
 * the same store works with TS or WASM codecs.
 *
 * Chunk size is configurable — this is a key parameter to experiment
 * with. Smaller chunks = less decode work per query but more overhead.
 */

import type {
  Codec, Labels, SeriesId, StorageBackend, TimeRange,
} from './types.js';
import { Interner } from './interner.js';
import { MemPostings } from './postings.js';

interface FrozenChunk {
  compressed: Uint8Array;
  minT: bigint;
  maxT: bigint;
  count: number;
}

interface HotChunk {
  timestamps: BigInt64Array;
  values: Float64Array;
  count: number;
}

interface ChunkedSeries {
  labelPairs: Uint32Array;
  hot: HotChunk;
  frozen: FrozenChunk[];
}

export class ChunkedStore implements StorageBackend {
  readonly name: string;

  private codec: Codec;
  private chunkSize: number;
  private series: ChunkedSeries[] = [];
  private labelHashToIds = new Map<string, SeriesId>();
  private interner = new Interner();
  private postings = new MemPostings(this.interner);
  private _sampleCount = 0;

  constructor(codec: Codec, chunkSize = 640, name?: string) {
    this.codec = codec;
    this.chunkSize = chunkSize;
    this.name = name ?? `chunked-${codec.name}-${chunkSize}`;
  }

  // ── Ingest ──

  getOrCreateSeries(labels: Labels): SeriesId {
    const labelPairs = internLabels(labels, this.interner);
    const key = seriesKey(labelPairs);
    const existing = this.labelHashToIds.get(key);
    if (existing !== undefined) return existing;

    const id = this.series.length;
    this.series.push({
      labelPairs,
      hot: this.newHotChunk(),
      frozen: [],
    });
    this.labelHashToIds.set(key, id);
    this.postings.add(id, labels);
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    const s = this.series[id]!;
    const hot = s.hot;
    hot.timestamps[hot.count] = timestamp;
    hot.values[hot.count] = value;
    hot.count++;
    this._sampleCount++;

    if (hot.count === this.chunkSize) {
      this.freeze(s);
    }
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    const s = this.series[id]!;
    let offset = 0;
    const len = timestamps.length;

    while (offset < len) {
      const hot = s.hot;
      const space = this.chunkSize - hot.count;
      const batch = Math.min(space, len - offset);

      hot.timestamps.set(timestamps.subarray(offset, offset + batch), hot.count);
      hot.values.set(values.subarray(offset, offset + batch), hot.count);
      hot.count += batch;
      this._sampleCount += batch;
      offset += batch;

      if (hot.count === this.chunkSize) {
        this.freeze(s);
      }
    }
  }

  // ── Query ──

  matchLabel(label: string, value: string): SeriesId[] {
    return this.postings.get(label, value);
  }

  read(id: SeriesId, start: bigint, end: bigint): TimeRange {
    const s = this.series[id]!;
    const parts: TimeRange[] = [];

    // Scan frozen chunks (skip non-overlapping).
    for (const chunk of s.frozen) {
      if (chunk.maxT < start || chunk.minT > end) continue;
      const decoded = this.codec.decode(chunk.compressed);
      const lo = lowerBound(decoded.timestamps, start, 0, decoded.timestamps.length);
      const hi = upperBound(decoded.timestamps, end, lo, decoded.timestamps.length);
      if (hi > lo) {
        parts.push({
          timestamps: decoded.timestamps.slice(lo, hi),
          values: decoded.values.slice(lo, hi),
        });
      }
    }

    // Scan hot chunk.
    if (s.hot.count > 0) {
      const hot = s.hot;
      const lo = lowerBound(hot.timestamps, start, 0, hot.count);
      const hi = upperBound(hot.timestamps, end, lo, hot.count);
      if (hi > lo) {
        parts.push({
          timestamps: hot.timestamps.slice(lo, hi),
          values: hot.values.slice(lo, hi),
        });
      }
    }

    return concat(parts);
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
      // Hot chunk: only active samples, not full capacity.
      bytes += s.hot.count * 16; // 8 bytes timestamp + 8 bytes value per sample
      // Frozen chunks: compressed bytes + struct overhead.
      for (const c of s.frozen) {
        bytes += c.compressed.byteLength + 32; // 2 bigints + count + overhead
      }
      bytes += s.labelPairs.byteLength;
    }
    bytes += this.postings.memoryBytes();
    return bytes;
  }

  // ── Internal ──

  private freeze(s: ChunkedSeries): void {
    const hot = s.hot;
    const ts = hot.timestamps.slice(0, hot.count);
    const vals = hot.values.slice(0, hot.count);
    const compressed = this.codec.encode(ts, vals);
    s.frozen.push({
      compressed,
      minT: ts[0]!,
      maxT: ts[hot.count - 1]!,
      count: hot.count,
    });
    s.hot = this.newHotChunk();
  }

  private newHotChunk(): HotChunk {
    return {
      timestamps: new BigInt64Array(this.chunkSize),
      values: new Float64Array(this.chunkSize),
      count: 0,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function seriesKey(labelPairs: Uint32Array): string {
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

function concat(parts: TimeRange[]): TimeRange {
  if (parts.length === 0) {
    return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  }
  if (parts.length === 1) return parts[0]!;

  let total = 0;
  for (const p of parts) total += p.timestamps.length;

  const timestamps = new BigInt64Array(total);
  const values = new Float64Array(total);
  let offset = 0;
  for (const p of parts) {
    timestamps.set(p.timestamps, offset);
    values.set(p.values, offset);
    offset += p.timestamps.length;
  }
  return { timestamps, values };
}
