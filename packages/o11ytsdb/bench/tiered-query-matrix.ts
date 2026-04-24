import { RowGroupStore, ScanEngine, TieredRowGroupStore, type Labels } from "../dist/index.js";
import { collectTimingSamples, loadBenchWasmCodecs, summarizeTimings } from "./common.js";

const DEFAULT_ITERATIONS = 8;
const NUM_SERIES = 32;
const POINTS_PER_SERIES = 31_250;
const INTERVAL = 1_000n;
const BATCH = 64;

type SeriesData = {
  timestamps: BigInt64Array;
  values: Float64Array;
};

type Workload = {
  name: string;
  kind: "query" | "read";
  run: (store: RowGroupStore | TieredRowGroupStore, engine: ScanEngine) => void;
};

function makeLabels(seriesIndex: number): Labels {
  return new Map([
    ["__name__", "cpu_usage"],
    ["host", `host-${String(seriesIndex).padStart(2, "0")}`],
    ["region", seriesIndex % 2 === 0 ? "us" : "eu"],
  ]);
}

function buildDataset(): SeriesData[] {
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

function ingestDataset(
  store: RowGroupStore | TieredRowGroupStore,
  ids: number[],
  dataset: SeriesData[]
): void {
  for (let off = 0; off < POINTS_PER_SERIES; off += BATCH) {
    const end = Math.min(off + BATCH, POINTS_PER_SERIES);
    for (let s = 0; s < NUM_SERIES; s++) {
      const series = dataset[s]!;
      store.appendBatch(ids[s]!, series.timestamps.subarray(off, end), series.values.subarray(off, end));
    }
  }
}

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

async function main() {
  const iterations = Number.parseInt(process.argv[2] ?? `${DEFAULT_ITERATIONS}`, 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("usage: tiered-query-matrix.ts [iterations]");
  }

  const codecs = await loadBenchWasmCodecs();
  const dataset = buildDataset();
  const labels = Array.from({ length: NUM_SERIES }, (_, s) => makeLabels(s));
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
  const currentIds = labels.map((label) => current.getOrCreateSeries(label));
  const tieredIds = labels.map((label) => tiered.getOrCreateSeries(label));
  ingestDataset(current, currentIds, dataset);
  ingestDataset(tiered, tieredIds, dataset);

  const engine = new ScanEngine();
  const totalEnd = BigInt(POINTS_PER_SERIES - 1) * INTERVAL;
  const coldEnd = 10_000n * INTERVAL;
  const hotStart = BigInt(POINTS_PER_SERIES - 40) * INTERVAL;
  const boundaryStart = BigInt(POINTS_PER_SERIES - 200) * INTERVAL;

  const workloads: Workload[] = [
    {
      name: "cold-step-sum",
      kind: "query",
      run: (store, scanEngine) => {
        scanEngine.query(store, {
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
      kind: "query",
      run: (store, scanEngine) => {
        scanEngine.query(store, {
          metric: "cpu_usage",
          matchers: [{ label: "region", op: "=" as const, value: "us" }],
          start: boundaryStart,
          end: totalEnd,
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
          start: hotStart,
          end: totalEnd,
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
          end: totalEnd,
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
        store.read(0, hotStart, totalEnd);
      },
    },
  ];

  console.log(
    JSON.stringify(
      {
        config: {
          iterations,
          seriesCount: NUM_SERIES,
          pointsPerSeries: POINTS_PER_SERIES,
          batchSize: BATCH,
          currentChunkSize: 640,
          tieredHotChunkSize: 80,
          tieredColdChunkSize: 640,
        },
        current640: benchmarkStore(current, engine, workloads, iterations),
        tiered80to640: benchmarkStore(tiered, engine, workloads, iterations),
      },
      null,
      2
    )
  );
}

void main();
