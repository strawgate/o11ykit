import { ScanEngine, type RowGroupStore, type TieredRowGroupStore, type WasmCodecs } from "../dist/index.js";
import { collectTimingSamples, summarizeTimings, timeMs } from "./common.js";
import {
  BATCH,
  COLD_ONLY_END,
  COLD_SIZE,
  HOT_ONLY_START,
  HOT_SIZE,
  INTERVAL,
  MIXED_BOUNDARY_START,
  NUM_SERIES,
  POINTS_PER_SERIES,
  PRIME_BLOCKS,
  TOTAL_END,
  TOTAL_SAMPLES,
  appendHotRound,
  buildDataset,
  createCurrentStore,
  createLabels,
  createSeriesIds,
  createTieredStore,
  ingestDataset,
  tieredStores,
} from "./tiered-fixture.js";

const DEFAULT_QUERY_ITERATIONS = 8;
const DEFAULT_COMPACTION_ITERATIONS = 12;

type Workload = {
  name: string;
  kind: "query" | "read";
  run: (store: RowGroupStore | TieredRowGroupStore, engine: ScanEngine) => void;
};

function benchmarkStore(
  store: RowGroupStore | TieredRowGroupStore,
  engine: ScanEngine,
  workloads: Workload[],
  iterations: number
) {
  return workloads.map((workload) => {
    workload.run(store, engine);
    const samples = collectTimingSamples(iterations, () => {
      workload.run(store, engine);
    });
    return {
      name: workload.name,
      kind: workload.kind,
      summary: summarizeTimings(samples),
    };
  });
}

function tieredQueryWorkloads(): Workload[] {
  return [
    {
      name: "cold-step-sum",
      kind: "query",
      run: (store, scanEngine) => {
        scanEngine.query(store, {
          metric: "cpu_usage",
          matchers: [{ label: "region", op: "=" as const, value: "us" }],
          start: 0n,
          end: COLD_ONLY_END,
          agg: "sum",
          step: 300_000n,
        });
      },
    },
    {
      name: "boundary-step-sum",
      kind: "query",
      run: (store, scanEngine) => {
        scanEngine.query(store, {
          metric: "cpu_usage",
          matchers: [{ label: "region", op: "=" as const, value: "us" }],
          start: MIXED_BOUNDARY_START,
          end: TOTAL_END,
          agg: "sum",
          step: 30_000n,
        });
      },
    },
    {
      name: "hot-step-sum",
      kind: "query",
      run: (store, scanEngine) => {
        scanEngine.query(store, {
          metric: "cpu_usage",
          start: HOT_ONLY_START,
          end: TOTAL_END,
          agg: "sum",
          step: 10_000n,
        });
      },
    },
    {
      name: "full-range-count",
      kind: "query",
      run: (store, scanEngine) => {
        scanEngine.query(store, {
          metric: "cpu_usage",
          matchers: [{ label: "region", op: "=" as const, value: "us" }],
          start: 0n,
          end: TOTAL_END,
          agg: "count",
          step: 300_000n,
        });
      },
    },
    {
      name: "cold-raw-read",
      kind: "read",
      run: (store) => {
        store.read(0, 0n, 512n * INTERVAL);
      },
    },
    {
      name: "hot-raw-read",
      kind: "read",
      run: (store) => {
        store.read(0, HOT_ONLY_START, TOTAL_END);
      },
    },
  ];
}

export function measureTieredQueryMatrix(codecs: WasmCodecs, iterations = DEFAULT_QUERY_ITERATIONS) {
  const dataset = buildDataset();
  const labels = createLabels();
  const current = createCurrentStore(codecs);
  const tiered = createTieredStore(codecs);
  const currentIds = createSeriesIds(current, labels);
  const tieredIds = createSeriesIds(tiered, labels);
  ingestDataset(current, currentIds, dataset);
  ingestDataset(tiered, tieredIds, dataset);
  tiered.drainCompaction();

  const engine = new ScanEngine();
  const workloads = tieredQueryWorkloads();

  return {
    config: {
      iterations,
      seriesCount: NUM_SERIES,
      pointsPerSeries: POINTS_PER_SERIES,
      batchSize: BATCH,
      currentChunkSize: COLD_SIZE,
      tieredHotChunkSize: HOT_SIZE,
      tieredColdChunkSize: COLD_SIZE,
    },
    current640: benchmarkStore(current, engine, workloads, iterations),
    tiered80to640: benchmarkStore(tiered, engine, workloads, iterations),
  };
}

