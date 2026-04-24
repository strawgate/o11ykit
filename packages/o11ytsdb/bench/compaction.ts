import { RowGroupStore, TieredRowGroupStore, type Labels } from "../dist/index.js";
import { collectTimingSamples, loadBenchWasmCodecs, summarizeTimings } from "./common.js";

const DEFAULT_ITERATIONS = 12;
const NUM_SERIES = 32;
const HOT_SIZE = 80;
const COLD_SIZE = 640;
const HOTS_PER_COLD = COLD_SIZE / HOT_SIZE;
const PRIME_BLOCKS = HOTS_PER_COLD - 1;
const INTERVAL = 1_000n;

type Batch = {
  timestamps: BigInt64Array;
  values: Float64Array;
};

type TieredInternals = {
  hotStore: RowGroupStore;
  coldStore: RowGroupStore;
};

function makeLabels(seriesIndex: number): Labels {
  return new Map([
    ["__name__", "cpu_usage"],
    ["host", `host-${String(seriesIndex).padStart(2, "0")}`],
    ["region", seriesIndex % 2 === 0 ? "us" : "eu"],
  ]);
}

function makeBlock(seriesIndex: number, blockIndex: number): Batch {
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

function makeStores(codecs: Awaited<ReturnType<typeof loadBenchWasmCodecs>>) {
  return {
    rowGroup: new RowGroupStore(codecs.valuesCodec, HOT_SIZE, () => 0, 8, undefined, codecs.tsCodec),
    tiered: new TieredRowGroupStore(
      codecs.valuesCodec,
      HOT_SIZE,
      COLD_SIZE,
      () => 0,
      8,
      undefined,
      codecs.tsCodec
    ),
  };
}

function createSeriesIds<T extends RowGroupStore | TieredRowGroupStore>(store: T): number[] {
  return Array.from({ length: NUM_SERIES }, (_, seriesIndex) =>
    store.getOrCreateSeries(makeLabels(seriesIndex))
  );
}

function appendRound<T extends RowGroupStore | TieredRowGroupStore>(
  store: T,
  ids: number[],
  blockIndex: number
): void {
  for (let s = 0; s < NUM_SERIES; s++) {
    const batch = makeBlock(s, blockIndex);
    store.appendBatch(ids[s]!, batch.timestamps, batch.values);
  }
}

function tieredStores(store: TieredRowGroupStore): TieredInternals {
  const hotStore = Reflect.get(store, "hotStore") as RowGroupStore | undefined;
  const coldStore = Reflect.get(store, "coldStore") as RowGroupStore | undefined;
  if (!hotStore || !coldStore) {
    throw new Error("failed to access tiered store internals");
  }
  return { hotStore, coldStore };
}

async function main() {
  const iterations = Number.parseInt(process.argv[2] ?? `${DEFAULT_ITERATIONS}`, 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("usage: compaction.ts [iterations]");
  }

  const codecs = await loadBenchWasmCodecs();

  const tieredSteadySamples = collectTimingSamples(iterations, () => {
    const { tiered } = makeStores(codecs);
    const ids = createSeriesIds(tiered);
    appendRound(tiered, ids, 0);
  });

  const rowGroupAppendSamples = collectTimingSamples(iterations, () => {
    const { rowGroup } = makeStores(codecs);
    const ids = createSeriesIds(rowGroup);
    for (let blockIndex = 0; blockIndex < PRIME_BLOCKS; blockIndex++) {
      appendRound(rowGroup, ids, blockIndex);
    }
    appendRound(rowGroup, ids, PRIME_BLOCKS);
  });

  const tieredCompactingSamples = collectTimingSamples(iterations, () => {
    const { tiered } = makeStores(codecs);
    const ids = createSeriesIds(tiered);
    for (let blockIndex = 0; blockIndex < PRIME_BLOCKS; blockIndex++) {
      appendRound(tiered, ids, blockIndex);
    }
    appendRound(tiered, ids, PRIME_BLOCKS);
  });

  const { tiered } = makeStores(codecs);
  const ids = createSeriesIds(tiered);
  for (let blockIndex = 0; blockIndex < PRIME_BLOCKS; blockIndex++) {
    appendRound(tiered, ids, blockIndex);
  }
  const before = tieredStores(tiered);
  const beforeHotSamples = before.hotStore.sampleCount;
  const beforeColdSamples = before.coldStore.sampleCount;
  const beforeMemoryBytes = tiered.memoryBytes();
  appendRound(tiered, ids, PRIME_BLOCKS);
  const after = tieredStores(tiered);
  const afterMemoryBytes = tiered.memoryBytes();

  console.log(
    JSON.stringify(
      {
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
            coldSamples: after.coldStore.sampleCount,
            memoryBytes: afterMemoryBytes,
          },
        },
      },
      null,
      2
    )
  );
}

void main();
