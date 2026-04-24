import { RowGroupStore, TieredRowGroupStore, type Labels } from "../dist/index.js";
import { loadBenchWasmCodecs } from "./common.js";

const NUM_SERIES = 32;
const POINTS_PER_SERIES = 31_250;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const INTERVAL = 1_000n;
const CHECKPOINTS = [51_200, 100_352, 251_904, 501_760, 751_616, 1_000_000];

type TieredInternals = {
  hotStore: RowGroupStore;
  coldStore: RowGroupStore;
};

type CurveRow = {
  samples: number;
  current640: {
    memoryBytes: number;
    bytesPerSample: number;
  };
  tiered80to640: {
    memoryBytes: number;
    bytesPerSample: number;
    hotBytes: number;
    coldBytes: number;
  };
};

function makeLabels(seriesIndex: number): Labels {
  return new Map([
    ["__name__", "cpu_usage"],
    ["host", `host-${String(seriesIndex).padStart(2, "0")}`],
    ["region", seriesIndex % 2 === 0 ? "us" : "eu"],
  ]);
}

function makeSeriesData(seriesIndex: number) {
  const timestamps = new BigInt64Array(POINTS_PER_SERIES);
  const values = new Float64Array(POINTS_PER_SERIES);
  const base = 100 + seriesIndex * 10;
  for (let i = 0; i < POINTS_PER_SERIES; i++) {
    timestamps[i] = BigInt(i) * INTERVAL;
    values[i] = base + (i % 10_000);
  }
  return { timestamps, values };
}

function tieredStores(store: TieredRowGroupStore): TieredInternals {
  const hotStore = Reflect.get(store, "hotStore") as RowGroupStore | undefined;
  const coldStore = Reflect.get(store, "coldStore") as RowGroupStore | undefined;
  if (!hotStore || !coldStore) {
    throw new Error("failed to access tiered store internals");
  }
  return {
    hotStore,
    coldStore,
  };
}

async function main() {
  const batchSize = Number.parseInt(process.argv[2] ?? "64", 10);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("usage: memory-curve.ts [batchSize]");
  }

  const codecs = await loadBenchWasmCodecs();
  const current = new RowGroupStore(codecs.valuesCodec, 640, () => 0, 8, undefined, codecs.tsCodec);
  const tiered = new TieredRowGroupStore(
    codecs.valuesCodec,
    80,
    640,
    () => 0,
    8,
    undefined,
    codecs.tsCodec
  );
  const currentIds = Array.from({ length: NUM_SERIES }, (_, s) =>
    current.getOrCreateSeries(makeLabels(s))
  );
  const tieredIds = Array.from({ length: NUM_SERIES }, (_, s) =>
    tiered.getOrCreateSeries(makeLabels(s))
  );
  const dataset = Array.from({ length: NUM_SERIES }, (_, s) => makeSeriesData(s));
  const rows: CurveRow[] = [];
  let nextCheckpoint = 0;

  for (let off = 0; off < POINTS_PER_SERIES && nextCheckpoint < CHECKPOINTS.length; off += batchSize) {
    const end = Math.min(off + batchSize, POINTS_PER_SERIES);
    for (let s = 0; s < NUM_SERIES; s++) {
      const series = dataset[s]!;
      current.appendBatch(
        currentIds[s]!,
        series.timestamps.subarray(off, end),
        series.values.subarray(off, end)
      );
      tiered.appendBatch(
        tieredIds[s]!,
        series.timestamps.subarray(off, end),
        series.values.subarray(off, end)
      );
    }

    const samples = end * NUM_SERIES;
    while (nextCheckpoint < CHECKPOINTS.length && samples >= CHECKPOINTS[nextCheckpoint]!) {
      const tieredInternals = tieredStores(tiered);
      rows.push({
        samples,
        current640: {
          memoryBytes: current.memoryBytes(),
          bytesPerSample: Number((current.memoryBytes() / samples).toFixed(4)),
        },
        tiered80to640: {
          memoryBytes: tiered.memoryBytes(),
          bytesPerSample: Number((tiered.memoryBytes() / samples).toFixed(4)),
          hotBytes: tieredInternals.hotStore.memoryBytesExcludingLabels(),
          coldBytes: tieredInternals.coldStore.memoryBytesExcludingLabels(),
        },
      });
      nextCheckpoint++;
    }
  }

  console.log(
    JSON.stringify(
      {
        config: {
          batchSize,
          seriesCount: NUM_SERIES,
          pointsPerSeries: POINTS_PER_SERIES,
          totalSamples: TOTAL_SAMPLES,
          checkpoints: CHECKPOINTS,
        },
        rows,
      },
      null,
      2
    )
  );
}

void main();
