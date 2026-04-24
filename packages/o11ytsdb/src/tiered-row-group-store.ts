import { concatRanges } from "./binary-search.js";
import { LabelIndex } from "./label-index.js";
import type { RowGroupStoreLaneWindow } from "./row-group-store.js";
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
 * Hot ingest lands in small row groups, then whole hot row groups are compacted
 * into larger cold row groups once a full cold window is available.
 */
export class TieredRowGroupStore implements StorageBackend {
  readonly name: string;

  private readonly hotStore: RowGroupStore;
  private readonly coldStore: RowGroupStore;
  private readonly valuesCodec: ValuesCodec;
  private readonly hotChunkSize: number;
  private readonly coldChunkSize: number;
  private readonly groupResolver: (labels: Labels) => number;
  private readonly labelIndex = new LabelIndex();
  private readonly hotIds: SeriesId[] = [];
  private readonly coldIds: SeriesId[] = [];
  private readonly hotToGlobal: SeriesId[] = [];
  private readonly groupIds: number[] = [];
  private readonly hotsPerCold: number;
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
    quantizeBatch?: (values: Float64Array, precision: number) => void
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
    this.valuesCodec = valuesCodec;
    this.groupResolver = groupResolver;
    this.hotsPerCold = coldChunkSize / hotChunkSize;
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
    this.coldStore = new RowGroupStore(
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
    this.compactReadyGroup(this.requireGroupId(id));
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    this.hotStore.appendBatch(this.requireHotId(id), timestamps, values);
    this._sampleCount += timestamps.length;
    this.compactReadyGroup(this.requireGroupId(id));
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
    const coldId = this.coldIds[id];
    const hotId = this.requireHotId(id);
    const coldParts =
      coldId === undefined
        ? []
        : this.coldStore.readParts
          ? this.coldStore.readParts(coldId, start, end)
          : [this.coldStore.read(coldId, start, end)];
    const hotParts = this.hotStore.readParts
      ? this.hotStore.readParts(hotId, start, end)
      : [this.hotStore.read(hotId, start, end)];

    let coldIndex = 0;
    let hotIndex = 0;
    while (coldIndex < coldParts.length || hotIndex < hotParts.length) {
      const nextCold = coldParts[coldIndex];
      const nextHot = hotParts[hotIndex];
      if (!nextHot) {
        visit(requireDefined(nextCold, `missing cold part ${coldIndex}`));
        coldIndex++;
        continue;
      }
      if (!nextCold) {
        visit(nextHot);
        hotIndex++;
        continue;
      }
      if (partStart(nextCold) <= partStart(nextHot)) {
        visit(nextCold);
        coldIndex++;
      } else {
        visit(nextHot);
        hotIndex++;
      }
    }
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
      this.coldStore.memoryBytesExcludingLabels() +
      this.labelIndex.memoryBytes()
    );
  }

  private requireHotId(id: SeriesId): SeriesId {
    return requireDefined(this.hotIds[id], `unknown series id ${id}`);
  }

  private ensureColdId(id: SeriesId): SeriesId {
    const existing = this.coldIds[id];
    if (existing !== undefined) return existing;
    const labels = requireDefined(this.labelIndex.labels(id), `missing labels for series id ${id}`);
    const coldId = this.coldStore.getOrCreateSeries(labels);
    this.coldIds[id] = coldId;
    return coldId;
  }

  private requireGroupId(id: SeriesId): number {
    return requireDefined(this.groupIds[id], `missing group id for series ${id}`);
  }

  private compactReadyGroup(groupId: number): void {
    while (true) {
      const laneWindow = this.hotStore.peekCompactableLaneWindow(
        groupId,
        this.hotsPerCold,
        this.hotChunkSize
      );
      if (!laneWindow) {
        return;
      }
      this.compactLane(laneWindow);
      this.hotStore.commitCompactedLaneWindow(laneWindow);
    }
  }

  private compactLane(laneWindow: RowGroupStoreLaneWindow): void {
    const rowGroups = laneWindow.rowGroups;
    const memberCount = requireDefined(rowGroups[0], "missing compacted hot row group").memberCount;
    const coldSeriesIds = new Array<SeriesId>(memberCount);
    const coldValuesSlab = new Float64Array(memberCount * this.coldChunkSize);
    const coldValuesByMember = new Array<Float64Array>(memberCount);
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex++) {
      const hotSeriesId = requireDefined(
        laneWindow.memberSeriesIds[memberIndex],
        `missing lane member ${memberIndex}`
      );
      const globalId = requireDefined(
        this.hotToGlobal[hotSeriesId],
        `missing global series mapping for hot series ${hotSeriesId}`
      );
      coldSeriesIds[memberIndex] = this.ensureColdId(globalId);
      coldValuesByMember[memberIndex] = coldValuesSlab.subarray(
        memberIndex * this.coldChunkSize,
        (memberIndex + 1) * this.coldChunkSize
      );
    }

    const decodeBatchValuesView = this.valuesCodec.decodeBatchValuesView;
    const decodeBatchValues = this.valuesCodec.decodeBatchValues;
    for (let rowGroupIndex = 0; rowGroupIndex < rowGroups.length; rowGroupIndex++) {
      const rowGroup = requireDefined(
        rowGroups[rowGroupIndex],
        `missing compacted row group ${rowGroupIndex}`
      );
      const valueOffset = rowGroupIndex * this.hotChunkSize;
      const blobs = new Array<Uint8Array>(memberCount);
      for (let memberIndex = 0; memberIndex < memberCount; memberIndex++) {
        const start = requireDefined(
          rowGroup.offsets[memberIndex],
          `missing compacted value offset for member ${memberIndex}`
        );
        const size = requireDefined(
          rowGroup.sizes[memberIndex],
          `missing compacted value size for member ${memberIndex}`
        );
        blobs[memberIndex] = rowGroup.valueBuffer.subarray(start, start + size);
      }

      const decoded =
        typeof decodeBatchValuesView === "function"
          ? decodeBatchValuesView.call(this.valuesCodec, blobs, this.hotChunkSize)
          : typeof decodeBatchValues === "function"
            ? decodeBatchValues.call(this.valuesCodec, blobs, this.hotChunkSize)
            : blobs.map((blob) => this.valuesCodec.decodeValues(blob));

      for (let memberIndex = 0; memberIndex < memberCount; memberIndex++) {
        const values = requireDefined(
          decoded[memberIndex],
          `missing compacted decoded values for member ${memberIndex}, rowGroup ${rowGroupIndex}`
        );
        if (values.length !== this.hotChunkSize) {
          throw new RangeError(
            `expected ${this.hotChunkSize} values for member ${memberIndex}, chunk ${rowGroupIndex}, got ${values.length}`
          );
        }
        requireDefined(
          coldValuesByMember[memberIndex],
          `missing compacted cold values for member ${memberIndex}`
        ).set(values, valueOffset);
      }
    }

    this.coldStore.appendCompactedWindow(coldSeriesIds, laneWindow.timestamps, coldValuesByMember);
  }
}
