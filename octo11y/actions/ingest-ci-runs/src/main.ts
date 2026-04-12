import * as core from "@actions/core";
import { runIngestDiscovery } from "./ingest.js";

runIngestDiscovery().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