export function measureTieredIngestCompare(codecs: WasmCodecs) {
  const dataset = buildDataset();
  const labels = createLabels();
  const makeCurrent = () => createCurrentStore(codecs);
  const makeTiered = () => createTieredStore(codecs);

  const warmCurrent = makeCurrent();
  const warmTiered = makeTiered();
  ingestDataset(warmCurrent, createSeriesIds(warmCurrent, labels), dataset);
  ingestDataset(warmTiered, createSeriesIds(warmTiered, labels), dataset);
  warmTiered.drainCompaction();

  const current = makeCurrent();
  const tiered = makeTiered();
  const currentIds = createSeriesIds(current, labels);
  const tieredIds = createSeriesIds(tiered, labels);

  const ingestCurrentMs = timeMs(() => {
    ingestDataset(current, currentIds, dataset);
  });
  const ingestTieredMs = timeMs(() => {
    ingestDataset(tiered, tieredIds, dataset);
  });
  const tieredPostAppendMemoryBytes = tiered.memoryBytes();
  const tieredBackgroundCompactionMs = timeMs(() => {
    tiered.drainCompaction();
  });
  const currentPostIngestMemoryBytes = current.memoryBytes();
  const tieredPostIngestMemoryBytes = tiered.memoryBytes();

  const engine = new ScanEngine();
  const query = {
    metric: "cpu_usage",
    matchers: [{ label: "region", op: "=" as const, value: "us" }],
    start: 0n,
    end: TOTAL_END,
    agg: "sum" as const,
    step: 300_000n,
  };

  engine.query(warmCurrent, query);
  engine.query(warmTiered, query);

  const currentQueryMs = timeMs(() => {
    engine.query(current, query);
  });
  const tieredQueryMs = timeMs(() => {
    engine.query(tiered, query);
  });
  const currentPostQueryMemoryBytes = current.memoryBytes();
  const tieredPostQueryMemoryBytes = tiered.memoryBytes();

  return {
    current640: {
      sampleCount: current.sampleCount,
      memoryBytes: currentPostIngestMemoryBytes,
      bytesPerSample:
        current.sampleCount > 0
          ? Number((currentPostIngestMemoryBytes / current.sampleCount).toFixed(4))
          : 0,
      postQueryMemoryBytes: currentPostQueryMemoryBytes,
      postQueryBytesPerSample:
        current.sampleCount > 0
          ? Number((currentPostQueryMemoryBytes / current.sampleCount).toFixed(4))
          : 0,
      ingestMs: Number(ingestCurrentMs.toFixed(3)),
      queryMs: Number(currentQueryMs.toFixed(3)),
    },
    tiered80to640: {
      sampleCount: tiered.sampleCount,
      memoryBytes: tieredPostIngestMemoryBytes,
      bytesPerSample:
        tiered.sampleCount > 0
          ? Number((tieredPostIngestMemoryBytes / tiered.sampleCount).toFixed(4))
          : 0,
      postQueryMemoryBytes: tieredPostQueryMemoryBytes,
      postQueryBytesPerSample:
        tiered.sampleCount > 0
          ? Number((tieredPostQueryMemoryBytes / tiered.sampleCount).toFixed(4))
          : 0,
      ingestMs: Number(ingestTieredMs.toFixed(3)),
      postAppendMemoryBytes: tieredPostAppendMemoryBytes,
      postAppendBytesPerSample:
        tiered.sampleCount > 0
          ? Number((tieredPostAppendMemoryBytes / tiered.sampleCount).toFixed(4))
          : 0,
      backgroundCompactionMs: Number(tieredBackgroundCompactionMs.toFixed(3)),
      endToEndIngestMs: Number((ingestTieredMs + tieredBackgroundCompactionMs).toFixed(3)),
      queryMs: Number(tieredQueryMs.toFixed(3)),
    },
  };
}

