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

import { concatRanges, lowerBound, upperBound } from "./binary-search.js";
import { LabelIndex } from "./label-index.js";
import type { Codec, Labels, SeriesId, StorageBackend, TimeRange } from "./types.js";

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
  hot: HotChunk;
  frozen: FrozenChunk[];
}

export class ChunkedStore implements StorageBackend {
  readonly name: string;

  private codec: Codec;
  private chunkSize: number;
  private series: ChunkedSeries[] = [];
  private labelIndex: LabelIndex;
  private _sampleCount = 0;

  constructor(codec: Codec, chunkSize = 640, name?: string, labelIndex?: LabelIndex) {
    if (!Number.isFinite(chunkSize) || !Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError(`chunkSize must be a finite integer >= 1, got ${chunkSize}`);
    }
    this.codec = codec;
    this.chunkSize = chunkSize;
    this.name = name ?? `chunked-${codec.name}-${chunkSize}`;
    this.labelIndex = labelIndex ?? new LabelIndex();
  }

  // ── Ingest ──

  getOrCreateSeries(labels: Labels): SeriesId {
    const { id, isNew } = this.labelIndex.getOrCreate(labels, this.series.length);
    if (!isNew) return id;

    this.series.push({
      hot: this.newHotChunk(),
      frozen: [],
    });
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
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
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
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
    return this.labelIndex.matchLabel(label, value);
  }

  read(id: SeriesId, start: bigint, end: bigint): TimeRange {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
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

    return concatRanges(parts);
  }

  labels(id: SeriesId): Labels | undefined {
    return this.labelIndex.labels(id);
  }

  // ── Stats ──

  get seriesCount(): number {
    return this.series.length;
  }
  get sampleCount(): number {
    return this._sampleCount;
  }

  memoryBytes(): number {
    let bytes = 0;
    for (const s of this.series) {
      bytes += s.hot.count * 16;
      for (const c of s.frozen) {
        bytes += c.compressed.byteLength + 32;
      }
    }
    bytes += this.labelIndex.memoryBytes();
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
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      minT: ts[0]!,
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
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
