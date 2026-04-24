import { ScanEngine, type WasmCodecs } from "../dist/index.js";
import { loadBenchWasmCodecs, timeMs } from "./common.js";
import {
  BATCH,
  DEFAULT_TIERED_BENCH_CONFIG,
  HOT_SIZE,
  COLD_SIZE,
  type TieredBenchConfig,
  buildDataset,
  createCurrentStore,
  createLabels,
  createSeriesIds,
  createTieredStore,
  ingestDataset,
  summarizeRowGroupLayout,
  tieredStores,
} from "./tiered-fixture.js";

const MAX_TOTAL_SAMPLES = 8_000_000;

const SERIES_COUNTS = [32, 128, 512, 2048];
const SHAPES = [
  { name: "low-fill-80", pointsPerSeries: 80 },
  { name: "partial-fill-320", pointsPerSeries: 320 },
  { name: "cold-fill-640", pointsPerSeries: 640 },
  { name: "steady-state-31250", pointsPerSeries: 31_250 },
];

type SweepRow =
  | {
      name: string;
      seriesCount: number;
      pointsPerSeries: number;
      totalSamples: number;
      skipped: false;
      current640: {
        memoryBytes: number;
        bytesPerSample: number;
        ingestMs: number;
        queryMs: number;
        hotReadMs: number;
        layout: {
          laneCount: number;
          rowGroupCount: number;
          timestampChunkCount: number;
          avgMembersPerRowGroup: number;
        };
      };
      tiered80to640: {
        memoryBytes: number;
        bytesPerSample: number;
        hotBytes: number;
        coldBytes: number;
        ingestMs: number;
        queryMs: number;
        hotReadMs: number;
        hotLayout: {
          laneCount: number;
          rowGroupCount: number;
          timestampChunkCount: number;
          avgMembersPerRowGroup: number;
        };
        coldLayout: {
          laneCount: number;
          rowGroupCount: number;
          timestampChunkCount: number;
          avgMembersPerRowGroup: number;
        };
      };
    }
  | {
      name: string;
      seriesCount: number;
      pointsPerSeries: number;
      totalSamples: number;
      skipped: true;
      reason: string;
    };

function makeScenarioConfig(seriesCount: number, pointsPerSeries: number): TieredBenchConfig {
  return {
    ...DEFAULT_TIERED_BENCH_CONFIG,
    seriesCount,
    pointsPerSeries,
    batchSize: BATCH,
    hotChunkSize: HOT_SIZE,
    coldChunkSize: COLD_SIZE,
  };
}

function runFullRangeQueryMs(
  config: TieredBenchConfig,
  current: ReturnType<typeof createCurrentStore>,
  tiered: ReturnType<typeof createTieredStore>
) {
  const engine = new ScanEngine();
  const totalEnd = BigInt(config.pointsPerSeries - 1) * config.interval;
  const stepPoints = Math.max(1, Math.floor(config.pointsPerSeries / 32));
  const query = {
    metric: "cpu_usage",
    matchers: [{ label: "region", op: "=" as const, value: "us" }],
    start: 0n,
    end: totalEnd,
    agg: "sum" as const,
    step: BigInt(stepPoints) * config.interval,
  };
  engine.query(current, query);
  engine.query(tiered, query);

  const hotStartIndex = Math.max(0, config.pointsPerSeries - Math.min(40, config.pointsPerSeries));
  const hotStart = BigInt(hotStartIndex) * config.interval;

  return {
    currentQueryMs: timeMs(() => {
      engine.query(current, query);
    }),
    tieredQueryMs: timeMs(() => {
      engine.query(tiered, query);
    }),
    currentHotReadMs: timeMs(() => {
      current.read(0, hotStart, totalEnd);
    }),
    tieredHotReadMs: timeMs(() => {
      tiered.read(0, hotStart, totalEnd);
    }),
  };
}

function measureScenario(codecs: WasmCodecs, config: TieredBenchConfig): SweepRow {
  const totalSamples = config.seriesCount * config.pointsPerSeries;
  const name = `${config.seriesCount}x${config.pointsPerSeries}`;
  if (totalSamples > MAX_TOTAL_SAMPLES) {
    return {
      name,
      seriesCount: config.seriesCount,
      pointsPerSeries: config.pointsPerSeries,
      totalSamples,
      skipped: true,
      reason: `totalSamples ${totalSamples.toLocaleString()} exceeds cap ${MAX_TOTAL_SAMPLES.toLocaleString()}`,
    };
  }

  const dataset = buildDataset(config);
  const labels = createLabels(config.seriesCount);
  const current = createCurrentStore(codecs, config);
  const tiered = createTieredStore(codecs, config);
  const currentIds = createSeriesIds(current, labels);
  const tieredIds = createSeriesIds(tiered, labels);

  const ingestCurrentMs = timeMs(() => {
    ingestDataset(current, currentIds, dataset, config.batchSize);
  });
  const ingestTieredMs = timeMs(() => {
    ingestDataset(tiered, tieredIds, dataset, config.batchSize);
  });

  const { currentQueryMs, tieredQueryMs, currentHotReadMs, tieredHotReadMs } = runFullRangeQueryMs(
    config,
    current,
    tiered
  );

  const tieredInternals = tieredStores(tiered);
  const currentLayout = summarizeRowGroupLayout(current);
  const tieredHotLayout = summarizeRowGroupLayout(tieredInternals.hotStore);
  const tieredColdLayout = summarizeRowGroupLayout(tieredInternals.coldStore);

  return {
    name,
    seriesCount: config.seriesCount,
    pointsPerSeries: config.pointsPerSeries,
    totalSamples,
    skipped: false,
    current640: {
      memoryBytes: current.memoryBytes(),
      bytesPerSample: Number((current.memoryBytes() / totalSamples).toFixed(4)),
      ingestMs: Number(ingestCurrentMs.toFixed(3)),
      queryMs: Number(currentQueryMs.toFixed(3)),
      hotReadMs: Number(currentHotReadMs.toFixed(3)),
      layout: currentLayout,
    },
    tiered80to640: {
      memoryBytes: tiered.memoryBytes(),
      bytesPerSample: Number((tiered.memoryBytes() / totalSamples).toFixed(4)),
      hotBytes: tieredInternals.hotStore.memoryBytesExcludingLabels(),
      coldBytes: tieredInternals.coldStore.memoryBytesExcludingLabels(),
      ingestMs: Number(ingestTieredMs.toFixed(3)),
      queryMs: Number(tieredQueryMs.toFixed(3)),
      hotReadMs: Number(tieredHotReadMs.toFixed(3)),
      hotLayout: tieredHotLayout,
      coldLayout: tieredColdLayout,
    },
  };
}

async function main() {
  const codecs = await loadBenchWasmCodecs();
  const rows: SweepRow[] = [];

  for (const seriesCount of SERIES_COUNTS) {
    for (const shape of SHAPES) {
      rows.push(measureScenario(codecs, makeScenarioConfig(seriesCount, shape.pointsPerSeries)));
    }
  }

  console.log(
    JSON.stringify(
      {
        config: {
          seriesCounts: SERIES_COUNTS,
          shapes: SHAPES,
          maxTotalSamples: MAX_TOTAL_SAMPLES,
          hotChunkSize: HOT_SIZE,
          coldChunkSize: COLD_SIZE,
          batchSize: BATCH,
        },
        rows,
      },
      null,
      2
    )
  );
}

void main();
