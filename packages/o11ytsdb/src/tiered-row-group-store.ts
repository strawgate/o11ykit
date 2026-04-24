import { concatRanges } from "./binary-search.js";
import { LabelIndex } from "./label-index.js";
import { type PromotedLaneWindow, PromotedPartStore } from "./promoted-part-store.js";
import type { RowGroupStorePromotedLaneWindow } from "./row-group-store.js";
import { RowGroupStore } from "./row-group-store.js";
import type {
  Labels,
  RangeDecodeCodec,
  SeriesId,
  StorageBackend,
  TimeRange,
  TimestampCodec,
  ValuesCodec,
} from "./types.js";

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new RangeError(message);
  }
  return value;
}

type TimeRangeWithStartCache = TimeRange & { _startCache?: bigint };
type CompactionLane = { groupId: number; laneId: number };
type CompactionScheduler = (task: () => void) => void;

export type TieredRowGroupStoreOptions = {
  compactionScheduler?: CompactionScheduler | null;
  backgroundLanesPerRun?: number;
};

function partStart(part: TimeRange): bigint {
  const cachedPart = part as TimeRangeWithStartCache;
  if (cachedPart._startCache !== undefined) {
    return cachedPart._startCache;
  }
  if (part.timestamps.length > 0) {
    cachedPart._startCache = requireDefined(part.timestamps[0], "missing first timestamp");
    return cachedPart._startCache;
  }
  if (part.chunkMinT !== undefined) {
    cachedPart._startCache = part.chunkMinT;
    return cachedPart._startCache;
  }
  const decoded = part.decode ? part.decode() : null;
  if (decoded && decoded.timestamps.length > 0) {
    cachedPart._startCache = requireDefined(
      decoded.timestamps[0],
      "missing decoded first timestamp"
    );
    return cachedPart._startCache;
  }
  throw new RangeError("cannot determine part start time");
}

/**
 * Tiered row-group store.
 *
 * Hot ingest lands in small row groups, then sealed hot row groups are
 * promoted directly into an immutable cold-part store.
 */
export class TieredRowGroupStore implements StorageBackend {
  readonly name: string;

  private readonly hotStore: RowGroupStore;
  private readonly promotedStore: PromotedPartStore;
  private readonly compactedStore: RowGroupStore;
  private readonly hotChunkSize: number;
  private readonly coldChunkSize: number;
  private readonly groupResolver: (labels: Labels) => number;
  private readonly labelIndex = new LabelIndex();
  private readonly hotIds: SeriesId[] = [];
  private readonly hotToGlobal: SeriesId[] = [];
  private readonly groupIds: number[] = [];
  private readonly compactedIds: SeriesId[] = [];
  private readonly compactionScheduler: CompactionScheduler | null;
  private readonly backgroundLanesPerRun: number;
  private readonly pendingCompactionKeys = new Set<string>();
  private readonly pendingCompactionLanes: CompactionLane[] = [];
  private compactionScheduled = false;
  private compactionRunning = false;
  private _sampleCount = 0;

