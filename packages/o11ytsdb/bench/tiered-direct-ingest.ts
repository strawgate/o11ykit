import { type TieredRowGroupStore, type WasmCodecs } from "../dist/index.js";
import { loadBenchWasmCodecs, timeMs } from "./common.js";
import {
  DEFAULT_TIERED_BENCH_CONFIG,
  type SeriesData,
  type TieredBenchConfig,
  buildDataset,
  createLabels,
  createSeriesIds,
  createTieredStore,
  ingestDataset,
  summarizeColdLayout,
  summarizeRowGroupLayout,
  tieredStores,
} from "./tiered-fixture.js";

const DEFAULT_ITERATIONS = 3;

function ingestShared(
  store: TieredRowGroupStore,
  ids: readonly number[],
  dataset: readonly SeriesData[],
  batchSize: number
): void {
  const pointsPerSeries = dataset[0]?.timestamps.length ?? 0;
  for (let off = 0; off < pointsPerSeries; off += batchSize) {
    const end = Math.min(off + batchSize, pointsPerSeries);
    const timestamps = dataset[0]!.timestamps.subarray(off, end);
    store.append(
      timestamps,
      dataset.map((series, seriesIndex) => ({
        id: ids[seriesIndex]!,
        values: series.values.subarray(off, end),
      }))
    );
  }
}

function measureScenario(
  codecs: WasmCodecs,
  config: TieredBenchConfig,
  mode: "hot60-per-series" | "cold600-shared"
) {
  const labels = createLabels(config.seriesCount);
  const dataset = buildDataset(config);
  const store = createTieredStore(codecs, config);
  const ids = createSeriesIds(store, labels);

  const appendMs = timeMs(() => {
    if (mode === "cold600-shared") {
      ingestShared(store, ids, dataset, config.coldChunkSize);
    } else {
      ingestDataset(store, ids, dataset, config.hotChunkSize);
    }
  });
  const drainMs = timeMs(() => {
    store.drainCompaction();
  });
  const internals = tieredStores(store);

  return {
    mode,
    appendMs,
    drainMs,
    totalMs: appendMs + drainMs,
    sampleCount: store.sampleCount,
    memoryBytes: store.memoryBytes(),
    bytesPerSample: Number((store.memoryBytes() / store.sampleCount).toFixed(4)),
    layout: {
      hot: summarizeRowGroupLayout(internals.hotStore),
      cold: summarizeColdLayout(internals),
    },
  };
}

async function main(): Promise<void> {
  const iterations = Number(process.argv[2] ?? DEFAULT_ITERATIONS);
  const codecs = await loadBenchWasmCodecs();
  const config: TieredBenchConfig = {
    ...DEFAULT_TIERED_BENCH_CONFIG,
    pointsPerSeries: 31_200,
    batchSize: DEFAULT_TIERED_BENCH_CONFIG.hotChunkSize,
  };

  const runs = [];
  for (let i = 0; i < iterations; i++) {
    runs.push(measureScenario(codecs, config, "hot60-per-series"));
    runs.push(measureScenario(codecs, config, "cold600-shared"));
  }

  console.log(
    JSON.stringify(
      {
        config: {
          ...config,
          interval: config.interval.toString(),
        },
        iterations,
        runs,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
