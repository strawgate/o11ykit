import { loadBenchWasmCodecs } from "./common.js";
import { measureTieredCompaction } from "./tiered-metrics.js";

const DEFAULT_ITERATIONS = 12;

async function main() {
  const iterations = Number.parseInt(process.argv[2] ?? `${DEFAULT_ITERATIONS}`, 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("usage: compaction.ts [iterations]");
  }

  const codecs = await loadBenchWasmCodecs();
  console.log(JSON.stringify(measureTieredCompaction(codecs, iterations), null, 2));
}

void main();