  constructor(
    valuesCodec: ValuesCodec,
    hotChunkSize = 80,
    coldChunkSize = 640,
    groupResolver: (labels: Labels) => number = () => 0,
    maxSeriesPerLane = 32,
    name?: string,
    tsCodec?: TimestampCodec,
    rangeCodec?: RangeDecodeCodec,
    precision?: number,
    quantizeBatch?: (values: Float64Array, precision: number) => void,
    options: TieredRowGroupStoreOptions = {}
  ) {
    if (!Number.isFinite(hotChunkSize) || !Number.isInteger(hotChunkSize) || hotChunkSize < 1) {
      throw new RangeError(`hotChunkSize must be a finite integer >= 1, got ${hotChunkSize}`);
    }
    if (
      !Number.isFinite(coldChunkSize) ||
      !Number.isInteger(coldChunkSize) ||
      coldChunkSize < hotChunkSize
    ) {
      throw new RangeError(
        `coldChunkSize must be a finite integer >= hotChunkSize, got ${coldChunkSize}`
      );
    }
    if (coldChunkSize % hotChunkSize !== 0) {
      throw new RangeError(
        `coldChunkSize (${coldChunkSize}) must be an integer multiple of hotChunkSize (${hotChunkSize})`
      );
    }

    this.hotChunkSize = hotChunkSize;
    this.coldChunkSize = coldChunkSize;
    this.groupResolver = groupResolver;
    this.compactionScheduler =
      options.compactionScheduler === undefined
        ? defaultCompactionScheduler()
        : options.compactionScheduler;
    this.backgroundLanesPerRun = Math.max(1, options.backgroundLanesPerRun ?? 1);
    this.hotStore = new RowGroupStore(
      valuesCodec,
      hotChunkSize,
      groupResolver,
      maxSeriesPerLane,
      undefined,
      tsCodec,
      rangeCodec,
      undefined,
      precision,
      quantizeBatch
    );
    this.promotedStore = new PromotedPartStore(valuesCodec, tsCodec, rangeCodec);
    this.compactedStore = new RowGroupStore(
      valuesCodec,
      coldChunkSize,
      groupResolver,
      maxSeriesPerLane,
      undefined,
      tsCodec,
      rangeCodec,
      undefined,
      precision,
      quantizeBatch
    );
    this.name =
      name ??
      `tiered-rowgroup-${valuesCodec.name}-hot${hotChunkSize}-cold${coldChunkSize}-lane${maxSeriesPerLane}`;
  }

  getOrCreateSeries(labels: Labels): SeriesId {
    const { id, isNew } = this.labelIndex.getOrCreate(labels, this.hotIds.length);
    if (!isNew) return id;

    const groupId = this.groupResolver(labels);
    const hotId = this.hotStore.getOrCreateSeries(labels);
    this.hotIds[id] = hotId;
    this.hotToGlobal[hotId] = id;
    this.groupIds[id] = groupId;
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    this.hotStore.append(this.requireHotId(id), timestamp, value);
    this._sampleCount++;
    this.promoteReadyGroup(this.requireGroupId(id));
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    this.hotStore.appendBatch(this.requireHotId(id), timestamps, values);
    this._sampleCount += timestamps.length;
    this.promoteReadyGroup(this.requireGroupId(id));
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
    const hotId = this.requireHotId(id);
    const compactedId = this.compactedIds[id];
    const compactedParts =
      compactedId !== undefined
        ? this.compactedStore.readParts
          ? this.compactedStore.readParts(compactedId, start, end)
          : [this.compactedStore.read(compactedId, start, end)]
        : [];
    const promotedParts = this.promotedStore.readParts(id, start, end);
    const hotParts = this.hotStore.readParts
      ? this.hotStore.readParts(hotId, start, end)
      : [this.hotStore.read(hotId, start, end)];
    mergeSortedPartSources([compactedParts, promotedParts, hotParts], visit);
  }

  labels(id: SeriesId): Labels | undefined {
    return this.labelIndex.labels(id);
  }

