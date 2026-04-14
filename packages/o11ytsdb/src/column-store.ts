/**
 * Column store — shared timestamp columns with values-only compression.
 *
 * The key insight: co-scraped series share the same timestamps.
 * Instead of storing N copies of the same timestamp array (one per
 * series), we store one shared timestamp column per "group" and only
 * compress values per series.
 *
 * Memory model:
 *   - Timestamps: one BigInt64Array per group (shared across series)
 *   - Values: per-series XOR-compressed Uint8Array chunks
 *   - Stats: optional per-chunk block statistics for query skipping
 *
 * This is the most memory-efficient backend: timestamps are amortized
 * to near-zero cost as group size grows.
 */

import type {
  ChunkStats, Labels, SeriesId, StorageBackend, TimeRange, TimestampCodec, ValuesCodec,
} from "./types.js";
import { computeStats } from "./stats.js";
import { concatRanges, lowerBound, seriesKey, upperBound } from "./binary-search.js";

// ── Internal types ───────────────────────────────────────────────────

interface FrozenChunk {
  compressedValues: Uint8Array;
  /** Index into the group's frozen timestamp chunks. */
  tsChunkIndex: number;
  stats: ChunkStats;
}

interface HotValues {
  values: Float64Array;
  count: number;
}

interface ColumnSeries {
  labels: Labels;
  groupId: number;
  hot: HotValues;
  frozen: FrozenChunk[];
}

interface TimestampChunk {
  /** Raw timestamps (when no timestamp codec) or decoded cache. */
  timestamps?: BigInt64Array;
  /** Compressed timestamps (when timestamp codec is set). */
  compressed?: Uint8Array;
  minT: bigint;
  maxT: bigint;
  count: number;
}

interface SeriesGroup {
  /** Hot timestamp buffer (shared across all series in this group). */
  hotTimestamps: BigInt64Array;
  hotCount: number;
  /** Frozen timestamp chunks. */
  frozenTimestamps: TimestampChunk[];
  /** All series IDs belonging to this group. */
  members: SeriesId[];
}

// ── ColumnStore ──────────────────────────────────────────────────────

export class ColumnStore implements StorageBackend {
  readonly name: string;

  private valuesCodec: ValuesCodec;
  private tsCodec: TimestampCodec | undefined;
  private chunkSize: number;
  private allSeries: ColumnSeries[] = [];
  private groups: SeriesGroup[] = [];
  private labelIndex = new Map<string, SeriesId[]>();
  private labelHashToIds = new Map<string, SeriesId>();
  private _sampleCount = 0;

  /**
   * @param valuesCodec - Codec for values-only compression.
   * @param chunkSize - Samples per chunk before freezing.
   * @param groupResolver - Maps a label set to a group ID (e.g. by job+instance).
   *                        Default: all series in one group (maximum timestamp sharing).
   * @param name - Optional display name.
   * @param tsCodec - Optional timestamp codec for delta-of-delta compression.
   */
  constructor(
    valuesCodec: ValuesCodec,
    chunkSize = 1024,
    private groupResolver: (labels: Labels) => number = () => 0,
    name?: string,
    tsCodec?: TimestampCodec,
  ) {
    this.valuesCodec = valuesCodec;
    this.tsCodec = tsCodec;
    this.chunkSize = chunkSize;
    this.name = name ?? `column-${this.valuesCodec.name}-${chunkSize}`;
  }

  // ── Ingest ──

