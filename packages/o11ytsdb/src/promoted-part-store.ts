import { concatRanges, lowerBound, upperBound } from "./binary-search.js";
import type {
  RowGroupStorePromotedChunk,
  RowGroupStorePromotedLaneWindow,
  RowGroupStorePromotedTimestampChunk,
} from "./row-group-store.js";
import type {
  RangeDecodeCodec,
  SeriesId,
  TimeRange,
  TimestampCodec,
  ValuesCodec,
} from "./types.js";

const EMPTY_TIMESTAMPS = new BigInt64Array(0);
const EMPTY_VALUES = new Float64Array(0);
const PACKED_STATS_STRIDE = 5;

type LazyPromotedPart = TimeRange & {
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

export type PromotedLaneWindow = {
  groupId: number;
  laneId: number;
  memberSeriesIds: SeriesId[];
  timestampChunks: RowGroupStorePromotedTimestampChunk[];
  rowGroups: RowGroupStorePromotedChunk[];
  sampleCount: number;
};

type PromotedPartRef = {
  window: PromotedLaneWindow;
  rowGroupIndex: number;
  memberIndex: number;
  chunkMinT: bigint;
  chunkMaxT: bigint;
};

export type PromotedPartLayoutSummary = {
  windowCount: number;
  partCount: number;
  timestampChunkCount: number;
  avgMembersPerWindow: number;
};

export type PromotedCompactionLayoutSummary = PromotedPartLayoutSummary;

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new RangeError(message);
  }
  return value;
}

function decodeFullPromotedPart(this: LazyPromotedPart): TimeRange {
  this.timestamps = requireDefined(this._timestampsRef, "missing promoted-part timestamps");
  this.values = requireDefined(this._valuesCodec, "missing values codec").decodeValues(
    requireDefined(this._compressedValues, "missing compressed values")
  );
  return this;
}