  get seriesCount(): number {
    return this.hotIds.length;
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  memoryBytes(): number {
    return (
      this.hotStore.memoryBytesExcludingLabels() +
      this.promotedStore.memoryBytesExcludingLabels() +
      this.compactedStore.memoryBytesExcludingLabels() +
      this.labelIndex.memoryBytes()
    );
  }

  private requireHotId(id: SeriesId): SeriesId {
    return requireDefined(this.hotIds[id], `unknown series id ${id}`);
  }

  private requireGroupId(id: SeriesId): number {
    return requireDefined(this.groupIds[id], `missing group id for series ${id}`);
  }

  drainCompaction(maxLanes: number = Number.POSITIVE_INFINITY): number {
    if (this.compactionRunning) {
      return 0;
    }
    this.compactionRunning = true;
    let processed = 0;
    try {
      while (this.pendingCompactionLanes.length > 0 && processed < maxLanes) {
        const lane = this.pendingCompactionLanes.shift();
        if (!lane) {
          break;
        }
        this.pendingCompactionKeys.delete(compactionLaneKey(lane.groupId, lane.laneId));
        this.compactPromotedLane(lane.groupId, lane.laneId);
        processed++;
      }
    } finally {
      this.compactionRunning = false;
    }
    if (this.pendingCompactionLanes.length > 0) {
      this.scheduleCompaction();
    }
    return processed;
  }

  private promoteReadyGroup(groupId: number): void {
    while (true) {
      const laneWindow = this.hotStore.peekPromotableLaneWindow(groupId, 1, this.hotChunkSize);
      if (!laneWindow) {
        this.scheduleCompaction();
        return;
      }
      this.promoteLane(laneWindow);
      this.hotStore.commitCompactedLaneWindow(laneWindow);
      this.enqueueCompactionLane(groupId, laneWindow.laneId);
    }
  }

  private promoteLane(laneWindow: RowGroupStorePromotedLaneWindow): void {
    const globalSeriesIds = laneWindow.memberSeriesIds.map((hotSeriesId, memberIndex) =>
      requireDefined(
        this.hotToGlobal[hotSeriesId],
        `missing global series mapping for hot series ${hotSeriesId} at member ${memberIndex}`
      )
    );
    this.promotedStore.promoteWindow(laneWindow, globalSeriesIds);
  }

  private compactPromotedLane(groupId: number, laneId: number): void {
    const windowsPerCold = this.coldChunkSize / this.hotChunkSize;
    while (true) {
      const windows = this.promotedStore.peekCompactableLaneWindows(
        groupId,
        laneId,
        windowsPerCold,
        this.hotChunkSize
      );
      if (!windows) {
        return;
      }
      this.compactPromotedWindows(windows);
      this.promotedStore.commitCompactedLaneWindows(windows);
    }
  }

  private enqueueCompactionLane(groupId: number, laneId: number): void {
    const key = compactionLaneKey(groupId, laneId);
    if (this.pendingCompactionKeys.has(key)) {
      return;
    }
    this.pendingCompactionKeys.add(key);
    this.pendingCompactionLanes.push({ groupId, laneId });
  }

  private scheduleCompaction(): void {
    if (
      !this.compactionScheduler ||
      this.compactionScheduled ||
      this.compactionRunning ||
      this.pendingCompactionLanes.length === 0
    ) {
      return;
    }
    this.compactionScheduled = true;
    this.compactionScheduler(() => {
      this.compactionScheduled = false;
      this.drainCompaction(this.backgroundLanesPerRun);
    });
  }

  private compactPromotedWindows(windows: readonly PromotedLaneWindow[]): void {
    const firstWindow = requireDefined(windows[0], "missing first promoted window");
    const memberSeriesIds = firstWindow.memberSeriesIds;
    const compactedIds = this.ensureCompactedIds(memberSeriesIds);
    const timestamps = new BigInt64Array(this.coldChunkSize);
    const valuesByMember = memberSeriesIds.map(() => new Float64Array(this.coldChunkSize));

    let windowOffset = 0;
    for (const window of windows) {
      const timestampChunk = requireDefined(
        window.timestampChunks[0],
        "missing promoted timestamp chunk for compaction"
      );
      const decodedTimestamps = decodeTimestampChunk(
        timestampChunk,
        this.hotStore,
        this.promotedStore
      );
      if (decodedTimestamps.length !== this.hotChunkSize) {
        throw new RangeError(
          `expected ${this.hotChunkSize} promoted timestamps, got ${decodedTimestamps.length}`
        );
      }
      timestamps.set(decodedTimestamps, windowOffset);

      const rowGroup = requireDefined(
        window.rowGroups[0],
        "missing promoted row group for compaction"
      );
      const decodedValues = decodePromotedRowGroupValues(
        rowGroup,
        memberSeriesIds.length,
        this.hotChunkSize,
        this.hotStore
      );
      for (let memberIndex = 0; memberIndex < decodedValues.length; memberIndex++) {
        const decoded = requireDefined(
          decodedValues[memberIndex],
          `missing promoted values for member ${memberIndex}`
        );
        if (decoded.length !== this.hotChunkSize) {
          throw new RangeError(
            `expected ${this.hotChunkSize} promoted values for member ${memberIndex}, got ${decoded.length}`
          );
        }
        requireDefined(valuesByMember[memberIndex], `missing compacted member ${memberIndex}`).set(
          decoded,
          windowOffset
        );
      }
      windowOffset += this.hotChunkSize;
    }

    this.compactedStore.appendCompactedWindow(compactedIds, timestamps, valuesByMember);
  }

  private ensureCompactedIds(globalSeriesIds: readonly SeriesId[]): SeriesId[] {
    return globalSeriesIds.map((globalId, memberIndex) => {
      let compactedId = this.compactedIds[globalId];
      if (compactedId !== undefined) {
        return compactedId;
      }
      const labels = this.labelIndex.labels(globalId);
      if (!labels) {
        throw new RangeError(
          `missing labels for compacted global series ${globalId} at member ${memberIndex}`
        );
      }
      compactedId = this.compactedStore.getOrCreateSeries(labels);
      this.compactedIds[globalId] = compactedId;
      return compactedId;
    });
  }
}

function compactionLaneKey(groupId: number, laneId: number): string {
  return `${groupId}:${laneId}`;
}

function defaultCompactionScheduler(): CompactionScheduler | null {
  if (typeof queueMicrotask === "function") {
    return (task) => {
      queueMicrotask(task);
    };
  }
  if (typeof setTimeout === "function") {
    return (task) => {
      setTimeout(task, 0);
    };
  }
  return null;
}

function mergeSortedPartSources(
  sources: readonly TimeRange[][],
  visit: (part: TimeRange) => void
): void {
  const indexes = new Uint32Array(sources.length);
  while (true) {
    let nextSource = -1;
    let nextPart: TimeRange | undefined;
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const partIndex = indexes[sourceIndex] ?? 0;
      const candidate = sources[sourceIndex]?.[partIndex];
      if (!candidate) {
        continue;
      }
      if (!nextPart || partStart(candidate) < partStart(nextPart)) {
        nextPart = candidate;
        nextSource = sourceIndex;
      }
    }
    if (!nextPart || nextSource < 0) {
      return;
    }
    indexes[nextSource] = (indexes[nextSource] ?? 0) + 1;
    visit(nextPart);
  }
}

