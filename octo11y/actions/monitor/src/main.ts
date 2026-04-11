/**
 * Monitor action main entry point.
 *
 * Downloads an OTel Collector, generates config from action inputs,
 * and starts it as a background process. The post step (post.ts)
 * handles shutdown and pushing telemetry to the data branch.
 */

import * as core from "@actions/core";
import { startOtelCollector } from "./otel-start.js";

async function run(): Promise<void> {
  await startOtelCollector();
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