export function measureTieredCompaction(codecs: WasmCodecs, iterations = DEFAULT_COMPACTION_ITERATIONS) {
  const labels = createLabels();

  const tieredSteadySamples = collectTimingSamples(iterations, () => {
    const tiered = createTieredStore(codecs);
    const ids = createSeriesIds(tiered, labels);
    appendHotRound(tiered, ids, 0);
  });

  const rowGroupAppendSamples = collectTimingSamples(iterations, () => {
    const rowGroup = createCurrentStore(codecs);
    const ids = createSeriesIds(rowGroup, labels);
    for (let blockIndex = 0; blockIndex < PRIME_BLOCKS; blockIndex++) {
      appendHotRound(rowGroup, ids, blockIndex);
    }
    appendHotRound(rowGroup, ids, PRIME_BLOCKS);
  });

  const tieredCompactingSamples = collectTimingSamples(iterations, () => {
    const tiered = createTieredStore(codecs);
    const ids = createSeriesIds(tiered, labels);
    for (let blockIndex = 0; blockIndex < PRIME_BLOCKS; blockIndex++) {
      appendHotRound(tiered, ids, blockIndex);
    }
    appendHotRound(tiered, ids, PRIME_BLOCKS);
    tiered.drainCompaction();
  });

  const tiered = createTieredStore(codecs);
  const ids = createSeriesIds(tiered, labels);
  for (let blockIndex = 0; blockIndex < PRIME_BLOCKS; blockIndex++) {
    appendHotRound(tiered, ids, blockIndex);
  }
  const before = tieredStores(tiered);
  const beforeHotSamples = before.hotStore.sampleCount;
  const beforeColdSamples = before.promotedStore.sampleCount + before.compactedStore.sampleCount;
  const beforeMemoryBytes = tiered.memoryBytes();
  appendHotRound(tiered, ids, PRIME_BLOCKS);
  const drainMs = timeMs(() => {
    tiered.drainCompaction();
  });
  const after = tieredStores(tiered);

  return {
    config: {
      iterations,
      seriesCount: NUM_SERIES,
      hotChunkSize: HOT_SIZE,
      coldChunkSize: COLD_SIZE,
      primeBlocks: PRIME_BLOCKS,
      compactedSamplesPerSeries: COLD_SIZE,
    },
    timings: {
      tieredSteadyRound: summarizeTimings(tieredSteadySamples),
      rowGroupHotRound: summarizeTimings(rowGroupAppendSamples),
      tieredCompactingRound: summarizeTimings(tieredCompactingSamples),
    },
    compactionState: {
      before: {
        hotSamples: beforeHotSamples,
        coldSamples: beforeColdSamples,
        memoryBytes: beforeMemoryBytes,
      },
      after: {
        hotSamples: after.hotStore.sampleCount,
        coldSamples: after.promotedStore.sampleCount + after.compactedStore.sampleCount,
        memoryBytes: tiered.memoryBytes(),
        drainMs: Number(drainMs.toFixed(3)),
      },
    },
  };
}

export function measureTieredMemoryCurve(codecs: WasmCodecs, batchSize = BATCH) {
  const checkpoints = [51_200, 100_352, 251_904, 501_760, 751_616, 1_000_000];
  const current = createCurrentStore(codecs);
  const tiered = createTieredStore(codecs);
  const labels = createLabels();
  const currentIds = createSeriesIds(current, labels);
  const tieredIds = createSeriesIds(tiered, labels);
  const dataset = buildDataset();
  const rows = [];
  let nextCheckpoint = 0;

  for (let off = 0; off < POINTS_PER_SERIES && nextCheckpoint < checkpoints.length; off += batchSize) {
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
    while (nextCheckpoint < checkpoints.length && samples >= checkpoints[nextCheckpoint]!) {
      tiered.drainCompaction();
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
          coldBytes:
            tieredInternals.promotedStore.memoryBytesExcludingLabels() +
            tieredInternals.compactedStore.memoryBytesExcludingLabels(),
        },
      });
      nextCheckpoint++;
    }
  }

  return {
    config: {
      batchSize,
      seriesCount: NUM_SERIES,
      pointsPerSeries: POINTS_PER_SERIES,
      totalSamples: TOTAL_SAMPLES,
      checkpoints,
    },
    rows,
  };
}

export async function measureTieredStoreMatrix({
  queryIterations = DEFAULT_QUERY_ITERATIONS,
  compactionIterations = DEFAULT_COMPACTION_ITERATIONS,
  memoryBatchSize = BATCH,
  codecs,
}: {
  queryIterations?: number;
  compactionIterations?: number;
  memoryBatchSize?: number;
  codecs: WasmCodecs;
}) {
  return {
    ingest: measureTieredIngestCompare(codecs),
    queryMatrix: measureTieredQueryMatrix(codecs, queryIterations),
    compaction: measureTieredCompaction(codecs, compactionIterations),
    memoryCurve: measureTieredMemoryCurve(codecs, memoryBatchSize),
  };
}