function decodeTimestampChunk(
  chunk: { timestamps: BigInt64Array | undefined; compressed: Uint8Array | undefined },
  hotStore: RowGroupStore,
  promotedStore: PromotedPartStore
): BigInt64Array {
  if (chunk.timestamps) {
    return chunk.timestamps;
  }
  const tsCodec = Reflect.get(hotStore, "tsCodec") as TimestampCodec | undefined;
  if (tsCodec && chunk.compressed) {
    return tsCodec.decodeTimestamps(chunk.compressed);
  }
  const promotedTsCodec = Reflect.get(promotedStore, "tsCodec") as TimestampCodec | undefined;
  if (promotedTsCodec && chunk.compressed) {
    return promotedTsCodec.decodeTimestamps(chunk.compressed);
  }
  throw new RangeError("missing timestamp codec for promoted compaction");
}

function decodePromotedRowGroupValues(
  rowGroup: { valueBuffer: Uint8Array; offsets: Uint32Array; sizes: Uint32Array },
  memberCount: number,
  chunkSize: number,
  hotStore: RowGroupStore
): Float64Array[] {
  const valuesCodec = Reflect.get(hotStore, "valuesCodec") as ValuesCodec | undefined;
  if (!valuesCodec) {
    throw new RangeError("missing values codec for promoted compaction");
  }
  const blobs = Array.from({ length: memberCount }, (_, memberIndex) => {
    const offset = requireDefined(
      rowGroup.offsets[memberIndex],
      `missing promoted offset ${memberIndex}`
    );
    const size = requireDefined(
      rowGroup.sizes[memberIndex],
      `missing promoted size ${memberIndex}`
    );
    return rowGroup.valueBuffer.subarray(offset, offset + size);
  });
  if (valuesCodec.decodeBatchValuesView) {
    return valuesCodec.decodeBatchValuesView(blobs, chunkSize).map((values) => values.slice());
  }
  if (valuesCodec.decodeBatchValues) {
    return valuesCodec.decodeBatchValues(blobs, chunkSize).map((values) => values.slice());
  }
  return blobs.map((blob) => valuesCodec.decodeValues(blob));
}
