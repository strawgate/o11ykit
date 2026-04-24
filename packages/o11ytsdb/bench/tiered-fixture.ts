import {
  RowGroupStore,
  TieredRowGroupStore,
  type Labels,
  type WasmCodecs,
} from "../dist/index.js";

export const DEFAULT_NUM_SERIES = 32;
export const DEFAULT_POINTS_PER_SERIES = 31_250;
export const HOT_SIZE = 80;
export const COLD_SIZE = 640;
export const BATCH = 64;
export const INTERVAL = 1_000n;
export const NUM_SERIES = DEFAULT_NUM_SERIES;
export const POINTS_PER_SERIES = DEFAULT_POINTS_PER_SERIES;
export const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
export const HOTS_PER_COLD = COLD_SIZE / HOT_SIZE;
export const PRIME_BLOCKS = HOTS_PER_COLD - 1;
export const COLD_ONLY_END = 10_000n * INTERVAL;
export const HOT_ONLY_START = BigInt(POINTS_PER_SERIES - 40) * INTERVAL;
export const MIXED_BOUNDARY_START = BigInt(POINTS_PER_SERIES - 200) * INTERVAL;
export const TOTAL_END = BigInt(POINTS_PER_SERIES - 1) * INTERVAL;

export type TieredBenchConfig = {
  seriesCount: number;
  pointsPerSeries: number;
  batchSize: number;
  hotChunkSize: number;
  coldChunkSize: number;
  interval: bigint;
  maxSeriesPerLane: number;
};

export const DEFAULT_TIERED_BENCH_CONFIG: TieredBenchConfig = {
  seriesCount: DEFAULT_NUM_SERIES,
  pointsPerSeries: DEFAULT_POINTS_PER_SERIES,
  batchSize: BATCH,
  hotChunkSize: HOT_SIZE,
  coldChunkSize: COLD_SIZE,
  interval: INTERVAL,
  maxSeriesPerLane: 8,
};

export type SeriesData = {
  timestamps: BigInt64Array;
  values: Float64Array;
};

type TieredInternals = {
  hotStore: RowGroupStore;
  promotedStore: {
    sampleCount: number;
    memoryBytesExcludingLabels(): number;
    layoutSummary?(): {
      windowCount: number;
      partCount: number;
      timestampChunkCount: number;
      avgMembersPerWindow: number;
    };
  };
  compactedStore: RowGroupStore;
};

type RowGroupLayoutSummary = {
  laneCount: number;
  rowGroupCount: number;
  timestampChunkCount: number;
  avgMembersPerRowGroup: number;
};

type PromotedPartLayoutSummary = {
  windowCount: number;
  partCount: number;
  timestampChunkCount: number;
  avgMembersPerWindow: number;
};

export function makeLabels(seriesIndex: number): Labels {
  return new Map([
    ["__name__", "cpu_usage"],
    ["host", `host-${String(seriesIndex).padStart(2, "0")}`],
    ["region", seriesIndex % 2 === 0 ? "us" : "eu"],
  ]);
}

export function createLabels(seriesCount = DEFAULT_TIERED_BENCH_CONFIG.seriesCount): Labels[] {
  return Array.from({ length: seriesCount }, (_, s) => makeLabels(s));
}

export function buildDataset(config: Partial<TieredBenchConfig> = {}): SeriesData[] {
  const resolved = { ...DEFAULT_TIERED_BENCH_CONFIG, ...config };
  return Array.from({ length: resolved.seriesCount }, (_, seriesIndex) => {
    const timestamps = new BigInt64Array(resolved.pointsPerSeries);
    const values = new Float64Array(resolved.pointsPerSeries);
    const base = 100 + seriesIndex * 10;
    for (let i = 0; i < resolved.pointsPerSeries; i++) {
      timestamps[i] = BigInt(i) * resolved.interval;
      values[i] = base + (i % 10_000);
    }
    return { timestamps, values };
  });
}

export function createCurrentStore(
  codecs: WasmCodecs,
  config: Partial<TieredBenchConfig> = {}
): RowGroupStore {
  const resolved = { ...DEFAULT_TIERED_BENCH_CONFIG, ...config };
  return new RowGroupStore(
    codecs.valuesCodec,
    resolved.coldChunkSize,
    () => 0,
    resolved.maxSeriesPerLane,
    undefined,
    codecs.tsCodec
  );
}

