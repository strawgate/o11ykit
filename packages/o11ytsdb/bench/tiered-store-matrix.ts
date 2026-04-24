import { BATCH } from "./tiered-fixture.js";
import { loadBenchWasmCodecs } from "./common.js";
import { measureTieredStoreMatrix } from "./tiered-metrics.js";

const DEFAULT_QUERY_ITERATIONS = 8;
const DEFAULT_COMPACTION_ITERATIONS = 12;

async function main() {
  const queryIterations = Number.parseInt(
    process.argv[2] ?? `${DEFAULT_QUERY_ITERATIONS}`,
    10
  );
  const compactionIterations = Number.parseInt(
    process.argv[3] ?? `${DEFAULT_COMPACTION_ITERATIONS}`,
    10
  );
  const memoryBatchSize = Number.parseInt(process.argv[4] ?? `${BATCH}`, 10);
  if (!Number.isInteger(queryIterations) || queryIterations <= 0) {
    throw new Error(
      "usage: tiered-store-matrix.ts [queryIterations] [compactionIterations] [memoryBatchSize]"
    );
  }
  if (!Number.isInteger(compactionIterations) || compactionIterations <= 0) {
    throw new Error(
      "usage: tiered-store-matrix.ts [queryIterations] [compactionIterations] [memoryBatchSize]"
    );
  }
  if (!Number.isInteger(memoryBatchSize) || memoryBatchSize <= 0) {
    throw new Error(
      "usage: tiered-store-matrix.ts [queryIterations] [compactionIterations] [memoryBatchSize]"
    );
  }

  const codecs = await loadBenchWasmCodecs();
  const matrix = await measureTieredStoreMatrix({
    queryIterations,
    compactionIterations,
    memoryBatchSize,
    codecs,
  });
  console.log(
    JSON.stringify(
      {
        config: {
          queryIterations,
          compactionIterations,
          memoryBatchSize,
        },
        ...matrix,
      },
      null,
      2
    )
  );
}

void main();
