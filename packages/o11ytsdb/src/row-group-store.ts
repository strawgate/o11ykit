/**
 * Row-group store — Parquet-style row groups with per-series ALP columns.
 *
 * Same column-oriented architecture as ColumnStore, but packs all
 * group members' compressed values into a single contiguous buffer
 * per chunk window (a "row group"). Each series keeps its own ALP
 * encoding — no shared exponent or bit-width compromise.
 *
 * Advantages over per-series FrozenChunk allocations:
 *   - One ArrayBuffer per row group instead of N per series
 *   - Packed stats in a single Float64Array
 *   - Lower GC pressure from fewer small allocations
 *   - Identical compression — same codec, same quality
 *
 * Query path: slice into the row group buffer at the series offset,
 * decode just that series' ALP block. No query amplification.
 */

import { concatRanges, lowerBound, upperBound } from "./binary-search.js";
import { LabelIndex } from "./label-index.js";
import { computeStats } from "./stats.js";
import type {
  ChunkStats,
  Labels,
  RangeDecodeCodec,
  SeriesId,
  StorageBackend,
  TimeRange,
  TimestampCodec,
  ValuesCodec,
} from "./types.js";

// ── Internal types ───────────────────────────────────────────────────

interface RowGroup {
  /** Contiguous buffer of all members' compressed values. */
  valueBuffer: Uint8Array;
  /** Byte offset per member into valueBuffer. */
  offsets: Uint32Array;
  /** Byte size per member. */
  sizes: Uint32Array;
  /** Packed stats: 8 f64s per member (minV, maxV, sum, count, firstV, lastV, sumOfSquares, resetCount). */
  packedStats: Float64Array;
  /** Index into the group's frozen timestamp chunks. */
  tsChunkIndex: number;
  /** Number of group members when this row group was frozen. */
  memberCount: number;
}

interface HotValues {
  values: Float64Array;
  count: number;
}

interface RGSeries {
  groupId: number;
  /** Position of this series within its group's members array. */
  memberIndex: number;
  hot: HotValues;
}

interface TimestampChunk {
  timestamps?: BigInt64Array;
  compressed?: Uint8Array;
  minT: bigint;
  maxT: bigint;
  count: number;
}

interface SeriesGroup {
  hotTimestamps: BigInt64Array;
  hotCount: number;
  frozenTimestamps: TimestampChunk[];
  members: SeriesId[];
  rowGroups: RowGroup[];
}

// ── RowGroupStore ────────────────────────────────────────────────────

export class RowGroupStore implements StorageBackend {
  readonly name: string;

  private valuesCodec: ValuesCodec;
  private tsCodec: TimestampCodec | undefined;
  private rangeCodec: RangeDecodeCodec | undefined;
  private chunkSize: number;
  private allSeries: RGSeries[] = [];
  private groups: SeriesGroup[] = [];
  private labelIndex: LabelIndex;
  private _sampleCount = 0;
  private quantize: ((v: number) => number) | undefined;

  constructor(
    valuesCodec: ValuesCodec,
    chunkSize = 640,
    private groupResolver: (labels: Labels) => number = () => 0,
    name?: string,
    tsCodec?: TimestampCodec,
    rangeCodec?: RangeDecodeCodec,
    labelIndex?: LabelIndex,
    precision?: number
  ) {
    if (!Number.isFinite(chunkSize) || !Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError(`chunkSize must be a finite integer >= 1, got ${chunkSize}`);
    }
    this.valuesCodec = valuesCodec;
    this.tsCodec = tsCodec;
    this.rangeCodec = rangeCodec;
    this.chunkSize = chunkSize;
    this.name = name ?? `rowgroup-${this.valuesCodec.name}-${chunkSize}`;
    this.labelIndex = labelIndex ?? new LabelIndex();
    if (precision != null) {
      const scale = 10 ** precision;
      this.quantize = (v: number) => Math.round(v * scale) / scale;
    }
  }

  // ── Ingest ──