export function createTieredStore(
  codecs: WasmCodecs,
  config: Partial<TieredBenchConfig> = {}
): TieredRowGroupStore {
  const resolved = { ...DEFAULT_TIERED_BENCH_CONFIG, ...config };
  return new TieredRowGroupStore(
    codecs.valuesCodec,
    resolved.hotChunkSize,
    resolved.coldChunkSize,
    () => 0,
    resolved.maxSeriesPerLane,
    undefined,
    codecs.tsCodec
  );
}

export function createSeriesIds<T extends RowGroupStore | TieredRowGroupStore>(
  store: T,
  labels = createLabels()
): number[] {
  return labels.map((label) => store.getOrCreateSeries(label));
}

export function ingestDataset(
  store: RowGroupStore | TieredRowGroupStore,
  ids: number[],
  dataset: SeriesData[],
  batchSize = DEFAULT_TIERED_BENCH_CONFIG.batchSize
): void {
  const pointsPerSeries = dataset[0]?.timestamps.length ?? 0;
  for (let off = 0; off < pointsPerSeries; off += batchSize) {
    const end = Math.min(off + batchSize, pointsPerSeries);
    for (let s = 0; s < dataset.length; s++) {
      const series = dataset[s]!;
      store.appendBatch(ids[s]!, series.timestamps.subarray(off, end), series.values.subarray(off, end));
    }
  }
}

export function makeHotBlock(
  seriesIndex: number,
  blockIndex: number,
  config: Partial<TieredBenchConfig> = {}
): SeriesData {
  const resolved = { ...DEFAULT_TIERED_BENCH_CONFIG, ...config };
  const timestamps = new BigInt64Array(resolved.hotChunkSize);
  const values = new Float64Array(resolved.hotChunkSize);
  const start = blockIndex * resolved.hotChunkSize;
  const base = 100 + seriesIndex * 10;
  for (let i = 0; i < resolved.hotChunkSize; i++) {
    const sampleIndex = start + i;
    timestamps[i] = BigInt(sampleIndex) * resolved.interval;
    values[i] = base + (sampleIndex % 10_000);
  }
  return { timestamps, values };
}

export function appendHotRound<T extends RowGroupStore | TieredRowGroupStore>(
  store: T,
  ids: number[],
  blockIndex: number,
  config: Partial<TieredBenchConfig> = {}
): void {
  for (let s = 0; s < ids.length; s++) {
    const batch = makeHotBlock(s, blockIndex, config);
    store.appendBatch(ids[s]!, batch.timestamps, batch.values);
  }
}

export function tieredStores(store: TieredRowGroupStore): TieredInternals {
  const hotStore = Reflect.get(store, "hotStore") as RowGroupStore | undefined;
  const promotedStore = Reflect.get(store, "promotedStore") as
    | TieredInternals["promotedStore"]
    | undefined;
  const compactedStore = Reflect.get(store, "compactedStore") as RowGroupStore | undefined;
  if (!hotStore || !promotedStore || !compactedStore) {
    throw new Error("failed to access tiered store internals");
  }
  return { hotStore, promotedStore, compactedStore };
}

export function summarizeRowGroupLayout(store: RowGroupStore): RowGroupLayoutSummary {
  const groups = (Reflect.get(store, "groups") as
    | Array<{ lanes: Array<{ rowGroups: Array<{ memberCount: number }> ; frozenTimestamps: unknown[] }> }>
    | undefined) ?? [];
  let laneCount = 0;
  let rowGroupCount = 0;
  let timestampChunkCount = 0;
  let memberTotal = 0;

  for (const group of groups) {
    for (const lane of group.lanes) {
      laneCount++;
      rowGroupCount += lane.rowGroups.length;
      timestampChunkCount += lane.frozenTimestamps.length;
      for (const rowGroup of lane.rowGroups) {
        memberTotal += rowGroup.memberCount;
      }
    }
  }

  return {
    laneCount,
    rowGroupCount,
    timestampChunkCount,
    avgMembersPerRowGroup:
      rowGroupCount > 0 ? Number((memberTotal / rowGroupCount).toFixed(2)) : 0,
  };
}

export function summarizeColdLayout(
  tiered: Pick<TieredInternals, "promotedStore" | "compactedStore">
): {
  promoted: PromotedPartLayoutSummary;
  compacted: RowGroupLayoutSummary;
} {
  const promoted =
    typeof tiered.promotedStore.layoutSummary === "function"
      ? tiered.promotedStore.layoutSummary()
      : { windowCount: 0, partCount: 0, timestampChunkCount: 0, avgMembersPerWindow: 0 };
  return {
    promoted,
    compacted: summarizeRowGroupLayout(tiered.compactedStore),
  };
}
