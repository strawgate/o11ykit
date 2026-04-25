import { ScanEngine, type RowGroupStore, type TieredRowGroupStore, type WasmCodecs } from "../dist/index.js";
import { collectTimingSamples, loadBenchWasmCodecs, summarizeTimings, timeMs } from "./common.js";
import {
  DEFAULT_TIERED_BENCH_CONFIG,
  type TieredBenchConfig,
  buildDataset,
  createCurrentStore,
  createLabels,
  createSeriesIds,
  createTieredStore,
  ingestDataset,
  summarizeColdLayout,
  summarizeRowGroupLayout,
  tieredStores,
} from "./tiered-fixture.js";

const DEFAULT_ITERATIONS = 3;
const SIZE_SCENARIOS = [
  { name: "80to640", hotChunkSize: 80, coldChunkSize: 640 },
  { name: "60to600", hotChunkSize: 60, coldChunkSize: 600 },
] as const;
const INTERVAL_SCENARIOS = [
  { name: "1dps", interval: 1_000n },
  { name: "1dpm", interval: 60_000n },
] as const;

type StoreMetrics = {
  sampleCount: number;
  memoryBytes: number;
  bytesPerSample: number;
  query: Record<string, ReturnType<typeof summarizeTimings>>;
};

function bytesPerSample(memoryBytes: number, sampleCount: number): number {
  return sampleCount > 0 ? Number((memoryBytes / sampleCount).toFixed(4)) : 0;
}

function queryWorkloads(config: TieredBenchConfig) {
  const totalEnd = BigInt(config.pointsPerSeries - 1) * config.interval;
  const coldEnd = BigInt(Math.min(10_000, config.pointsPerSeries - 1)) * config.interval;
  const boundaryStart =
    BigInt(Math.max(0, config.pointsPerSeries - Math.max(config.coldChunkSize, 200))) *
    config.interval;
  const hotStart =
    BigInt(Math.max(0, config.pointsPerSeries - Math.max(config.hotChunkSize, 40))) *
    config.interval;

  return [
    {
      name: "cold-step-sum",
      run: (store: RowGroupStore | TieredRowGroupStore, engine: ScanEngine) => {
        engine.query(store, {
          metric: "cpu_usage",
          matchers: [{ label: "region", op: "=" as const, value: "us" }],
          start: 0n,
          end: coldEnd,
          agg: "sum",
          step: 300_000n,
        });
      },
    },
    {
      name: "boundary-step-sum",
      run: (store: RowGroupStore | TieredRowGroupStore, engine: ScanEngine) => {
        engine.query(store, {
          metric: "cpu_usage",
          matchers: [{ label: "region", op: "=" as const, value: "us" }],
          start: boundaryStart,
          end: totalEnd,
          agg: "sum",
          step: 300_000n,
        });
      },
    },
    {
      name: "hot-step-sum",
      run: (store: RowGroupStore | TieredRowGroupStore, engine: ScanEngine) => {
        engine.query(store, {
          metric: "cpu_usage",
          start: hotStart,
          end: totalEnd,
          agg: "sum",
          step: 60_000n,
        });
      },
    },
    {
      name: "full-range-count",
      run: (store: RowGroupStore | TieredRowGroupStore, engine: ScanEngine) => {
        engine.query(store, {
          metric: "cpu_usage",
          matchers: [{ label: "region", op: "=" as const, value: "us" }],
          start: 0n,
          end: totalEnd,
          agg: "count",
          step: 300_000n,
        });
      },
    },
  ];
}

function measureQueries(
  store: RowGroupStore | TieredRowGroupStore,
  config: TieredBenchConfig,
  iterations: number
): StoreMetrics["query"] {
  const engine = new ScanEngine();
  const query: StoreMetrics["query"] = {};
  for (const workload of queryWorkloads(config)) {
    workload.run(store, engine);
    query[workload.name] = summarizeTimings(
      collectTimingSamples(iterations, () => {
        workload.run(store, engine);
      })
    );
  }
  return query;
}

