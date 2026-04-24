import { concatRanges } from "./binary-search.js";
import { LabelIndex } from "./label-index.js";
import { RowGroupStore } from "./row-group-store.js";
import type { RowGroupStoreLaneWindow } from "./row-group-store.js";
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
    const coldId = this.coldStore.getOrCreateSeries(labels);
    this.hotIds[id] = hotId;
    this.coldIds[id] = coldId;
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
    const coldId = this.requireColdId(id);
    const hotId = this.requireHotId(id);

    if (this.coldStore.scanParts) {
      this.coldStore.scanParts(coldId, start, end, visit);
    } else {
      visit(this.coldStore.read(coldId, start, end));
    }

    if (this.hotStore.scanParts) {
      this.hotStore.scanParts(hotId, start, end, visit);
    } else {
      visit(this.hotStore.read(hotId, start, end));
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

  private requireColdId(id: SeriesId): SeriesId {
    return requireDefined(this.coldIds[id], `unknown series id ${id}`);
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

    for (let memberIndex = 0; memberIndex < memberCount; memberIndex++) {
      const hotSeriesId = requireDefined(
        laneWindow.memberSeriesIds[memberIndex],
        `missing lane member ${memberIndex}`
      );
      const globalId = requireDefined(
        this.hotToGlobal[hotSeriesId],
        `missing global series mapping for hot series ${hotSeriesId}`
      );
      const coldSeriesId = this.requireColdId(globalId);
      const coldValues = new Float64Array(this.coldChunkSize);
      let valueOffset = 0;

      for (let i = 0; i < rowGroups.length; i++) {
        const rowGroup = requireDefined(rowGroups[i], `missing compacted row group ${i}`);
        const start = requireDefined(
          rowGroup.offsets[memberIndex],
          `missing compacted value offset for member ${memberIndex}`
        );
        const size = requireDefined(
          rowGroup.sizes[memberIndex],
          `missing compacted value size for member ${memberIndex}`
        );
        const values = this.valuesCodec.decodeValues(
          rowGroup.valueBuffer.subarray(start, start + size)
        );
        if (values.length !== this.hotChunkSize) {
          throw new RangeError(
            `expected ${this.hotChunkSize} values for member ${memberIndex}, chunk ${i}, got ${values.length}`
          );
        }
        if (valueOffset + values.length > coldValues.length) {
          throw new RangeError(
            `hot->cold compaction overflow for member ${memberIndex}: ` +
              `offset=${valueOffset} decoded=${values.length} cold=${coldValues.length} ` +
              `hot=${this.hotChunkSize} groups=${rowGroups.length} size=${size} ` +
              `memberCount=${memberCount} groupIndex=${i}`
          );
        }
        coldValues.set(values, valueOffset);
        valueOffset += values.length;
      }
      if (valueOffset !== this.coldChunkSize) {
        throw new RangeError(
          `expected ${this.coldChunkSize} compacted values for member ${memberIndex}, got ${valueOffset}`
        );
      }

      this.coldStore.appendBatch(coldSeriesId, laneWindow.timestamps, coldValues);
    }
  }
}
