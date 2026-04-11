/**
 * Monitor action post entry point.
 *
 * Runs automatically when the job finishes (success or failure).
 * Stops the OTel Collector and pushes telemetry to the data branch.
 */

import * as core from "@actions/core";
import { stopOtelCollector } from "./otel-stop.js";

async function run(): Promise<void> {
  await stopOtelCollector();
}

run().catch((err) => {
  // Post steps should not fail the job — just warn
  core.warning(
    `Monitor post step failed: ${err instanceof Error ? err.message : String(err)}`,
  );
});
