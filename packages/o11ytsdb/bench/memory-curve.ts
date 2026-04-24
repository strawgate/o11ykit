import { loadBenchWasmCodecs } from "./common.js";
import { measureTieredMemoryCurve } from "./tiered-metrics.js";
import { BATCH } from "./tiered-fixture.js";

async function main() {
  const batchSize = Number.parseInt(process.argv[2] ?? `${BATCH}`, 10);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("usage: memory-curve.ts [batchSize]");
  }

  const codecs = await loadBenchWasmCodecs();
  console.log(JSON.stringify(measureTieredMemoryCurve(codecs, batchSize), null, 2));
}

void main();