function decodePartialPromotedPart(this: LazyPromotedPart): TimeRange {
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

function decodeRangePromotedPart(this: LazyPromotedPart): TimeRange {
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

export class PromotedPartStore {
  readonly name: string;

  private readonly windows: PromotedLaneWindow[] = [];
  private readonly seriesParts: PromotedPartRef[][] = [];
  private readonly materializedSeries = new Set<number>();
  private _sampleCount = 0;
  private readonly valuesCodec: ValuesCodec;
  private readonly tsCodec: TimestampCodec | undefined;
  private readonly rangeCodec: RangeDecodeCodec | undefined;

  constructor(
    valuesCodec: ValuesCodec,
    tsCodec: TimestampCodec | undefined,
    rangeCodec: RangeDecodeCodec | undefined,
    name = `promoted-parts-${valuesCodec.name}`
  ) {
    this.valuesCodec = valuesCodec;
    this.tsCodec = tsCodec;
    this.rangeCodec = rangeCodec;
    this.name = name;
  }

  get seriesCount(): number {
    return this.materializedSeries.size;
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  promoteWindow(
    window: RowGroupStorePromotedLaneWindow,
    globalSeriesIds: readonly SeriesId[]
  ): void {
    const promotedWindow: PromotedLaneWindow = {
      groupId: window.groupId,
      laneId: window.laneId,
      memberSeriesIds: globalSeriesIds.slice(),
      timestampChunks: window.timestampChunks,
      rowGroups: window.rowGroups,
      sampleCount: window.sampleCount,
    };
    this.windows.push(promotedWindow);
    this._sampleCount += window.sampleCount;

    for (let memberIndex = 0; memberIndex < globalSeriesIds.length; memberIndex++) {
      const globalId = requireDefined(
        globalSeriesIds[memberIndex],
        `missing global series id for promoted member ${memberIndex}`
      );
      let parts = this.seriesParts[globalId];
      if (!parts) {
        parts = [];
        this.seriesParts[globalId] = parts;
      }
      this.materializedSeries.add(globalId);
      for (let rowGroupIndex = 0; rowGroupIndex < window.rowGroups.length; rowGroupIndex++) {
        const timestampChunk = requireDefined(
          window.timestampChunks[rowGroupIndex],
          `missing promoted timestamp chunk ${rowGroupIndex}`
        );
        const ref: PromotedPartRef = {
          window: promotedWindow,
          rowGroupIndex,
          memberIndex,
          chunkMinT: timestampChunk.minT,
          chunkMaxT: timestampChunk.maxT,
        };
        this.insertPartRef(parts, ref, globalId);
      }
    }
  }

  peekCompactableLaneWindows(
    groupId: number,
    laneId: number,
    windowCount: number,
    expectedChunkSize: number
  ): PromotedLaneWindow[] | undefined {
    if (windowCount < 1) {
      throw new RangeError(`windowCount must be >= 1, got ${windowCount}`);
    }
    const matches: PromotedLaneWindow[] = [];
    let expectedMembers: readonly SeriesId[] | undefined;
    for (const window of this.windows) {
      if (window.groupId !== groupId || window.laneId !== laneId) {
        continue;
      }
      if (
        window.timestampChunks.length !== 1 ||
        window.rowGroups.length !== 1 ||
        window.timestampChunks[0]?.count !== expectedChunkSize
      ) {
        break;
      }
      if (!expectedMembers) {
        expectedMembers = window.memberSeriesIds;
      } else if (!sameSeriesIds(expectedMembers, window.memberSeriesIds)) {
        break;
      }
      matches.push(window);
      if (matches.length === windowCount) {
        return matches;
      }
    }
    return undefined;
  }

  commitCompactedLaneWindows(windows: readonly PromotedLaneWindow[]): void {
    if (windows.length === 0) {
      return;
    }
    const toRemove = new Set(windows);
    if (toRemove.size !== windows.length) {
      throw new RangeError("commitCompactedLaneWindows received duplicate windows");
    }
    const remaining = this.windows.filter((window) => !toRemove.has(window));
    if (remaining.length + toRemove.size !== this.windows.length) {
      throw new RangeError("commitCompactedLaneWindows received unknown promoted window");
    }

    this.windows.length = 0;
    this.windows.push(...remaining);
    this.rebuildSeriesParts();
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
    const parts = this.seriesParts[id];
    if (!parts || parts.length === 0) {
      return;
    }
    for (const part of parts) {
      if (part.chunkMaxT < start || part.chunkMinT > end) {
        continue;
      }

      const timestampChunk = requireDefined(
        part.window.timestampChunks[part.rowGroupIndex],
        `missing promoted timestamp chunk ${part.rowGroupIndex}`
      );
      const rowGroup = requireDefined(
        part.window.rowGroups[part.rowGroupIndex],
        `missing promoted row group ${part.rowGroupIndex}`
      );
      const offset = requireDefined(
        rowGroup.offsets[part.memberIndex],
        `missing promoted offset for member ${part.memberIndex}`
      );
      const size = requireDefined(
        rowGroup.sizes[part.memberIndex],
        `missing promoted size for member ${part.memberIndex}`
      );
      const compressedValues = rowGroup.valueBuffer.subarray(offset, offset + size);

      if (this.rangeCodec && this.tsCodec) {
        const compressedTimestamps = requireDefined(
          timestampChunk.compressed,
          `missing promoted compressed timestamps for chunk ${part.rowGroupIndex}`
        );
        if (part.chunkMinT >= start && part.chunkMaxT <= end) {
          visit({
            timestamps: EMPTY_TIMESTAMPS,
            values: EMPTY_VALUES,
            statsPacked: rowGroup.packedStats,
            statsOffset: part.memberIndex * PACKED_STATS_STRIDE,
            chunkMinT: part.chunkMinT,
            chunkMaxT: part.chunkMaxT,
            decode: decodeRangePromotedPart,
            _rangeCodec: this.rangeCodec,
            _compressedTimestamps: compressedTimestamps,
            _compressedValues: compressedValues,
            _startT: part.chunkMinT,
            _endT: part.chunkMaxT,
          } as LazyPromotedPart);
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
        continue;
      }

      if (!timestampChunk.timestamps && this.tsCodec && timestampChunk.compressed) {
        timestampChunk.timestamps = this.tsCodec.decodeTimestamps(timestampChunk.compressed);
      }
      const timestamps = requireDefined(
        timestampChunk.timestamps,
        `missing promoted decoded timestamps for chunk ${part.rowGroupIndex}`
      );
      if (part.chunkMinT >= start && part.chunkMaxT <= end) {
        visit({
          timestamps: EMPTY_TIMESTAMPS,
          values: EMPTY_VALUES,
          statsPacked: rowGroup.packedStats,
          statsOffset: part.memberIndex * PACKED_STATS_STRIDE,
          chunkMinT: part.chunkMinT,
          chunkMaxT: part.chunkMaxT,
          decode: decodeFullPromotedPart,
          _timestampsRef: timestamps,
          _compressedValues: compressedValues,
          _valuesCodec: this.valuesCodec,
        } as LazyPromotedPart);
        continue;
      }

      const lo = lowerBound(timestamps, start, 0, timestampChunk.count);
      const hi = upperBound(timestamps, end, lo, timestampChunk.count);
      if (hi > lo) {
        visit({
          timestamps: timestamps.subarray(lo, hi),
          values: EMPTY_VALUES,
          decode: decodePartialPromotedPart,
          _compressedValues: compressedValues,
          _valuesCodec: this.valuesCodec,
          _lo: lo,
          _hi: hi,
        } as LazyPromotedPart);
      }
    }
  }

  layoutSummary(): PromotedPartLayoutSummary {
    let partCount = 0;
    let timestampChunkCount = 0;
    let memberTotal = 0;
    for (const window of this.windows) {
      timestampChunkCount += window.timestampChunks.length;
      memberTotal += window.memberSeriesIds.length;
      partCount += window.timestampChunks.length * window.memberSeriesIds.length;
    }
    return {
      windowCount: this.windows.length,
      partCount,
      timestampChunkCount,
      avgMembersPerWindow:
        this.windows.length > 0 ? Number((memberTotal / this.windows.length).toFixed(2)) : 0,
    };
  }

  memoryBytes(): number {
    let bytes = 0;
    for (const window of this.windows) {
      for (const timestampChunk of window.timestampChunks) {
        if (timestampChunk.compressed) {
          bytes += timestampChunk.compressed.byteLength;
        }
        if (timestampChunk.timestamps) {
          bytes += timestampChunk.timestamps.byteLength;
        }
      }
      for (const rowGroup of window.rowGroups) {
        bytes += rowGroup.valueBuffer.byteLength;
        bytes += rowGroup.offsets.byteLength;
        bytes += rowGroup.sizes.byteLength;
        bytes += rowGroup.packedStats.byteLength;
      }
    }
    return bytes;
  }

  memoryBytesExcludingLabels(): number {
    return this.memoryBytes();
  }

  private rebuildSeriesParts(): void {
    this.seriesParts.length = 0;
    this.materializedSeries.clear();
    this._sampleCount = 0;

    for (const window of this.windows) {
      this._sampleCount += window.sampleCount;
      for (let memberIndex = 0; memberIndex < window.memberSeriesIds.length; memberIndex++) {
        const globalId = requireDefined(
          window.memberSeriesIds[memberIndex],
          `missing global series id for promoted member ${memberIndex}`
        );
        let parts = this.seriesParts[globalId];
        if (!parts) {
          parts = [];
          this.seriesParts[globalId] = parts;
        }
        this.materializedSeries.add(globalId);
        for (let rowGroupIndex = 0; rowGroupIndex < window.rowGroups.length; rowGroupIndex++) {
          const timestampChunk = requireDefined(
            window.timestampChunks[rowGroupIndex],
            `missing promoted timestamp chunk ${rowGroupIndex}`
          );
          const ref: PromotedPartRef = {
            window,
            rowGroupIndex,
            memberIndex,
            chunkMinT: timestampChunk.minT,
            chunkMaxT: timestampChunk.maxT,
          };
          this.insertPartRef(parts, ref, globalId);
        }
      }
    }
  }

  private insertPartRef(parts: PromotedPartRef[], ref: PromotedPartRef, globalId: SeriesId): void {
    let insertAt = parts.length;
    while (insertAt > 0) {
      const prev = requireDefined(
        parts[insertAt - 1],
        `missing promoted part ${insertAt - 1} for series ${globalId}`
      );
      if (prev.chunkMinT <= ref.chunkMinT) {
        break;
      }
      insertAt--;
    }
    parts.splice(insertAt, 0, ref);
  }
}

function sameSeriesIds(left: readonly SeriesId[], right: readonly SeriesId[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}
