import * as core from "@actions/core";
import { runEmitMetricAction } from "./emit-metric.js";

async function run(): Promise<void> {
  await runEmitMetricAction();
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