function storeMetrics(
  store: RowGroupStore | TieredRowGroupStore,
  config: TieredBenchConfig,
  iterations: number
): StoreMetrics {
  const memoryBytes = store.memoryBytes();
  return {
    sampleCount: store.sampleCount,
    memoryBytes,
    bytesPerSample: bytesPerSample(memoryBytes, store.sampleCount),
    query: measureQueries(store, config, iterations),
  };
}

function measureScenario(codecs: WasmCodecs, config: TieredBenchConfig, iterations: number) {
  const dataset = buildDataset(config);
  const labels = createLabels(config.seriesCount);
  const current = createCurrentStore(codecs, config);
  const tiered = createTieredStore(codecs, config);
  const currentIds = createSeriesIds(current, labels);
  const tieredIds = createSeriesIds(tiered, labels);

  const currentIngestMs = timeMs(() => {
    ingestDataset(current, currentIds, dataset, config.batchSize);
  });
  const tieredAppendMs = timeMs(() => {
    ingestDataset(tiered, tieredIds, dataset, config.batchSize);
  });

  const directPromoted = storeMetrics(tiered, config, iterations);
  const directInternals = tieredStores(tiered);
  const directLayout = {
    hot: summarizeRowGroupLayout(directInternals.hotStore),
    cold: summarizeColdLayout(directInternals),
  };

  const backgroundCompactionMs = timeMs(() => {
    tiered.drainCompaction();
  });
  const compacted = storeMetrics(tiered, config, iterations);
  const compactedInternals = tieredStores(tiered);
  const compactedLayout = {
    hot: summarizeRowGroupLayout(compactedInternals.hotStore),
    cold: summarizeColdLayout(compactedInternals),
  };

  return {
    config: {
      seriesCount: config.seriesCount,
      pointsPerSeries: config.pointsPerSeries,
      totalSamples: config.seriesCount * config.pointsPerSeries,
      batchSize: config.batchSize,
      hotChunkSize: config.hotChunkSize,
      coldChunkSize: config.coldChunkSize,
      intervalMs: config.interval.toString(),
      hotSpanMs: (BigInt(config.hotChunkSize) * config.interval).toString(),
      coldSpanMs: (BigInt(config.coldChunkSize) * config.interval).toString(),
    },
    current: {
      ingestMs: Number(currentIngestMs.toFixed(3)),
      ...storeMetrics(current, config, iterations),
      layout: summarizeRowGroupLayout(current),
    },
    tiered: {
      appendMs: Number(tieredAppendMs.toFixed(3)),
      directPromoted,
      directLayout,
      backgroundCompactionMs: Number(backgroundCompactionMs.toFixed(3)),
      endToEndIngestMs: Number((tieredAppendMs + backgroundCompactionMs).toFixed(3)),
      compacted,
      compactedLayout,
    },
  };
}

async function main() {
  const iterations = Number.parseInt(process.argv[2] ?? `${DEFAULT_ITERATIONS}`, 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("usage: tiered-size-sweep.ts [queryIterations]");
  }

  const codecs = await loadBenchWasmCodecs();
  const rows = [];
  for (const intervalScenario of INTERVAL_SCENARIOS) {
    for (const sizeScenario of SIZE_SCENARIOS) {
      const config: TieredBenchConfig = {
        ...DEFAULT_TIERED_BENCH_CONFIG,
        batchSize: sizeScenario.hotChunkSize,
        hotChunkSize: sizeScenario.hotChunkSize,
        coldChunkSize: sizeScenario.coldChunkSize,
        interval: intervalScenario.interval,
      };
      rows.push({
        name: `${intervalScenario.name}-${sizeScenario.name}`,
        interval: intervalScenario.name,
        size: sizeScenario.name,
        ...measureScenario(codecs, config, iterations),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        config: {
          iterations,
          sizeScenarios: SIZE_SCENARIOS,
          intervalScenarios: INTERVAL_SCENARIOS.map((scenario) => ({
            name: scenario.name,
            intervalMs: scenario.interval.toString(),
          })),
        },
        rows,
      },
      null,
      2
    )
  );
}

void main();
