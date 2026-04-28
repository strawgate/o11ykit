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

import { lowerBound, upperBound } from "stardb";
import { LabelIndex } from "./label-index.js";
import type { Labels, SeriesAppend, SeriesId, StorageBackend, TimeRange } from "./types.js";

interface FlatSeries {
  timestamps: BigInt64Array;
  values: Float64Array;
  count: number;
}

export class FlatStore implements StorageBackend {
  readonly name: string;

  private series: FlatSeries[] = [];
  private labelIndex: LabelIndex;
  private _sampleCount = 0;

  constructor(name = "flat", labelIndex?: LabelIndex) {
    this.name = name;
    this.labelIndex = labelIndex ?? new LabelIndex();
  }

  // ── Ingest ──

  getOrCreateSeries(labels: Labels): SeriesId {
    const { id, isNew } = this.labelIndex.getOrCreate(labels, this.series.length);
    if (!isNew) return id;

    this.series.push({
      timestamps: new BigInt64Array(128),
      values: new Float64Array(128),
      count: 0,
    });
    return id;
  }

  append(timestamps: BigInt64Array, series: readonly SeriesAppend[]): void;
  append(id: SeriesId, timestamp: bigint, value: number): void;
  append(
    timestampsOrId: BigInt64Array | SeriesId,
    seriesOrTimestamp: readonly SeriesAppend[] | bigint,
    value?: number
  ): void {
    if (typeof timestampsOrId === "number") {
      this.appendSample(timestampsOrId, seriesOrTimestamp as bigint, value as number);
      return;
    }
    const series = seriesOrTimestamp as readonly SeriesAppend[];
    for (const item of series) {
      if (item.values.length !== timestampsOrId.length) {
        throw new RangeError(
          `append: timestamps.length (${timestampsOrId.length}) !== values.length (${item.values.length})`
        );
      }
    }
    for (const item of series) {
      this.appendBatch(item.id, timestampsOrId, item.values);
    }
  }

  private appendSample(id: SeriesId, timestamp: bigint, value: number): void {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
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
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
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
    return this.labelIndex.matchLabel(label, value);
  }

  matchLabelRegex(label: string, pattern: RegExp): SeriesId[] {
    return this.labelIndex.matchLabelRegex(label, pattern);
  }

  read(id: SeriesId, start: bigint, end: bigint): TimeRange {
    return (
      this.readParts(id, start, end)[0] ?? {
        timestamps: new BigInt64Array(0),
        values: new Float64Array(0),
      }
    );
  }

  readParts(id: SeriesId, start: bigint, end: bigint): TimeRange[] {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const s = this.series[id]!;
    const lo = lowerBound(s.timestamps, start, 0, s.count);
    const hi = upperBound(s.timestamps, end, lo, s.count);
    if (hi <= lo) return [];
    return [
      {
        timestamps: s.timestamps.slice(lo, hi),
        values: s.values.slice(lo, hi),
      },
    ];
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
      bytes += s.timestamps.byteLength + s.values.byteLength;
    }
    bytes += this.labelIndex.memoryBytes();
    return bytes;
  }

  /** Return chunk-level metadata for the storage explorer UI. */
  getChunkInfo(id: SeriesId): Record<string, unknown> {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const s = this.series[id]!;
    return {
      frozen: [],
      hot: {
        count: s.count,
        rawBytes: s.count * 16,
        allocatedBytes: s.timestamps.byteLength + s.values.byteLength,
      },
    };
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
