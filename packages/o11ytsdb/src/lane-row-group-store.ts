/**
 * Lane row-group store — bounded physical row groups inside a logical group.
 *
 * Unlike RowGroupStore, freeze coordination happens per lane instead of per
 * logical group. This keeps shared timestamps within a bounded set of series
 * while preserving the packed row-group layout for frozen data.
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

interface LaneSeries {
  groupId: number;
  laneId: number;
  laneMemberIndex: number;
  hot: HotValues;
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
  members: SeriesId[];
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

export class LaneRowGroupStore implements StorageBackend {
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
    this.name = name ?? `lane-rowgroup-${this.valuesCodec.name}-${chunkSize}-lane${maxSeriesPerLane}`;
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

    const group = this.groups[groupId]!;
    let laneId = group.lanes.length - 1;
    let lane = group.lanes[laneId]!;
    if (lane.members.length >= this.maxSeriesPerLane) {
      lane = createLane(this.chunkSize);
      group.lanes.push(lane);
      laneId = group.lanes.length - 1;
    }

    const laneMemberIndex = lane.members.length;
    lane.members.push(id);

    this.allSeries.push({
      groupId,
      laneId,
      laneMemberIndex,
      hot: { values: new Float64Array(this.chunkSize), count: 0 },
    });
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    const s = this.allSeries[id]!;
    const lane = this.groups[s.groupId]!.lanes[s.laneId]!;

    if (s.hot.count === lane.hotCount) {
      lane.hotTimestamps[lane.hotCount] = timestamp;
    }

    s.hot.values[s.hot.count] = this.quantize ? this.quantize(value) : value;
    s.hot.count++;
    this._sampleCount++;

    if (s.hot.count > lane.hotCount) {
      lane.hotCount = s.hot.count;
    }

    if (s.hot.count === this.chunkSize) {
      this.maybeFreeze(lane);
    }
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    if (timestamps.length !== values.length) {
      throw new RangeError(
        `appendBatch: timestamps.length (${timestamps.length}) !== values.length (${values.length})`
      );
    }
    if (timestamps.length === 0) return;
    const s = this.allSeries[id]!;
    const lane = this.groups[s.groupId]!.lanes[s.laneId]!;
    let offset = 0;
    const len = timestamps.length;

    while (offset < len) {
      let space = s.hot.values.length - s.hot.count;

      if (space === 0) {
        const countBefore = s.hot.count;
        this.maybeFreeze(lane);
        if (s.hot.count < countBefore) {
          space = s.hot.values.length - s.hot.count;
        } else {
          const newSize = s.hot.values.length + this.chunkSize;
          const newVals = new Float64Array(newSize);
          newVals.set(s.hot.values);
          s.hot.values = newVals;
          if (lane.hotTimestamps.length < newSize) {
            const newTs = new BigInt64Array(newSize);
            newTs.set(lane.hotTimestamps);
            lane.hotTimestamps = newTs;
          }
          space = newSize - s.hot.count;
        }
      }

      const batch = Math.min(space, len - offset);
      const tsSlice = timestamps.subarray(offset, offset + batch);
      if (s.hot.count <= lane.hotCount) {
        lane.hotTimestamps.set(tsSlice, s.hot.count);
      }

      if (this.quantize) {
        const q = this.quantize;
        for (let i = 0; i < batch; i++) {
          s.hot.values[s.hot.count + i] = q(values[offset + i]!);
        }
      } else {
        s.hot.values.set(values.subarray(offset, offset + batch), s.hot.count);
      }
      s.hot.count += batch;
      this._sampleCount += batch;
      offset += batch;

      if (s.hot.count > lane.hotCount) {
        lane.hotCount = s.hot.count;
      }

      if (s.hot.count >= this.chunkSize) {
        this.maybeFreeze(lane);
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
    const s = this.allSeries[id]!;
    const lane = this.groups[s.groupId]!.lanes[s.laneId]!;
    const parts: TimeRange[] = [];

    if (this.rangeCodec && this.tsCodec) {
      for (const rg of lane.rowGroups) {
        if (s.laneMemberIndex >= rg.memberCount) continue;
        const tsChunk = lane.frozenTimestamps[rg.tsChunkIndex]!;
        if (tsChunk.maxT < start || tsChunk.minT > end) continue;

        const compressedValues = rg.valueBuffer.subarray(
          rg.offsets[s.laneMemberIndex]!,
          rg.offsets[s.laneMemberIndex]! + rg.sizes[s.laneMemberIndex]!
        );

        const result = this.rangeCodec.rangeDecodeValues(
          tsChunk.compressed!,
          compressedValues,
          start,
          end
        );
        if (result.timestamps.length > 0) {
          parts.push(result);
          if (!tsChunk.timestamps) {
            tsChunk.timestamps = this.tsCodec.decodeTimestamps(tsChunk.compressed!);
          }
        }
      }
    } else {
      for (const rg of lane.rowGroups) {
        if (s.laneMemberIndex >= rg.memberCount) continue;
        const tsChunk = lane.frozenTimestamps[rg.tsChunkIndex]!;
        if (tsChunk.maxT < start || tsChunk.minT > end) continue;

        if (!tsChunk.timestamps && this.tsCodec && tsChunk.compressed) {
          tsChunk.timestamps = this.tsCodec.decodeTimestamps(tsChunk.compressed);
        }
        const timestamps = tsChunk.timestamps!;

        const compressedValues = rg.valueBuffer.subarray(
          rg.offsets[s.laneMemberIndex]!,
          rg.offsets[s.laneMemberIndex]! + rg.sizes[s.laneMemberIndex]!
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

    if (s.hot.count > 0) {
      const lo = lowerBound(lane.hotTimestamps, start, 0, s.hot.count);
      const hi = upperBound(lane.hotTimestamps, end, lo, s.hot.count);
      if (hi > lo) {
        parts.push({
          timestamps: lane.hotTimestamps.slice(lo, hi),
          values: s.hot.values.slice(lo, hi),
        });
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

    for (const s of this.allSeries) {
      bytes += s.hot.count * 8;
    }

    bytes += this.labelIndex.memoryBytes();
    return bytes;
  }

  private maybeFreeze(lane: GroupLane): void {
    let minCount = Infinity;
    for (const memberId of lane.members) {
      const c = this.allSeries[memberId]!.hot.count;
      if (c < minCount) minCount = c;
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
          minT: ts[0]!,
          maxT: ts[this.chunkSize - 1]!,
          count: this.chunkSize,
        });
      } else {
        lane.frozenTimestamps.push({
          timestamps: ts,
          minT: ts[0]!,
          maxT: ts[this.chunkSize - 1]!,
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
          for (let m = bStart; m < bEnd; m++) {
            const s = this.allSeries[lane.members[m]!]!;
            arrays.push(s.hot.values.subarray(chunkStart, chunkStart + this.chunkSize));
          }
          const results = this.valuesCodec.encodeBatchValuesWithStats!(arrays);
          for (let m = 0; m < results.length; m++) {
            const { compressed, stats } = results[m]!;
            blobs.push(compressed);
            allStats.push(stats);
          }
        }
      } else {
        for (const memberId of lane.members) {
          const s = this.allSeries[memberId]!;
          const vals = s.hot.values.subarray(chunkStart, chunkStart + this.chunkSize);

          let compressed: Uint8Array;
          let stats: ChunkStats;
          if (hasWasmStats) {
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

      let totalBytes = 0;
      for (const b of blobs) totalBytes += b.byteLength;

      const valueBuffer = new Uint8Array(totalBytes);
      const offsets = new Uint32Array(numMembers);
      const sizes = new Uint32Array(numMembers);
      const packedStats = new Float64Array(numMembers * 8);

      let pos = 0;
      for (let m = 0; m < numMembers; m++) {
        const blob = blobs[m]!;
        valueBuffer.set(blob, pos);
        offsets[m] = pos;
        sizes[m] = blob.byteLength;
        pos += blob.byteLength;

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
    for (const memberId of lane.members) {
      const s = this.allSeries[memberId]!;
      const remaining = s.hot.count - frozenSamples;
      if (remaining > 0) {
        s.hot.values.copyWithin(0, frozenSamples, s.hot.count);
        s.hot.count = remaining;
      } else {
        s.hot.count = 0;
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
