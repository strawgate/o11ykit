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

type PromotedLanePage = PromotedLaneWindow & {
  minT: bigint;
  maxT: bigint;
  retired: boolean;
};

type PromotedSeriesRef = {
  page: PromotedLanePage;
  memberIndex: number;
  rowGroupIndex: number;
};

type PromotedLane = {
  groupId: number;
  laneId: number;
  memberSeriesIds: readonly SeriesId[];
  pages: PromotedLanePage[];
  head: number;
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

  private readonly lanesByKey = new Map<string, PromotedLane>();
  private readonly activeSeries = new Set<number>();
  private readonly activePartCounts: number[] = [];
  private readonly seriesRefs: PromotedSeriesRef[][] = [];
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
    return this.activeSeries.size;
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  promoteWindow(
    window: RowGroupStorePromotedLaneWindow,
    globalSeriesIds: readonly SeriesId[]
  ): void {
    const lane = this.getOrCreateLane(window.groupId, window.laneId, globalSeriesIds);
    const firstChunk = requireDefined(
      window.timestampChunks[0],
      "missing first promoted timestamp chunk"
    );
    const lastChunk = requireDefined(
      window.timestampChunks[window.timestampChunks.length - 1],
      "missing last promoted timestamp chunk"
    );
    const page: PromotedLanePage = {
      groupId: window.groupId,
      laneId: window.laneId,
      memberSeriesIds: globalSeriesIds.slice(),
      timestampChunks: window.timestampChunks,
      rowGroups: window.rowGroups,
      sampleCount: window.sampleCount,
      minT: firstChunk.minT,
      maxT: lastChunk.maxT,
      retired: false,
    };
    lane.pages.push(page);
    this._sampleCount += window.sampleCount;
    this.adjustActiveSeries(globalSeriesIds, window.rowGroups.length);
    this.appendSeriesRefs(page, globalSeriesIds);
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
    const lane = this.lanesByKey.get(laneKey(groupId, laneId));
    if (!lane) {
      return undefined;
    }
    const remaining = lane.pages.length - lane.head;
    if (remaining < windowCount) {
      return undefined;
    }
    for (let i = 0; i < windowCount; i++) {
      const page = requireDefined(
        lane.pages[lane.head + i],
        `missing promoted lane page ${lane.head + i} for ${groupId}:${laneId}`
      );
      if (
        page.timestampChunks.length !== 1 ||
        page.rowGroups.length !== 1 ||
        page.timestampChunks[0]?.count !== expectedChunkSize
      ) {
        return undefined;
      }
    }
    return lane.pages.slice(lane.head, lane.head + windowCount);
  }

  commitCompactedLaneWindows(windows: readonly PromotedLaneWindow[]): void {
    if (windows.length === 0) {
      return;
    }
    const firstWindow = windows[0];
    const lane = this.lanesByKey.get(
      laneKey(
        requireDefined(firstWindow?.groupId, "missing compacted promoted group id"),
        requireDefined(firstWindow?.laneId, "missing compacted promoted lane id")
      )
    );
    if (!lane) {
      throw new RangeError("commitCompactedLaneWindows received unknown promoted lane");
    }
    const activePages = lane.pages.slice(lane.head, lane.head + windows.length);
    if (activePages.length !== windows.length) {
      throw new RangeError("commitCompactedLaneWindows received too many windows");
    }

    let removedSamples = 0;
    let removedPartCount = 0;
    for (let i = 0; i < windows.length; i++) {
      const expected = requireDefined(activePages[i], `missing compacted promoted page ${i}`);
      const received = requireDefined(windows[i], `missing compacted promoted window ${i}`);
      if (expected !== received) {
        throw new RangeError("commitCompactedLaneWindows received windows out of order");
      }
      removedSamples += expected.sampleCount;
      removedPartCount += expected.rowGroups.length;
      expected.retired = true;
    }

    this._sampleCount -= removedSamples;
    this.adjustActiveSeries(lane.memberSeriesIds, -removedPartCount);
    lane.head += windows.length;
    this.maybeTrimLane(lane);
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
    if ((this.activePartCounts[id] ?? 0) < 1) {
      return;
    }
    this.scanSeriesRefs(id, start, end, visit);
  }

  layoutSummary(): PromotedPartLayoutSummary {
    let windowCount = 0;
    let partCount = 0;
    let timestampChunkCount = 0;
    let memberTotal = 0;
    for (const lane of this.lanesByKey.values()) {
      for (let i = lane.head; i < lane.pages.length; i++) {
        const page = requireDefined(lane.pages[i], `missing promoted page ${i}`);
        windowCount++;
        timestampChunkCount += page.timestampChunks.length;
        memberTotal += page.memberSeriesIds.length;
        partCount += page.timestampChunks.length * page.memberSeriesIds.length;
      }
    }
    return {
      windowCount,
      partCount,
      timestampChunkCount,
      avgMembersPerWindow: windowCount > 0 ? Number((memberTotal / windowCount).toFixed(2)) : 0,
    };
  }

  memoryBytes(): number {
    let bytes = 0;
    for (const lane of this.lanesByKey.values()) {
      for (let i = lane.head; i < lane.pages.length; i++) {
        const page = requireDefined(lane.pages[i], `missing promoted page ${i}`);
        for (const timestampChunk of page.timestampChunks) {
          if (timestampChunk.compressed) {
            bytes += timestampChunk.compressed.byteLength;
          }
          if (timestampChunk.timestamps) {
            bytes += timestampChunk.timestamps.byteLength;
          }
        }
        for (const rowGroup of page.rowGroups) {
          bytes += rowGroup.valueBuffer.byteLength;
          bytes += rowGroup.offsets.byteLength;
          bytes += rowGroup.sizes.byteLength;
          bytes += rowGroup.packedStats.byteLength;
        }
      }
    }
    return bytes;
  }

  memoryBytesExcludingLabels(): number {
    return this.memoryBytes();
  }

  private getOrCreateLane(
    groupId: number,
    laneId: number,
    globalSeriesIds: readonly SeriesId[]
  ): PromotedLane {
    const key = laneKey(groupId, laneId);
    const existing = this.lanesByKey.get(key);
    if (existing) {
      if (!sameSeriesIds(existing.memberSeriesIds, globalSeriesIds)) {
        throw new RangeError(`promoted lane ${groupId}:${laneId} changed member layout`);
      }
      return existing;
    }

    const lane: PromotedLane = {
      groupId,
      laneId,
      memberSeriesIds: globalSeriesIds.slice(),
      pages: [],
      head: 0,
    };
    this.lanesByKey.set(key, lane);
    for (let memberIndex = 0; memberIndex < globalSeriesIds.length; memberIndex++) {
      const globalId = requireDefined(
        globalSeriesIds[memberIndex],
        `missing global series id for promoted member ${memberIndex}`
      );
      this.activePartCounts[globalId] ??= 0;
      this.seriesRefs[globalId] ??= [];
    }
    return lane;
  }

  private appendSeriesRefs(page: PromotedLanePage, globalSeriesIds: readonly SeriesId[]): void {
    for (let memberIndex = 0; memberIndex < globalSeriesIds.length; memberIndex++) {
      const globalId = requireDefined(
        globalSeriesIds[memberIndex],
        `missing global series id for promoted ref member ${memberIndex}`
      );
      let refs = this.seriesRefs[globalId];
      if (!refs) {
        refs = [];
        this.seriesRefs[globalId] = refs;
      }
      for (let rowGroupIndex = 0; rowGroupIndex < page.rowGroups.length; rowGroupIndex++) {
        refs.push({ page, memberIndex, rowGroupIndex });
      }
    }
  }

  private adjustActiveSeries(globalSeriesIds: readonly SeriesId[], delta: number): void {
    if (delta === 0) {
      return;
    }
    for (const globalId of globalSeriesIds) {
      const next = (this.activePartCounts[globalId] ?? 0) + delta;
      if (next < 0) {
        throw new RangeError(`promoted active-part count went negative for series ${globalId}`);
      }
      this.activePartCounts[globalId] = next;
      if (next === 0) {
        this.activeSeries.delete(globalId);
      } else {
        this.activeSeries.add(globalId);
      }
    }
  }

  private maybeTrimLane(lane: PromotedLane): void {
    if (lane.head === 0) {
      return;
    }
    if (lane.head >= lane.pages.length) {
      lane.pages.length = 0;
      lane.head = 0;
      return;
    }
    if (lane.head >= 32 && lane.head * 2 >= lane.pages.length) {
      lane.pages.splice(0, lane.head);
      lane.head = 0;
    }
  }

  private scanSeriesRefs(
    id: SeriesId,
    start: bigint,
    end: bigint,
    visit: (part: TimeRange) => void
  ): void {
    const refs = this.seriesRefs[id];
    if (!refs || refs.length === 0) {
      return;
    }
    let trimPrefix = 0;
    for (let i = 0; i < refs.length; i++) {
      const ref = requireDefined(refs[i], `missing promoted series ref ${i}`);
      if (ref.page.retired) {
        if (i === trimPrefix) {
          trimPrefix++;
        }
        continue;
      }
      this.visitPagePart(ref.page, ref.memberIndex, ref.rowGroupIndex, start, end, visit);
    }
    if (trimPrefix >= 32 && trimPrefix * 2 >= refs.length) {
      refs.splice(0, trimPrefix);
    }
  }

  private visitPagePart(
    page: PromotedLanePage,
    memberIndex: number,
    rowGroupIndex: number,
    start: bigint,
    end: bigint,
    visit: (part: TimeRange) => void
  ): void {
    const timestampChunk = requireDefined(
      page.timestampChunks[rowGroupIndex],
      `missing promoted timestamp chunk ${rowGroupIndex}`
    );
    const chunkMinT = timestampChunk.minT;
    const chunkMaxT = timestampChunk.maxT;
    if (chunkMaxT < start || chunkMinT > end) {
      return;
    }

    const rowGroup = requireDefined(
      page.rowGroups[rowGroupIndex],
      `missing promoted row group ${rowGroupIndex}`
    );
    const offset = requireDefined(
      rowGroup.offsets[memberIndex],
      `missing promoted offset for member ${memberIndex}`
    );
    const size = requireDefined(
      rowGroup.sizes[memberIndex],
      `missing promoted size for member ${memberIndex}`
    );
    const compressedValues = rowGroup.valueBuffer.subarray(offset, offset + size);

    if (this.rangeCodec && this.tsCodec) {
      const compressedTimestamps = requireDefined(
        timestampChunk.compressed,
        `missing promoted compressed timestamps for chunk ${rowGroupIndex}`
      );
      if (chunkMinT >= start && chunkMaxT <= end) {
        visit({
          timestamps: EMPTY_TIMESTAMPS,
          values: EMPTY_VALUES,
          statsPacked: rowGroup.packedStats,
          statsOffset: memberIndex * PACKED_STATS_STRIDE,
          chunkMinT,
          chunkMaxT,
          decode: decodeRangePromotedPart,
          _rangeCodec: this.rangeCodec,
          _compressedTimestamps: compressedTimestamps,
          _compressedValues: compressedValues,
          _startT: chunkMinT,
          _endT: chunkMaxT,
        } as LazyPromotedPart);
        return;
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
      return;
    }

    if (!timestampChunk.timestamps && this.tsCodec && timestampChunk.compressed) {
      timestampChunk.timestamps = this.tsCodec.decodeTimestamps(timestampChunk.compressed);
    }
    const timestamps = requireDefined(
      timestampChunk.timestamps,
      `missing promoted decoded timestamps for chunk ${rowGroupIndex}`
    );
    if (chunkMinT >= start && chunkMaxT <= end) {
      visit({
        timestamps: EMPTY_TIMESTAMPS,
        values: EMPTY_VALUES,
        statsPacked: rowGroup.packedStats,
        statsOffset: memberIndex * PACKED_STATS_STRIDE,
        chunkMinT,
        chunkMaxT,
        decode: decodeFullPromotedPart,
        _timestampsRef: timestamps,
        _compressedValues: compressedValues,
        _valuesCodec: this.valuesCodec,
      } as LazyPromotedPart);
      return;
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

function laneKey(groupId: number, laneId: number): string {
  return `${groupId}:${laneId}`;
}
