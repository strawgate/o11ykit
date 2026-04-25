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
  summarizeColdLayout,
  summarizeRowGroupLayout,
  tieredStores,
} from "./tiered-fixture.js";

const MAX_TOTAL_SAMPLES = 8_000_000;

const SERIES_COUNTS = [32, 128, 512, 2048];
const SHAPES = [
  { name: "low-fill-60", pointsPerSeries: 60 },
  { name: "partial-fill-300", pointsPerSeries: 300 },
  { name: "cold-fill-600", pointsPerSeries: 600 },
  { name: "steady-state-31250", pointsPerSeries: 31_250 },
];

type SweepRow =
  | {
      name: string;
      seriesCount: number;
      pointsPerSeries: number;
      totalSamples: number;
      skipped: false;
      current600: {
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
      tiered60to600: {
        memoryBytes: number;
        bytesPerSample: number;
        hotBytes: number;
        promotedBytes: number;
        compactedBytes: number;
        coldBytes: number;
        ingestMs: number;
        backgroundCompactionMs: number;
        endToEndIngestMs: number;
        queryMs: number;
        hotReadMs: number;
        hotLayout: {
          laneCount: number;
          rowGroupCount: number;
          timestampChunkCount: number;
          avgMembersPerRowGroup: number;
        };
        coldLayout: {
          promoted: {
            windowCount: number;
            partCount: number;
            timestampChunkCount: number;
            avgMembersPerWindow: number;
          };
          compacted: {
            laneCount: number;
            rowGroupCount: number;
            timestampChunkCount: number;
            avgMembersPerRowGroup: number;
          };
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
  const tieredBackgroundCompactionMs = timeMs(() => {
    tiered.drainCompaction();
  });

  const { currentQueryMs, tieredQueryMs, currentHotReadMs, tieredHotReadMs } = runFullRangeQueryMs(
    config,
    current,
    tiered
  );

  const tieredInternals = tieredStores(tiered);
  const currentLayout = summarizeRowGroupLayout(current);
  const tieredHotLayout = summarizeRowGroupLayout(tieredInternals.hotStore);
  const tieredColdLayout = summarizeColdLayout(tieredInternals);
  const promotedBytes = tieredInternals.promotedStore.memoryBytesExcludingLabels();
  const compactedBytes = tieredInternals.compactedStore.memoryBytesExcludingLabels();

  return {
    name,
    seriesCount: config.seriesCount,
    pointsPerSeries: config.pointsPerSeries,
    totalSamples,
    skipped: false,
    current600: {
      memoryBytes: current.memoryBytes(),
      bytesPerSample: Number((current.memoryBytes() / totalSamples).toFixed(4)),
      ingestMs: Number(ingestCurrentMs.toFixed(3)),
      queryMs: Number(currentQueryMs.toFixed(3)),
      hotReadMs: Number(currentHotReadMs.toFixed(3)),
      layout: currentLayout,
    },
    tiered60to600: {
      memoryBytes: tiered.memoryBytes(),
      bytesPerSample: Number((tiered.memoryBytes() / totalSamples).toFixed(4)),
      hotBytes: tieredInternals.hotStore.memoryBytesExcludingLabels(),
      promotedBytes,
      compactedBytes,
      coldBytes: promotedBytes + compactedBytes,
      ingestMs: Number(ingestTieredMs.toFixed(3)),
      backgroundCompactionMs: Number(tieredBackgroundCompactionMs.toFixed(3)),
      endToEndIngestMs: Number((ingestTieredMs + tieredBackgroundCompactionMs).toFixed(3)),
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
