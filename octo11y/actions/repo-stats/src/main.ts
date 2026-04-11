import * as core from "@actions/core";
import { runRepoStatsAction } from "./repo-stats.js";

async function run(): Promise<void> {
  await runRepoStatsAction();
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
