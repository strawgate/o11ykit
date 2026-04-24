/**
 * Row-group store — bounded physical row groups inside a logical group.
 *
 * Freeze coordination happens per lane instead of per logical group. When a
 * lane stalls and hits its hot-buffer cap, the active series is rolled into a
 * fresh lane so the stalled lane stays bounded.
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

interface RowGroup {
  valueBuffer: Uint8Array;
  offsets: Uint32Array;
  sizes: Uint32Array;
  packedStats: Float64Array;
  tsChunkIndex: number;
  memberCount: number;
}

interface HotValues {
  values: Float64Array;
  count: number;
}

interface LaneSegment {
  laneId: number;
  laneMemberIndex: number;
  hot: HotValues;
}

interface LaneSeries {
  groupId: number;
  segments: LaneSegment[];
  activeSegmentIndex: number;
}

interface LaneMember {
  seriesId: SeriesId;
  segmentIndex: number;
}

interface TimestampChunk {
  timestamps?: BigInt64Array;
  compressed?: Uint8Array;
  minT: bigint;
  maxT: bigint;
  count: number;
}

interface GroupLane {
  hotTimestamps: BigInt64Array;
  hotCount: number;
  frozenTimestamps: TimestampChunk[];
  members: LaneMember[];
  rowGroups: RowGroup[];
}

interface SeriesGroup {
  lanes: GroupLane[];
}

export interface RowGroupStoreCompactionChunk {
  valueBuffer: Uint8Array;
  offsets: Uint32Array;
  sizes: Uint32Array;
  memberCount: number;
}

export interface RowGroupStoreLaneWindow {
  groupId: number;
  laneId: number;
  rowGroupCount: number;
  sampleCount: number;
  memberSeriesIds: SeriesId[];
  timestamps: BigInt64Array;
  rowGroups: RowGroupStoreCompactionChunk[];
}

const EMPTY_TIMESTAMPS = new BigInt64Array(0);
const EMPTY_VALUES = new Float64Array(0);
const PACKED_STATS_STRIDE = 5;

function createLane(_chunkSize: number): GroupLane {
  return {
    // Grow hot timestamp storage on first write. Many lanes, especially
    // compaction-only cold lanes, never receive direct hot appends.
    hotTimestamps: EMPTY_TIMESTAMPS,
    hotCount: 0,
    frozenTimestamps: [],
    members: [],
    rowGroups: [],
  };
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new RangeError(message);
  }
  return value;
}

type LazyRowGroupPart = TimeRange & {
  _timestampsRef?: BigInt64Array;
  _compressedValues?: Uint8Array;
  _compressedTimestamps?: Uint8Array;
  _valuesCodec?: ValuesCodec;
  _rangeCodec?: RangeDecodeCodec;
  _startT?: bigint;
  _endT?: bigint;
  _lo?: number;
  _hi?: number;
};

function decodeFullRowGroupPart(this: LazyRowGroupPart): TimeRange {
  this.timestamps = requireDefined(this._timestampsRef, "missing row-group timestamps");
  this.values = requireDefined(this._valuesCodec, "missing values codec").decodeValues(
    requireDefined(this._compressedValues, "missing compressed values")
  );
  return this;
}

function decodePartialRowGroupPart(this: LazyRowGroupPart): TimeRange {
  const codec = requireDefined(this._valuesCodec, "missing values codec");
  const compressedValues = requireDefined(this._compressedValues, "missing compressed values");
  const lo = requireDefined(this._lo, "missing partial decode start");
  const hi = requireDefined(this._hi, "missing partial decode end");
  if (codec.decodeValuesRangeView) {
    this.values = codec.decodeValuesRangeView.call(codec, compressedValues, lo, hi).slice();
    return this;
  }
  this.values = codec.decodeValuesRange
    ? codec.decodeValuesRange.call(codec, compressedValues, lo, hi)
    : codec.decodeValues(compressedValues).subarray(lo, hi);
  return this;
}

function decodeRangeRowGroupPart(this: LazyRowGroupPart): TimeRange {
  const result = requireDefined(this._rangeCodec, "missing range codec").rangeDecodeValues(
    requireDefined(this._compressedTimestamps, "missing compressed timestamps"),
    requireDefined(this._compressedValues, "missing compressed values"),
    requireDefined(this._startT, "missing range decode start"),
    requireDefined(this._endT, "missing range decode end")
  );
  this.timestamps = result.timestamps;
  this.values = result.values;
  return this;
}

export class RowGroupStore implements StorageBackend {
  readonly name: string;

  private valuesCodec: ValuesCodec;
  private tsCodec: TimestampCodec | undefined;
  private rangeCodec: RangeDecodeCodec | undefined;
  private chunkSize: number;
  private allSeries: LaneSeries[] = [];
  private groups: SeriesGroup[] = [];
  private labelIndex: LabelIndex;
  private _sampleCount = 0;
  private quantize: ((v: number) => number) | undefined;
  private quantizeBatch: ((values: Float64Array, precision: number) => void) | undefined;
  private precision: number | undefined;
  private readonly maxHotWindowsPerLane = 2;

  constructor(
    valuesCodec: ValuesCodec,
    chunkSize = 640,
    private groupResolver: (labels: Labels) => number = () => 0,
    private maxSeriesPerLane = 32,
    name?: string,
    tsCodec?: TimestampCodec,
    rangeCodec?: RangeDecodeCodec,
    labelIndex?: LabelIndex,
    precision?: number,
    quantizeBatch?: (values: Float64Array, precision: number) => void
  ) {
    if (!Number.isFinite(chunkSize) || !Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError(`chunkSize must be a finite integer >= 1, got ${chunkSize}`);
    }
    if (
      !Number.isFinite(maxSeriesPerLane) ||
      !Number.isInteger(maxSeriesPerLane) ||
      maxSeriesPerLane < 1
    ) {
      throw new RangeError(
        `maxSeriesPerLane must be a finite integer >= 1, got ${maxSeriesPerLane}`
      );
    }
    if (
      precision != null &&
      (!Number.isFinite(precision) || !Number.isInteger(precision) || precision < 0)
    ) {
      // appendBatch's all-integer fast path skips quantization; that is only
      // sound when precision actually rounds to an integer or coarser scale,
      // i.e. a non-negative integer. Reject NaN, fractional, or negative
      // values up front so append() and appendBatch() can't diverge.
      throw new RangeError(`precision must be a finite integer >= 0, got ${precision}`);
    }
    this.valuesCodec = valuesCodec;
    this.tsCodec = tsCodec;
    this.rangeCodec = rangeCodec;
    this.chunkSize = chunkSize;
    this.name = name ?? `rowgroup-${this.valuesCodec.name}-${chunkSize}-lane${maxSeriesPerLane}`;
    this.labelIndex = labelIndex ?? new LabelIndex();
    this.precision = precision;
    this.quantizeBatch = quantizeBatch;
    if (precision != null) {
      const scale = 10 ** precision;
      if (quantizeBatch) {
        // Use WASM quantize for single values too, ensuring consistent rounding
        // (banker's rounding via f64x2_nearest) across append() and appendBatch().
        const scratch = new Float64Array(1);
        const qb = quantizeBatch;
        const p = precision;
        this.quantize = (v: number) => {
          scratch[0] = v;
          qb(scratch, p);
          return requireDefined(scratch[0], "quantizeBatch did not populate scratch output");
        };
      } else {
        this.quantize = (v: number) => Math.round(v * scale) / scale;
      }
    }
  }

  getOrCreateSeries(labels: Labels): SeriesId {
    const { id, isNew } = this.labelIndex.getOrCreate(labels, this.allSeries.length);
    if (!isNew) return id;

    const groupId = this.groupResolver(labels);
    if (!Number.isInteger(groupId) || groupId < 0) {
      throw new RangeError(`groupResolver must return a non-negative integer, got ${groupId}`);
    }

    while (this.groups.length <= groupId) {
      this.groups.push({ lanes: [createLane(this.chunkSize)] });
    }

    const series: LaneSeries = {
      groupId,
      segments: [],
      activeSegmentIndex: 0,
    };
    this.allSeries.push(series);
    this.attachInitialSegment(id, groupId);
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    const state = this.ensureWriteSpace(id);
    // Leader-only: only the segment at the lane's high-water mark writes shared timestamps
    if (state.segment.hot.count === state.lane.hotCount) {
      state.lane.hotTimestamps[state.lane.hotCount] = timestamp;
    }

    state.segment.hot.values[state.segment.hot.count] = this.quantize
      ? this.quantize(value)
      : value;
    state.segment.hot.count++;
    this._sampleCount++;

    if (state.segment.hot.count > state.lane.hotCount) {
      state.lane.hotCount = state.segment.hot.count;
    }

    if (state.segment.hot.count === this.chunkSize) {
      this.maybeFreeze(state.lane);
    }
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    if (timestamps.length !== values.length) {
      throw new RangeError(
        `appendBatch: timestamps.length (${timestamps.length}) !== values.length (${values.length})`
      );
    }
    if (timestamps.length === 0) return;

    let offset = 0;
    const len = timestamps.length;

    while (offset < len) {
      const state = this.ensureWriteSpace(id);
      const space = state.segment.hot.values.length - state.segment.hot.count;
      if (space <= 0) {
        throw new RangeError(
          `appendBatch invariant violated: no write space for series ${id} ` +
            `(count=${state.segment.hot.count}, capacity=${state.segment.hot.values.length})`
        );
      }
      const batch = Math.min(space, len - offset);
      const tsSlice = timestamps.subarray(offset, offset + batch);

      // Write the suffix of this batch that extends past the lane's current
      // high-water mark into the shared timestamp column. Positions <=
      // lane.hotCount are already owned by the lane leader and must not be
      // overwritten; positions > lane.hotCount are still uninitialized and
      // are this batch's responsibility (otherwise reads of the new range
      // would observe zero/garbage timestamps).
      if (state.segment.hot.count + batch > state.lane.hotCount) {
        const tsOffset = Math.max(0, state.lane.hotCount - state.segment.hot.count);
        state.lane.hotTimestamps.set(tsSlice.subarray(tsOffset), state.lane.hotCount);
      }

      if (this.quantize) {
        const slice = values.subarray(offset, offset + batch);
        let allIntegers = true;
        for (let i = 0; i < slice.length; i++) {
          if (requireDefined(slice[i], `missing value at batch index ${offset + i}`) % 1 !== 0) {
            allIntegers = false;
            break;
          }
        }
        if (allIntegers) {
          state.segment.hot.values.set(slice, state.segment.hot.count);
        } else if (this.quantizeBatch && this.precision != null) {
          // WASM SIMD batch quantize — ~17× faster than per-element Math.round.
          // Copy into hot buffer first, then quantize in-place to avoid extra allocation.
          state.segment.hot.values.set(slice, state.segment.hot.count);
          const target = state.segment.hot.values.subarray(
            state.segment.hot.count,
            state.segment.hot.count + batch
          );
          this.quantizeBatch(target, this.precision);
        } else {
          const q = this.quantize;
          for (let i = 0; i < batch; i++) {
            state.segment.hot.values[state.segment.hot.count + i] = q(
              requireDefined(values[offset + i], `missing value at batch index ${offset + i}`)
            );
          }
        }
      } else {
        state.segment.hot.values.set(
          values.subarray(offset, offset + batch),
          state.segment.hot.count
        );
      }

      state.segment.hot.count += batch;
      this._sampleCount += batch;
      offset += batch;

      if (state.segment.hot.count > state.lane.hotCount) {
        state.lane.hotCount = state.segment.hot.count;
      }

      if (state.segment.hot.count >= this.chunkSize) {
        this.maybeFreeze(state.lane);
      }
    }
  }

  matchLabel(label: string, value: string): SeriesId[] {
    return this.labelIndex.matchLabel(label, value);
  }

  matchLabelRegex(label: string, pattern: RegExp): SeriesId[] {
    return this.labelIndex.matchLabelRegex(label, pattern);
  }

  read(id: SeriesId, start: bigint, end: bigint): TimeRange {
    return concatRanges(this.readParts(id, start, end));
  }

  readParts(id: SeriesId, start: bigint, end: bigint): TimeRange[] {
    const parts: TimeRange[] = [];
    this.scanParts(id, start, end, (part) => {
      parts.push(part);
    });
    return parts;
  }

  scanParts(id: SeriesId, start: bigint, end: bigint, visit: (part: TimeRange) => void): void {
    const series = requireDefined(this.allSeries[id], `unknown series id ${id}`);
    for (const segment of series.segments) {
      const lane = this.getLane(series.groupId, segment.laneId);

      if (this.rangeCodec && this.tsCodec) {
        for (const rg of lane.rowGroups) {
          if (segment.laneMemberIndex >= rg.memberCount) continue;
          const tsChunk = requireDefined(
            lane.frozenTimestamps[rg.tsChunkIndex],
            `missing timestamp chunk ${rg.tsChunkIndex} for lane ${segment.laneId}`
          );
          if (tsChunk.maxT < start || tsChunk.minT > end) continue;
          const offset = requireDefined(
            rg.offsets[segment.laneMemberIndex],
            `missing row-group offset for member ${segment.laneMemberIndex}`
          );
          const size = requireDefined(
            rg.sizes[segment.laneMemberIndex],
            `missing row-group size for member ${segment.laneMemberIndex}`
          );
          const compressedTimestamps = requireDefined(
            tsChunk.compressed,
            `missing compressed timestamps for chunk ${rg.tsChunkIndex}`
          );

          const compressedValues = rg.valueBuffer.subarray(offset, offset + size);

          if (tsChunk.minT >= start && tsChunk.maxT <= end) {
            const rangeCodec = requireDefined(
              this.rangeCodec,
              "missing range codec for stats-aware row-group decode"
            );
            visit({
              timestamps: EMPTY_TIMESTAMPS,
              values: EMPTY_VALUES,
              statsPacked: rg.packedStats,
              statsOffset: segment.laneMemberIndex * PACKED_STATS_STRIDE,
              chunkMinT: tsChunk.minT,
              chunkMaxT: tsChunk.maxT,
              decode: decodeRangeRowGroupPart,
              _rangeCodec: rangeCodec,
              _compressedTimestamps: compressedTimestamps,
              _compressedValues: compressedValues,
              _startT: tsChunk.minT,
              _endT: tsChunk.maxT,
            } as LazyRowGroupPart);
            continue;
          }

          const result = this.rangeCodec.rangeDecodeValues(
            compressedTimestamps,
            compressedValues,
            start,
            end
          );
          if (result.timestamps.length > 0) {
            visit(result);
          }
        }
      } else {
        for (const rg of lane.rowGroups) {
          if (segment.laneMemberIndex >= rg.memberCount) continue;
          const tsChunk = requireDefined(
            lane.frozenTimestamps[rg.tsChunkIndex],
            `missing timestamp chunk ${rg.tsChunkIndex} for lane ${segment.laneId}`
          );
          if (tsChunk.maxT < start || tsChunk.minT > end) continue;

          if (!tsChunk.timestamps && this.tsCodec && tsChunk.compressed) {
            tsChunk.timestamps = this.tsCodec.decodeTimestamps(tsChunk.compressed);
          }
          const timestamps = requireDefined(
            tsChunk.timestamps,
            `missing decoded timestamps for chunk ${rg.tsChunkIndex}`
          );
          const offset = requireDefined(
            rg.offsets[segment.laneMemberIndex],
            `missing row-group offset for member ${segment.laneMemberIndex}`
          );
          const size = requireDefined(
            rg.sizes[segment.laneMemberIndex],
            `missing row-group size for member ${segment.laneMemberIndex}`
          );

          const compressedValues = rg.valueBuffer.subarray(offset, offset + size);
          if (tsChunk.minT >= start && tsChunk.maxT <= end) {
            visit({
              timestamps: EMPTY_TIMESTAMPS,
              values: EMPTY_VALUES,
              statsPacked: rg.packedStats,
              statsOffset: segment.laneMemberIndex * PACKED_STATS_STRIDE,
              chunkMinT: tsChunk.minT,
              chunkMaxT: tsChunk.maxT,
              decode: decodeFullRowGroupPart,
              _timestampsRef: timestamps,
              _compressedValues: compressedValues,
              _valuesCodec: this.valuesCodec,
            } as LazyRowGroupPart);
            continue;
          }

          const lo = lowerBound(timestamps, start, 0, tsChunk.count);
          const hi = upperBound(timestamps, end, lo, tsChunk.count);
          if (hi > lo) {
            const partialTimestamps = timestamps.subarray(lo, hi);
            visit({
              timestamps: partialTimestamps,
              values: EMPTY_VALUES,
              decode: decodePartialRowGroupPart,
              _compressedValues: compressedValues,
              _valuesCodec: this.valuesCodec,
              _lo: lo,
              _hi: hi,
            } as LazyRowGroupPart);
          }
        }
      }

      if (segment.hot.count > 0) {
        const lo = lowerBound(lane.hotTimestamps, start, 0, segment.hot.count);
        const hi = upperBound(lane.hotTimestamps, end, lo, segment.hot.count);
        if (hi > lo) {
          visit({
            timestamps: lane.hotTimestamps.slice(lo, hi),
            values: segment.hot.values.slice(lo, hi),
          });
        }
      }
    }
  }

  labels(id: SeriesId): Labels | undefined {
    return this.labelIndex.labels(id);
  }

  get seriesCount(): number {
    return this.allSeries.length;
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  memoryBytes(): number {
    let bytes = 0;

    for (const group of this.groups) {
      for (const lane of group.lanes) {
        // Account for the full allocated capacity of the hot timestamp buffer,
        // not just populated samples — rollover/grow can leave the buffer
        // larger than hotCount and that overhead is what callers want to see.
        bytes += lane.hotTimestamps.byteLength;
        for (const tc of lane.frozenTimestamps) {
          // A chunk can hold both the compressed buffer and a decoded
          // timestamps cache after a non-range read, so count them
          // independently to avoid understating resident memory.
          if (tc.compressed) {
            bytes += tc.compressed.byteLength;
          }
          if (tc.timestamps) {
            bytes += tc.timestamps.byteLength;
          }
        }
        for (const rg of lane.rowGroups) {
          bytes += rg.valueBuffer.byteLength;
          bytes += rg.offsets.byteLength;
          bytes += rg.sizes.byteLength;
          bytes += rg.packedStats.byteLength;
        }
      }
    }

    for (const series of this.allSeries) {
      for (const segment of series.segments) {
        bytes += segment.hot.values.byteLength;
      }
    }

    bytes += this.labelIndex.memoryBytes();
    return bytes;
  }

  memoryBytesExcludingLabels(): number {
    return this.memoryBytes() - this.labelIndex.memoryBytes();
  }

  peekCompactableLaneWindow(
    groupId: number,
    rowGroupCount: number,
    expectedChunkSize: number
  ): RowGroupStoreLaneWindow | undefined {
    const group = this.getGroup(groupId);
    for (let laneId = 0; laneId < group.lanes.length; laneId++) {
      const lane = requireDefined(
        group.lanes[laneId],
        `missing lane ${laneId} for group ${groupId}`
      );
      if (!this.canDrainLaneWindow(lane, rowGroupCount, expectedChunkSize)) {
        continue;
      }

      const rowGroups = lane.rowGroups.slice(0, rowGroupCount);
      const tsChunks = lane.frozenTimestamps.slice(0, rowGroupCount);
      const firstRowGroup = requireDefined(rowGroups[0], "missing compactable row group");
      const memberCount = firstRowGroup.memberCount;
      const windowSize = rowGroupCount * expectedChunkSize;
      const timestamps = new BigInt64Array(windowSize);

      let tsOffset = 0;
      for (let i = 0; i < tsChunks.length; i++) {
        const chunk = requireDefined(tsChunks[i], `missing compactable timestamp chunk ${i}`);
        const decoded =
          chunk.timestamps ??
          this.tsCodec?.decodeTimestamps(
            requireDefined(chunk.compressed, `missing compressed timestamps for chunk ${i}`)
          );
        if (!decoded) {
          throw new RangeError(`missing timestamps for compactable chunk ${i}`);
        }
        if (decoded.length !== expectedChunkSize) {
          throw new RangeError(
            `expected ${expectedChunkSize} timestamps for chunk ${i}, got ${decoded.length}`
          );
        }
        timestamps.set(decoded, tsOffset);
        tsOffset += decoded.length;
      }
      if (tsOffset !== windowSize) {
        throw new RangeError(`expected ${windowSize} compacted timestamps, got ${tsOffset}`);
      }

      return {
        groupId,
        laneId,
        rowGroupCount,
        sampleCount: memberCount * windowSize,
        memberSeriesIds: lane.members.slice(0, memberCount).map((member) => member.seriesId),
        timestamps,
        rowGroups: rowGroups.map((rowGroup) => ({
          valueBuffer: rowGroup.valueBuffer,
          offsets: rowGroup.offsets,
          sizes: rowGroup.sizes,
          memberCount: rowGroup.memberCount,
        })),
      };
    }
    return undefined;
  }

  commitCompactedLaneWindow(window: RowGroupStoreLaneWindow): void {
    const lane = this.getLane(window.groupId, window.laneId);
    lane.rowGroups.splice(0, window.rowGroupCount);
    lane.frozenTimestamps.splice(0, window.rowGroupCount);
    for (const rowGroup of lane.rowGroups) {
      rowGroup.tsChunkIndex -= window.rowGroupCount;
    }
    this._sampleCount = Math.max(this._sampleCount - window.sampleCount, 0);
  }

  appendCompactedWindow(
    memberSeriesIds: readonly SeriesId[],
    timestamps: BigInt64Array,
    valuesByMember: readonly Float64Array[]
  ): void {
    if (memberSeriesIds.length === 0) {
      throw new RangeError("appendCompactedWindow requires at least one member");
    }
    if (memberSeriesIds.length !== valuesByMember.length) {
      throw new RangeError(
        `appendCompactedWindow: memberSeriesIds.length (${memberSeriesIds.length}) !== ` +
          `valuesByMember.length (${valuesByMember.length})`
      );
    }
    if (timestamps.length !== this.chunkSize) {
      throw new RangeError(
        `appendCompactedWindow: expected ${this.chunkSize} timestamps, got ${timestamps.length}`
      );
    }

    const { lane } = this.ensureCompactionLane(memberSeriesIds);

    for (let i = 0; i < memberSeriesIds.length; i++) {
      const values = requireDefined(valuesByMember[i], `missing compacted member values ${i}`);
      if (values.length !== this.chunkSize) {
        throw new RangeError(
          `appendCompactedWindow: expected ${this.chunkSize} values for member ${i}, got ${values.length}`
        );
      }
    }

    let tsChunk: TimestampChunk;
    if (this.tsCodec) {
      tsChunk = {
        compressed: this.tsCodec.encodeTimestamps(timestamps),
        minT: requireDefined(timestamps[0], "missing first timestamp in compacted window"),
        maxT: requireDefined(
          timestamps[this.chunkSize - 1],
          "missing last timestamp in compacted window"
        ),
        count: this.chunkSize,
      };
    } else {
      tsChunk = {
        timestamps: timestamps.slice(),
        minT: requireDefined(timestamps[0], "missing first timestamp in compacted window"),
        maxT: requireDefined(
          timestamps[this.chunkSize - 1],
          "missing last timestamp in compacted window"
        ),
        count: this.chunkSize,
      };
    }

    const blobs: Uint8Array[] = [];
    const allStats: ChunkStats[] = [];
    const hasBatch = typeof this.valuesCodec.encodeBatchValuesWithStats === "function";
    const hasWasmStats = typeof this.valuesCodec.encodeValuesWithStats === "function";

    if (hasBatch) {
      const BATCH_CAP = 32;
      for (let bStart = 0; bStart < valuesByMember.length; bStart += BATCH_CAP) {
        const bEnd = Math.min(bStart + BATCH_CAP, valuesByMember.length);
        const arrays: Float64Array[] = [];
        const encodeBatchValuesWithStats = requireDefined(
          this.valuesCodec.encodeBatchValuesWithStats,
          "missing batch values encoder"
        );
        for (let i = bStart; i < bEnd; i++) {
          arrays.push(
            requireDefined(valuesByMember[i], `missing compacted values for member ${i}`)
          );
        }
        const results = encodeBatchValuesWithStats(arrays);
        for (let i = 0; i < results.length; i++) {
          const { compressed, stats } = requireDefined(results[i], `missing batch result ${i}`);
          blobs.push(compressed);
          allStats.push(stats);
        }
      }
    } else {
      for (let i = 0; i < valuesByMember.length; i++) {
        const values = requireDefined(
          valuesByMember[i],
          `missing compacted values for member ${i}`
        );
        let compressed: Uint8Array;
        let stats: ChunkStats;
        if (hasWasmStats) {
          const encodeValuesWithStats = requireDefined(
            this.valuesCodec.encodeValuesWithStats,
            "missing values-with-stats encoder"
          );
          const result = encodeValuesWithStats(values);
          compressed = result.compressed;
          stats = result.stats;
        } else {
          compressed = this.valuesCodec.encodeValues(values);
          stats = computeStats(values);
        }
        blobs.push(compressed);
        allStats.push(stats);
      }
    }

    let totalBytes = 0;
    for (const blob of blobs) totalBytes += blob.byteLength;
    const valueBuffer = new Uint8Array(totalBytes);
    const offsets = new Uint32Array(memberSeriesIds.length);
    const sizes = new Uint32Array(memberSeriesIds.length);
    const packedStats = new Float64Array(memberSeriesIds.length * PACKED_STATS_STRIDE);

    let pos = 0;
    for (let i = 0; i < memberSeriesIds.length; i++) {
      const blob = requireDefined(blobs[i], `missing compacted blob ${i}`);
      valueBuffer.set(blob, pos);
      offsets[i] = pos;
      sizes[i] = blob.byteLength;
      pos += blob.byteLength;

      const st = requireDefined(allStats[i], `missing compacted stats ${i}`);
      const si = i * PACKED_STATS_STRIDE;
      packedStats[si] = st.minV;
      packedStats[si + 1] = st.maxV;
      packedStats[si + 2] = st.sum;
      packedStats[si + 3] = st.count;
      packedStats[si + 4] = st.lastV;
    }

    const tsChunkIndex = lane.frozenTimestamps.length;
    lane.frozenTimestamps.push(tsChunk);
    lane.rowGroups.push({
      valueBuffer,
      offsets,
      sizes,
      packedStats,
      tsChunkIndex,
      memberCount: memberSeriesIds.length,
    });
    this._sampleCount += memberSeriesIds.length * this.chunkSize;
  }

  private ensureCompactionLane(memberSeriesIds: readonly SeriesId[]): { lane: GroupLane } {
    const firstSeriesId = requireDefined(memberSeriesIds[0], "missing first compacted member id");
    const firstState = this.getActiveState(firstSeriesId);
    const groupId = firstState.series.groupId;
    let canReuseLane = firstState.segment.hot.count === 0 && firstState.lane.hotCount === 0;
    let lane = firstState.lane;
    let laneId = firstState.segment.laneId;

    if (lane.members.length !== memberSeriesIds.length) {
      canReuseLane = false;
    }

    for (let i = 0; i < memberSeriesIds.length; i++) {
      const seriesId = requireDefined(memberSeriesIds[i], `missing compacted member id ${i}`);
      const state = this.getActiveState(seriesId);
      if (state.series.groupId !== groupId) {
        throw new RangeError(
          `appendCompactedWindow members must share one group: series=${seriesId} group=${state.series.groupId} expectedGroup=${groupId}`
        );
      }
      if (state.segment.hot.count !== 0) {
        throw new RangeError(
          `appendCompactedWindow requires empty member hot state for series ${seriesId}, got ${state.segment.hot.count}`
        );
      }
      if (
        state.segment.laneId !== laneId ||
        state.segment.laneMemberIndex !== i ||
        lane.members.length !== memberSeriesIds.length
      ) {
        canReuseLane = false;
      }
    }

    if (canReuseLane) {
      return { lane };
    }

    const group = this.getGroup(groupId);
    lane = createLane(this.chunkSize);
    group.lanes.push(lane);
    laneId = group.lanes.length - 1;
    for (let i = 0; i < memberSeriesIds.length; i++) {
      const seriesId = requireDefined(memberSeriesIds[i], `missing compacted member id ${i}`);
      this.attachSegmentToLane(seriesId, laneId, lane, true);
    }
    return { lane };
  }

  private canDrainLaneWindow(
    lane: GroupLane,
    rowGroupCount: number,
    expectedChunkSize: number
  ): boolean {
    if (lane.rowGroups.length < rowGroupCount || lane.frozenTimestamps.length < rowGroupCount) {
      return false;
    }

    const firstGroup = requireDefined(lane.rowGroups[0], "missing first compactable row group");
    if (firstGroup.memberCount === 0) return false;

    for (let i = 0; i < rowGroupCount; i++) {
      const rowGroup = requireDefined(lane.rowGroups[i], `missing compactable row group ${i}`);
      if (rowGroup.memberCount !== firstGroup.memberCount || rowGroup.tsChunkIndex !== i) {
        return false;
      }
      const tsChunk = requireDefined(
        lane.frozenTimestamps[i],
        `missing compactable timestamp chunk ${i}`
      );
      if (tsChunk.count !== expectedChunkSize) {
        return false;
      }
    }
    return true;
  }

  private attachInitialSegment(seriesId: SeriesId, groupId: number): void {
    const group = this.getGroup(groupId);
    let laneId = group.lanes.length - 1;
    let lane = requireDefined(group.lanes[laneId], `missing lane ${laneId} for group ${groupId}`);
    // Only attach to the latest lane if it is still open for new members:
    // not full, no in-flight hot writes, and no frozen row groups. A lane
    // with frozen content but hotCount === 0 still has historical members
    // pinned at count=0, which would peg maybeFreeze()'s minCount to 0 and
    // prevent the new series from ever freezing — it would then waste two
    // hot windows growing before rolling to a fresh lane.
    if (
      lane.members.length >= this.maxSeriesPerLane ||
      lane.hotCount > 0 ||
      lane.rowGroups.length > 0
    ) {
      lane = createLane(this.chunkSize);
      group.lanes.push(lane);
      laneId = group.lanes.length - 1;
    }
    this.attachSegmentToLane(seriesId, laneId, lane, false);
  }

  private attachSegmentToLane(
    seriesId: SeriesId,
    laneId: number,
    lane: GroupLane,
    activate: boolean
  ): LaneSegment {
    const series = requireDefined(this.allSeries[seriesId], `unknown series id ${seriesId}`);
    const segment: LaneSegment = {
      laneId,
      laneMemberIndex: lane.members.length,
      // Allocate hot write space lazily. Many segments, especially cold-tier
      // compaction targets, may never receive any direct hot appends.
      hot: { values: new Float64Array(0), count: 0 },
    };
    const segmentIndex = series.segments.length;
    series.segments.push(segment);
    lane.members.push({ seriesId, segmentIndex });
    if (activate) {
      series.activeSegmentIndex = segmentIndex;
    }
    return segment;
  }

  private rollSeriesToFreshLane(seriesId: SeriesId): {
    series: LaneSeries;
    segment: LaneSegment;
    lane: GroupLane;
  } {
    const series = requireDefined(this.allSeries[seriesId], `unknown series id ${seriesId}`);
    const group = this.getGroup(series.groupId);
    const lane = createLane(this.chunkSize);
    group.lanes.push(lane);
    const laneId = group.lanes.length - 1;
    const segment = this.attachSegmentToLane(seriesId, laneId, lane, true);
    return { series, segment, lane };
  }

  private getActiveState(seriesId: SeriesId): {
    series: LaneSeries;
    segment: LaneSegment;
    lane: GroupLane;
  } {
    const series = requireDefined(this.allSeries[seriesId], `unknown series id ${seriesId}`);
    const segment = requireDefined(
      series.segments[series.activeSegmentIndex],
      `missing active segment ${series.activeSegmentIndex} for series ${seriesId}`
    );
    const lane = this.getLane(series.groupId, segment.laneId);
    return { series, segment, lane };
  }

  private getGroup(groupId: number): SeriesGroup {
    return requireDefined(this.groups[groupId], `missing group ${groupId}`);
  }

  private getLane(groupId: number, laneId: number): GroupLane {
    const group = this.getGroup(groupId);
    return requireDefined(group.lanes[laneId], `missing lane ${laneId} for group ${groupId}`);
  }

  private ensureWriteSpace(seriesId: SeriesId): {
    series: LaneSeries;
    segment: LaneSegment;
    lane: GroupLane;
  } {
    let state = this.getActiveState(seriesId);
    if (state.segment.hot.values.length > state.segment.hot.count) {
      // Lane hotTimestamps may have shrunk on a previous freeze (e.g. when a
      // new segment attaches to a freshly frozen lane with a 0-length ts
      // buffer). Grow it to match the segment's capacity so leader writes
      // fit in-bounds.
      if (state.lane.hotTimestamps.length < state.segment.hot.values.length) {
        const newTs = new BigInt64Array(state.segment.hot.values.length);
        newTs.set(state.lane.hotTimestamps);
        state.lane.hotTimestamps = newTs;
      }
      return state;
    }

    const countBefore = state.segment.hot.count;
    this.maybeFreeze(state.lane);
    state = this.getActiveState(seriesId);
    // maybeFreeze slices hot.values to exactly the remaining count, so
    // values.length === count after a freeze. Only return early if the freeze
    // actually opened up space; otherwise fall through to the grow path so
    // appendBatch never sees a zero-space state and spins forever.
    if (
      state.segment.hot.count < countBefore &&
      state.segment.hot.values.length > state.segment.hot.count
    ) {
      return state;
    }

    const maxHotSamples = this.chunkSize * this.maxHotWindowsPerLane;
    if (state.segment.hot.values.length >= maxHotSamples) {
      state = this.rollSeriesToFreshLane(seriesId);
    }

    const newSize = state.segment.hot.values.length + this.chunkSize;
    const newVals = new Float64Array(newSize);
    newVals.set(state.segment.hot.values);
    state.segment.hot.values = newVals;
    if (state.lane.hotTimestamps.length < newSize) {
      const newTs = new BigInt64Array(newSize);
      newTs.set(state.lane.hotTimestamps);
      state.lane.hotTimestamps = newTs;
    }
    return state;
  }

  private maybeFreeze(lane: GroupLane): void {
    let minCount = Infinity;
    for (const member of lane.members) {
      const segment = requireDefined(
        requireDefined(this.allSeries[member.seriesId], `unknown series id ${member.seriesId}`)
          .segments[member.segmentIndex],
        `missing segment ${member.segmentIndex} for series ${member.seriesId}`
      );
      if (segment.hot.count < minCount) minCount = segment.hot.count;
    }

    const chunksToFreeze = Math.floor(minCount / this.chunkSize);
    if (chunksToFreeze === 0) return;

    const hasBatch = typeof this.valuesCodec.encodeBatchValuesWithStats === "function";
    const hasWasmStats = typeof this.valuesCodec.encodeValuesWithStats === "function";
    const numMembers = lane.members.length;

    for (let c = 0; c < chunksToFreeze; c++) {
      const chunkStart = c * this.chunkSize;
      const ts = lane.hotTimestamps.slice(chunkStart, chunkStart + this.chunkSize);
      const tsChunkIndex = lane.frozenTimestamps.length;

      if (this.tsCodec) {
        const compressed = this.tsCodec.encodeTimestamps(ts);
        lane.frozenTimestamps.push({
          compressed,
          minT: requireDefined(ts[0], "missing first timestamp while freezing lane"),
          maxT: requireDefined(
            ts[this.chunkSize - 1],
            "missing last timestamp while freezing lane"
          ),
          count: this.chunkSize,
        });
      } else {
        lane.frozenTimestamps.push({
          timestamps: ts,
          minT: requireDefined(ts[0], "missing first timestamp while freezing lane"),
          maxT: requireDefined(
            ts[this.chunkSize - 1],
            "missing last timestamp while freezing lane"
          ),
          count: this.chunkSize,
        });
      }

      const blobs: Uint8Array[] = [];
      const allStats: ChunkStats[] = [];

      if (hasBatch) {
        const BATCH_CAP = 32;
        for (let bStart = 0; bStart < numMembers; bStart += BATCH_CAP) {
          const bEnd = Math.min(bStart + BATCH_CAP, numMembers);
          const arrays: Float64Array[] = [];
          const encodeBatchValuesWithStats = requireDefined(
            this.valuesCodec.encodeBatchValuesWithStats,
            "missing batch values encoder"
          );
          for (let m = bStart; m < bEnd; m++) {
            const member = requireDefined(lane.members[m], `missing lane member ${m}`);
            const segment = requireDefined(
              requireDefined(
                this.allSeries[member.seriesId],
                `unknown series id ${member.seriesId}`
              ).segments[member.segmentIndex],
              `missing segment ${member.segmentIndex} for series ${member.seriesId}`
            );
            arrays.push(segment.hot.values.subarray(chunkStart, chunkStart + this.chunkSize));
          }
          const results = encodeBatchValuesWithStats(arrays);
          for (let m = 0; m < results.length; m++) {
            const { compressed, stats } = requireDefined(results[m], `missing batch result ${m}`);
            blobs.push(compressed);
            allStats.push(stats);
          }
        }
      } else {
        for (const member of lane.members) {
          const segment = requireDefined(
            requireDefined(this.allSeries[member.seriesId], `unknown series id ${member.seriesId}`)
              .segments[member.segmentIndex],
            `missing segment ${member.segmentIndex} for series ${member.seriesId}`
          );
          const vals = segment.hot.values.subarray(chunkStart, chunkStart + this.chunkSize);

          let compressed: Uint8Array;
          let stats: ChunkStats;
          if (hasWasmStats) {
            const encodeValuesWithStats = requireDefined(
              this.valuesCodec.encodeValuesWithStats,
              "missing values-with-stats encoder"
            );
            const result = encodeValuesWithStats(vals);
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

      let totalBytes = 0;
      for (const b of blobs) totalBytes += b.byteLength;

      const valueBuffer = new Uint8Array(totalBytes);
      const offsets = new Uint32Array(numMembers);
      const sizes = new Uint32Array(numMembers);
      const packedStats = new Float64Array(numMembers * PACKED_STATS_STRIDE);

      let pos = 0;
      for (let m = 0; m < numMembers; m++) {
        const blob = requireDefined(blobs[m], `missing blob ${m}`);
        valueBuffer.set(blob, pos);
        offsets[m] = pos;
        sizes[m] = blob.byteLength;
        pos += blob.byteLength;

        const st = requireDefined(allStats[m], `missing stats ${m}`);
        const si = m * PACKED_STATS_STRIDE;
        packedStats[si] = st.minV;
        packedStats[si + 1] = st.maxV;
        packedStats[si + 2] = st.sum;
        packedStats[si + 3] = st.count;
        packedStats[si + 4] = st.lastV;
      }

      lane.rowGroups.push({
        valueBuffer,
        offsets,
        sizes,
        packedStats,
        tsChunkIndex,
        memberCount: numMembers,
      });
    }

    const frozenSamples = chunksToFreeze * this.chunkSize;
    for (const member of lane.members) {
      const segment = requireDefined(
        requireDefined(this.allSeries[member.seriesId], `unknown series id ${member.seriesId}`)
          .segments[member.segmentIndex],
        `missing segment ${member.segmentIndex} for series ${member.seriesId}`
      );
      // Slice bounds: segment.hot.count is the leader's high-water mark for
      // populated samples, so [frozenSamples, segment.hot.count) is exactly
      // `remaining` entries — no off-by-one. ensureWriteSpace() will grow the
      // buffer back on the next append, so shrinking to the live count here
      // is what keeps stalled-lane overhead bounded.
      const remaining = segment.hot.count - frozenSamples;
      if (remaining > 0) {
        segment.hot.values = segment.hot.values.slice(frozenSamples, segment.hot.count);
      } else {
        segment.hot.values = new Float64Array(0);
      }
      segment.hot.count = Math.max(remaining, 0);
    }

    const tsRemaining = lane.hotCount - frozenSamples;
    if (tsRemaining > 0) {
      lane.hotTimestamps = lane.hotTimestamps.slice(frozenSamples, lane.hotCount);
    } else {
      lane.hotTimestamps = new BigInt64Array(0);
    }
    lane.hotCount = Math.max(tsRemaining, 0);
  }
}
