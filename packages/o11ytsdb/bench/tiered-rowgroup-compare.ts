import { loadBenchWasmCodecs } from "./common.js";
import { measureTieredIngestCompare } from "./tiered-metrics.js";

async function main() {
  const codecs = await loadBenchWasmCodecs();
  console.log(JSON.stringify(measureTieredIngestCompare(codecs), null, 2));
}

void main();