  getOrCreateSeries(labels: Labels): SeriesId {
    const key = seriesKey(labels);
    const existing = this.labelHashToIds.get(key);
    if (existing !== undefined) return existing;

    const id = this.allSeries.length;
    const groupId = this.groupResolver(labels);

    // Ensure group exists.
    while (this.groups.length <= groupId) {
      this.groups.push({
        hotTimestamps: new BigInt64Array(this.chunkSize),
        hotCount: 0,
        frozenTimestamps: [],
        members: [],
      });
    }

    const group = this.groups[groupId]!;
    group.members.push(id);

    this.allSeries.push({
      labels,
      groupId,
      hot: { values: new Float64Array(this.chunkSize), count: 0 },
      frozen: [],
    });
    this.labelHashToIds.set(key, id);

    for (const [k, v] of labels) {
      const indexKey = `${k}\0${v}`;
      let ids = this.labelIndex.get(indexKey);
      if (!ids) { ids = []; this.labelIndex.set(indexKey, ids); }
      ids.push(id);
    }
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    const s = this.allSeries[id]!;
    const group = this.groups[s.groupId]!;

    // Write timestamp to shared group buffer.
    // Only the first series to write at this position sets the timestamp.
    if (s.hot.count === group.hotCount) {
      group.hotTimestamps[group.hotCount] = timestamp;
    }

    s.hot.values[s.hot.count] = value;
    s.hot.count++;
    this._sampleCount++;

    // Check if this was the last member to fill the slot — advance group counter.
    if (s.hot.count > group.hotCount) {
      group.hotCount = s.hot.count;
    }

    if (s.hot.count === this.chunkSize) {
      this.maybeFreeze(group);
    }
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    const s = this.allSeries[id]!;
    const group = this.groups[s.groupId]!;
    let offset = 0;
    const len = timestamps.length;

    while (offset < len) {
      // How much space remains in the hot buffer for this series.
      let space = s.hot.values.length - s.hot.count;

      // If hot buffer is full, try freezing first, then expand if still full.
      if (space === 0) {
        const countBefore = s.hot.count;
        this.maybeFreeze(group);
        if (s.hot.count < countBefore) {
          // Freeze consumed some data — recalculate space.
          space = s.hot.values.length - s.hot.count;
        } else {
          // Group can't freeze yet (other members haven't filled). Expand buffer.
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

      const batch = Math.min(space, len - offset);

      // Write timestamps to shared buffer.
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
        this.maybeFreeze(group);
      }
    }
  }

  // ── Query ──

  matchLabel(label: string, value: string): SeriesId[] {
    return this.labelIndex.get(`${label}\0${value}`) ?? [];
  }

  read(id: SeriesId, start: bigint, end: bigint): TimeRange {
    const s = this.allSeries[id]!;
    const group = this.groups[s.groupId]!;
    const parts: TimeRange[] = [];

    // Scan frozen chunks.
    for (const chunk of s.frozen) {
      const tsChunk = group.frozenTimestamps[chunk.tsChunkIndex]!;
      if (tsChunk.maxT < start || tsChunk.minT > end) continue;

      // Decompress timestamps if needed.
      const timestamps = tsChunk.timestamps
        ?? (tsChunk.timestamps = this.tsCodec!.decodeTimestamps(tsChunk.compressed!));

      const values = this.valuesCodec.decodeValues(chunk.compressedValues);
      const lo = lowerBound(timestamps, start, 0, tsChunk.count);
      const hi = upperBound(timestamps, end, lo, tsChunk.count);
      if (hi > lo) {
        parts.push({
          timestamps: timestamps.slice(lo, hi),
          values: values.slice(lo, hi),
        });
      }
    }

    // Scan hot chunk.
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

    return concatRanges(parts);
  }

  labels(id: SeriesId): Labels | undefined {
    return this.allSeries[id]?.labels;
  }

  // ── Stats ──

  get seriesCount(): number { return this.allSeries.length; }
  get sampleCount(): number { return this._sampleCount; }

  memoryBytes(): number {
    let bytes = 0;

    // Group overhead: shared timestamp buffers.
    for (const g of this.groups) {
      // Hot shared timestamps (one per group).
      bytes += g.hotTimestamps.byteLength;
      // Frozen shared timestamp chunks.
      for (const tc of g.frozenTimestamps) {
        if (tc.compressed) {
          bytes += tc.compressed.byteLength;
        } else if (tc.timestamps) {
          bytes += tc.timestamps.byteLength;
        }
      }
    }

    // Per-series: hot values + frozen compressed values + stats.
    for (const s of this.allSeries) {
      bytes += s.hot.values.byteLength; // hot values buffer
      for (const c of s.frozen) {
        bytes += c.compressedValues.byteLength; // compressed values
        bytes += 72; // ChunkStats struct overhead
      }
      bytes += 100; // label storage estimate
    }
    return bytes;
  }

  // ── Internal ──

  private maybeFreeze(group: SeriesGroup): void {
    // Find the minimum sample count across all group members.
    let minCount = Infinity;
    for (const memberId of group.members) {
      const c = this.allSeries[memberId]!.hot.count;
      if (c < minCount) minCount = c;
    }

    // Freeze as many full chunks as all members can support.
    const chunksToFreeze = Math.floor(minCount / this.chunkSize);
    if (chunksToFreeze === 0) return;

    const hasWasmStats = typeof this.valuesCodec.encodeValuesWithStats === 'function';

    for (let c = 0; c < chunksToFreeze; c++) {
      const chunkStart = c * this.chunkSize;

      // Freeze shared timestamps for this chunk.
      const ts = group.hotTimestamps.slice(chunkStart, chunkStart + this.chunkSize);
      const tsChunkIndex = group.frozenTimestamps.length;

      if (this.tsCodec) {
        const compressed = this.tsCodec.encodeTimestamps(ts);
        group.frozenTimestamps.push({
          compressed,
          minT: ts[0]!,
          maxT: ts[this.chunkSize - 1]!,
          count: this.chunkSize,
        });
      } else {
        group.frozenTimestamps.push({
          timestamps: ts,
          minT: ts[0]!,
          maxT: ts[this.chunkSize - 1]!,
          count: this.chunkSize,
        });
      }

      // Freeze each member's values for this chunk.
      for (const memberId of group.members) {
        const s = this.allSeries[memberId]!;
        const vals = s.hot.values.slice(chunkStart, chunkStart + this.chunkSize);

        let compressedValues: Uint8Array;
        let stats: ChunkStats;
        if (hasWasmStats) {
          const result = this.valuesCodec.encodeValuesWithStats!(vals);
          compressedValues = result.compressed;
          stats = result.stats;
        } else {
          compressedValues = this.valuesCodec.encodeValues(vals);
          stats = computeStats(vals);
        }

        s.frozen.push({ compressedValues, tsChunkIndex, stats });
      }
    }

    // Shift remaining hot data back to the start.
    const frozenSamples = chunksToFreeze * this.chunkSize;
    for (const memberId of group.members) {
      const s = this.allSeries[memberId]!;
      const remaining = s.hot.count - frozenSamples;
      if (remaining > 0) {
        const newVals = new Float64Array(Math.max(this.chunkSize, remaining));
        newVals.set(s.hot.values.subarray(frozenSamples, s.hot.count));
        s.hot = { values: newVals, count: remaining };
      } else {
        s.hot = { values: new Float64Array(this.chunkSize), count: 0 };
      }
    }

    // Shift shared timestamps.
    const tsRemaining = group.hotCount - frozenSamples;
    if (tsRemaining > 0) {
      const newTs = new BigInt64Array(Math.max(this.chunkSize, tsRemaining));
      newTs.set(group.hotTimestamps.subarray(frozenSamples, group.hotCount));
      group.hotTimestamps = newTs;
      group.hotCount = tsRemaining;
    } else {
      group.hotTimestamps = new BigInt64Array(this.chunkSize);
      group.hotCount = 0;
    }
  }
}


