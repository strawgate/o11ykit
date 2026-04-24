import {
  RowGroupStore,
  TieredRowGroupStore,
  type Labels,
  type WasmCodecs,
} from "../dist/index.js";

export const NUM_SERIES = 32;
export const POINTS_PER_SERIES = 31_250;
export const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
export const HOT_SIZE = 80;
export const COLD_SIZE = 640;
export const HOTS_PER_COLD = COLD_SIZE / HOT_SIZE;
export const PRIME_BLOCKS = HOTS_PER_COLD - 1;
export const BATCH = 64;
export const INTERVAL = 1_000n;
export const COLD_ONLY_END = 10_000n * INTERVAL;
export const HOT_ONLY_START = BigInt(POINTS_PER_SERIES - 40) * INTERVAL;
export const MIXED_BOUNDARY_START = BigInt(POINTS_PER_SERIES - 200) * INTERVAL;
export const TOTAL_END = BigInt(POINTS_PER_SERIES - 1) * INTERVAL;

export type SeriesData = {
  timestamps: BigInt64Array;
  values: Float64Array;
};

type TieredInternals = {
  hotStore: RowGroupStore;
  coldStore: RowGroupStore;
};

export function makeLabels(seriesIndex: number): Labels {
  return new Map([
    ["__name__", "cpu_usage"],
    ["host", `host-${String(seriesIndex).padStart(2, "0")}`],
    ["region", seriesIndex % 2 === 0 ? "us" : "eu"],
  ]);
}

export function createLabels(): Labels[] {
  return Array.from({ length: NUM_SERIES }, (_, s) => makeLabels(s));
}

export function buildDataset(): SeriesData[] {
  return Array.from({ length: NUM_SERIES }, (_, seriesIndex) => {
    const timestamps = new BigInt64Array(POINTS_PER_SERIES);
    const values = new Float64Array(POINTS_PER_SERIES);
    const base = 100 + seriesIndex * 10;
    for (let i = 0; i < POINTS_PER_SERIES; i++) {
      timestamps[i] = BigInt(i) * INTERVAL;
      values[i] = base + (i % 10_000);
    }
    return { timestamps, values };
  });
}

export function createCurrentStore(codecs: WasmCodecs): RowGroupStore {
  return new RowGroupStore(codecs.valuesCodec, COLD_SIZE, () => 0, 8, undefined, codecs.tsCodec);
}

export function createTieredStore(codecs: WasmCodecs): TieredRowGroupStore {
  return new TieredRowGroupStore(
    codecs.valuesCodec,
    HOT_SIZE,
    COLD_SIZE,
    () => 0,
    8,
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
  batchSize = BATCH
): void {
  for (let off = 0; off < POINTS_PER_SERIES; off += batchSize) {
    const end = Math.min(off + batchSize, POINTS_PER_SERIES);
    for (let s = 0; s < NUM_SERIES; s++) {
      const series = dataset[s]!;
      store.appendBatch(ids[s]!, series.timestamps.subarray(off, end), series.values.subarray(off, end));
    }
  }
}

export function makeHotBlock(seriesIndex: number, blockIndex: number): SeriesData {
  const timestamps = new BigInt64Array(HOT_SIZE);
  const values = new Float64Array(HOT_SIZE);
  const start = blockIndex * HOT_SIZE;
  const base = 100 + seriesIndex * 10;
  for (let i = 0; i < HOT_SIZE; i++) {
    const sampleIndex = start + i;
    timestamps[i] = BigInt(sampleIndex) * INTERVAL;
    values[i] = base + (sampleIndex % 10_000);
  }
  return { timestamps, values };
}

export function appendHotRound<T extends RowGroupStore | TieredRowGroupStore>(
  store: T,
  ids: number[],
  blockIndex: number
): void {
  for (let s = 0; s < NUM_SERIES; s++) {
    const batch = makeHotBlock(s, blockIndex);
    store.appendBatch(ids[s]!, batch.timestamps, batch.values);
  }
}

export function tieredStores(store: TieredRowGroupStore): TieredInternals {
  const hotStore = Reflect.get(store, "hotStore") as RowGroupStore | undefined;
  const coldStore = Reflect.get(store, "coldStore") as RowGroupStore | undefined;
  if (!hotStore || !coldStore) {
    throw new Error("failed to access tiered store internals");
  }
  return { hotStore, coldStore };
}
