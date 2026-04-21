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

function createLane(chunkSize: number): GroupLane {
  return {
    hotTimestamps: new BigInt64Array(chunkSize),
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
    precision?: number
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
    this.valuesCodec = valuesCodec;
    this.tsCodec = tsCodec;
    this.rangeCodec = rangeCodec;
    this.chunkSize = chunkSize;
    this.name = name ?? `rowgroup-${this.valuesCodec.name}-${chunkSize}-lane${maxSeriesPerLane}`;
    this.labelIndex = labelIndex ?? new LabelIndex();
    if (precision != null) {
      const scale = 10 ** precision;
      this.quantize = (v: number) => Math.round(v * scale) / scale;
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
      const batch = Math.min(space, len - offset);
      const tsSlice = timestamps.subarray(offset, offset + batch);

      if (state.segment.hot.count <= state.lane.hotCount) {
        state.lane.hotTimestamps.set(tsSlice, state.segment.hot.count);
      }

      if (this.quantize) {
        const q = this.quantize;
        for (let i = 0; i < batch; i++) {
          state.segment.hot.values[state.segment.hot.count + i] = q(
            requireDefined(values[offset + i], `missing value at batch index ${offset + i}`)
          );
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
    const series = requireDefined(this.allSeries[id], `unknown series id ${id}`);
    const parts: TimeRange[] = [];

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

          const result = this.rangeCodec.rangeDecodeValues(
            compressedTimestamps,
            compressedValues,
            start,
            end
          );
          if (result.timestamps.length > 0) {
            parts.push(result);
            if (!tsChunk.timestamps) {
              tsChunk.timestamps = this.tsCodec.decodeTimestamps(compressedTimestamps);
            }
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

      if (segment.hot.count > 0) {
        const lo = lowerBound(lane.hotTimestamps, start, 0, segment.hot.count);
        const hi = upperBound(lane.hotTimestamps, end, lo, segment.hot.count);
        if (hi > lo) {
          parts.push({
            timestamps: lane.hotTimestamps.slice(lo, hi),
            values: segment.hot.values.slice(lo, hi),
          });
        }
      }
    }

    return concatRanges(parts);
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
        bytes += lane.hotCount * 8;
        for (const tc of lane.frozenTimestamps) {
          if (tc.compressed) {
            bytes += tc.compressed.byteLength;
          } else if (tc.timestamps) {
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
        bytes += segment.hot.count * 8;
      }
    }

    bytes += this.labelIndex.memoryBytes();
    return bytes;
  }

  private attachInitialSegment(seriesId: SeriesId, groupId: number): void {
    const group = this.getGroup(groupId);
    let laneId = group.lanes.length - 1;
    let lane = requireDefined(group.lanes[laneId], `missing lane ${laneId} for group ${groupId}`);
    if (lane.members.length >= this.maxSeriesPerLane) {
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
      hot: { values: new Float64Array(this.chunkSize), count: 0 },
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
      return state;
    }

    const countBefore = state.segment.hot.count;
    this.maybeFreeze(state.lane);
    state = this.getActiveState(seriesId);
    if (state.segment.hot.count < countBefore) {
      return state;
    }

    const maxHotSamples = this.chunkSize * this.maxHotWindowsPerLane;
    if (state.segment.hot.values.length >= maxHotSamples) {
      return this.rollSeriesToFreshLane(seriesId);
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
      const packedStats = new Float64Array(numMembers * 8);

      let pos = 0;
      for (let m = 0; m < numMembers; m++) {
        const blob = requireDefined(blobs[m], `missing blob ${m}`);
        valueBuffer.set(blob, pos);
        offsets[m] = pos;
        sizes[m] = blob.byteLength;
        pos += blob.byteLength;

        const st = requireDefined(allStats[m], `missing stats ${m}`);
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
      const remaining = segment.hot.count - frozenSamples;
      if (remaining > 0) {
        segment.hot.values.copyWithin(0, frozenSamples, segment.hot.count);
        segment.hot.count = remaining;
      } else {
        segment.hot.count = 0;
      }
    }

    const tsRemaining = lane.hotCount - frozenSamples;
    if (tsRemaining > 0) {
      lane.hotTimestamps.copyWithin(0, frozenSamples, lane.hotCount);
      lane.hotCount = tsRemaining;
    } else {
      lane.hotCount = 0;
    }
  }
}