  getOrCreateSeries(labels: Labels): SeriesId {
    const { id, isNew } = this.labelIndex.getOrCreate(labels, this.allSeries.length);
    if (!isNew) return id;

    const groupId = this.groupResolver(labels);
    if (!Number.isInteger(groupId) || groupId < 0) {
      throw new RangeError(`groupResolver must return a non-negative integer, got ${groupId}`);
    }

    while (this.groups.length <= groupId) {
      this.groups.push({
        hotTimestamps: new BigInt64Array(this.chunkSize),
        hotCount: 0,
        frozenTimestamps: [],
        members: [],
        rowGroups: [],
      });
    }

    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const group = this.groups[groupId]!;
    const memberIndex = group.members.length;
    group.members.push(id);

    this.allSeries.push({
      groupId,
      memberIndex,
      hot: { values: new Float64Array(this.chunkSize), count: 0 },
    });
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const s = this.allSeries[id]!;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const group = this.groups[s.groupId]!;

    if (s.hot.count === group.hotCount) {
      group.hotTimestamps[group.hotCount] = timestamp;
    }

    s.hot.values[s.hot.count] = this.quantize ? this.quantize(value) : value;
    s.hot.count++;
    this._sampleCount++;

    if (s.hot.count > group.hotCount) {
      group.hotCount = s.hot.count;
    }

    if (s.hot.count === this.chunkSize) {
      this.maybeFreeze(group);
    }
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    if (timestamps.length !== values.length) {
      throw new RangeError(`appendBatch: timestamps.length (${timestamps.length}) !== values.length (${values.length})`);
    }
    if (timestamps.length === 0) return;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const s = this.allSeries[id]!;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const group = this.groups[s.groupId]!;
    let offset = 0;
    const len = timestamps.length;

    while (offset < len) {
      let space = s.hot.values.length - s.hot.count;

      if (space === 0) {
        const countBefore = s.hot.count;
        this.maybeFreeze(group);
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

      const batch = Math.min(space, len - offset);

      const tsSlice = timestamps.subarray(offset, offset + batch);
      if (s.hot.count <= group.hotCount) {
        group.hotTimestamps.set(tsSlice, s.hot.count);
      }

      if (this.quantize) {
        const q = this.quantize;
        for (let i = 0; i < batch; i++) {
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          s.hot.values[s.hot.count + i] = q(values[offset + i]!);
        }
      } else {
        s.hot.values.set(values.subarray(offset, offset + batch), s.hot.count);
      }
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
    return this.labelIndex.matchLabel(label, value);
  }

  read(id: SeriesId, start: bigint, end: bigint): TimeRange {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const s = this.allSeries[id]!;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const group = this.groups[s.groupId]!;
    const parts: TimeRange[] = [];

    if (this.rangeCodec && this.tsCodec) {
      for (const rg of group.rowGroups) {
        if (s.memberIndex >= rg.memberCount) continue;
        // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
        const tsChunk = group.frozenTimestamps[rg.tsChunkIndex]!;
        if (tsChunk.maxT < start || tsChunk.minT > end) continue;

        const compressedValues = rg.valueBuffer.subarray(
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          rg.offsets[s.memberIndex]!,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          rg.offsets[s.memberIndex]! + rg.sizes[s.memberIndex]!
        );

        const result = this.rangeCodec.rangeDecodeValues(
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          tsChunk.compressed!,
          compressedValues,
          start,
          end
        );
        if (result.timestamps.length > 0) {
          parts.push(result);
          if (!tsChunk.timestamps) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            tsChunk.timestamps = this.tsCodec.decodeTimestamps(tsChunk.compressed!);
          }
        }
      }
    } else {
      for (const rg of group.rowGroups) {
        if (s.memberIndex >= rg.memberCount) continue;
        // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
        const tsChunk = group.frozenTimestamps[rg.tsChunkIndex]!;
        if (tsChunk.maxT < start || tsChunk.minT > end) continue;

        if (!tsChunk.timestamps && this.tsCodec && tsChunk.compressed) {
          tsChunk.timestamps = this.tsCodec.decodeTimestamps(tsChunk.compressed);
        }
        // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
        const timestamps = tsChunk.timestamps!;

        const compressedValues = rg.valueBuffer.subarray(
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          rg.offsets[s.memberIndex]!,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          rg.offsets[s.memberIndex]! + rg.sizes[s.memberIndex]!
        );
        const values = this.valuesCodec.decodeValues(compressedValues);
        const lo = lowerBound(timestamps, start, 0, tsChunk.count);
        const hi = upperBound(timestamps, end, lo, tsChunk.count);
        if (hi > lo) {
          parts.push({
            timestamps: timestamps.slice(lo, hi),
            values: values.slice(lo, hi),
          });
        }
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
    return this.labelIndex.labels(id);
  }

  // ── Stats ──

  get seriesCount(): number {
    return this.allSeries.length;
  }
  get sampleCount(): number {
    return this._sampleCount;
  }

  memoryBytes(): number {
    let bytes = 0;

    for (const g of this.groups) {
      bytes += g.hotCount * 8;
      for (const tc of g.frozenTimestamps) {
        if (tc.compressed) {
          bytes += tc.compressed.byteLength;
        } else if (tc.timestamps) {
          bytes += tc.timestamps.byteLength;
        }
      }
      // Row groups: one contiguous buffer + offset/size tables + packed stats.
      for (const rg of g.rowGroups) {
        bytes += rg.valueBuffer.byteLength;
        bytes += rg.offsets.byteLength;
        bytes += rg.sizes.byteLength;
        bytes += rg.packedStats.byteLength;
      }
    }

    for (const s of this.allSeries) {
      bytes += s.hot.count * 8;
    }

    bytes += this.labelIndex.memoryBytes();
    return bytes;
  }

  // ── Internal ──

  private maybeFreeze(group: SeriesGroup): void {
    let minCount = Infinity;
    for (const memberId of group.members) {
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      const c = this.allSeries[memberId]!.hot.count;
      if (c < minCount) minCount = c;
    }

    const chunksToFreeze = Math.floor(minCount / this.chunkSize);
    if (chunksToFreeze === 0) return;

    const hasBatch = typeof this.valuesCodec.encodeBatchValuesWithStats === "function";
    const hasWasmStats = typeof this.valuesCodec.encodeValuesWithStats === "function";
    const numMembers = group.members.length;

    for (let c = 0; c < chunksToFreeze; c++) {
      const chunkStart = c * this.chunkSize;

      // Freeze shared timestamps.
      const ts = group.hotTimestamps.slice(chunkStart, chunkStart + this.chunkSize);
      const tsChunkIndex = group.frozenTimestamps.length;

      if (this.tsCodec) {
        const compressed = this.tsCodec.encodeTimestamps(ts);
        group.frozenTimestamps.push({
          compressed,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          minT: ts[0]!,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          maxT: ts[this.chunkSize - 1]!,
          count: this.chunkSize,
        });
      } else {
        group.frozenTimestamps.push({
          timestamps: ts,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          minT: ts[0]!,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          maxT: ts[this.chunkSize - 1]!,
          count: this.chunkSize,
        });
      }

      // Encode all members and collect results.
      const blobs: Uint8Array[] = [];
      const allStats: ChunkStats[] = [];

      if (hasBatch) {
        const BATCH_CAP = 32;
        for (let bStart = 0; bStart < numMembers; bStart += BATCH_CAP) {
          const bEnd = Math.min(bStart + BATCH_CAP, numMembers);
          const arrays: Float64Array[] = [];
          for (let m = bStart; m < bEnd; m++) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            const s = this.allSeries[group.members[m]!]!;
            arrays.push(s.hot.values.subarray(chunkStart, chunkStart + this.chunkSize));
          }
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          const results = this.valuesCodec.encodeBatchValuesWithStats!(arrays);
          for (let m = 0; m < results.length; m++) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            const { compressed, stats } = results[m]!;
            blobs.push(compressed);
            allStats.push(stats);
          }
        }
      } else {
        for (const memberId of group.members) {
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          const s = this.allSeries[memberId]!;
          const vals = s.hot.values.subarray(chunkStart, chunkStart + this.chunkSize);

          let compressed: Uint8Array;
          let stats: ChunkStats;
          if (hasWasmStats) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            const result = this.valuesCodec.encodeValuesWithStats!(vals);
            compressed = result.compressed;
            stats = result.stats;
          } else {
            compressed = this.valuesCodec.encodeValues(vals);
            stats = computeStats(vals);
          }
          blobs.push(compressed);
          allStats.push(stats);
        }
      }

      // Pack into a single row group.
      let totalBytes = 0;
      for (const b of blobs) totalBytes += b.byteLength;

      const valueBuffer = new Uint8Array(totalBytes);
      const offsets = new Uint32Array(numMembers);
      const sizes = new Uint32Array(numMembers);
      const packedStats = new Float64Array(numMembers * 8);

      let pos = 0;
      for (let m = 0; m < numMembers; m++) {
        // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
        const blob = blobs[m]!;
        valueBuffer.set(blob, pos);
        offsets[m] = pos;
        sizes[m] = blob.byteLength;
        pos += blob.byteLength;

        // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
        const st = allStats[m]!;
        const si = m * 8;
        packedStats[si] = st.minV;
        packedStats[si + 1] = st.maxV;
        packedStats[si + 2] = st.sum;
        packedStats[si + 3] = st.count;
        packedStats[si + 4] = st.firstV;
        packedStats[si + 5] = st.lastV;
        packedStats[si + 6] = st.sumOfSquares;
        packedStats[si + 7] = st.resetCount;
      }

      group.rowGroups.push({
        valueBuffer,
        offsets,
        sizes,
        packedStats,
        tsChunkIndex,
        memberCount: numMembers,
      });
    }

    // Shift remaining hot data back.
    const frozenSamples = chunksToFreeze * this.chunkSize;
    for (const memberId of group.members) {
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      const s = this.allSeries[memberId]!;
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
}
