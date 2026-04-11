import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DEFAULT_DATA_BRANCH } from "@benchkit/format";
import {
  sortRuns,
  pruneRuns,
  buildIndex,
  buildSeries,
  readRuns,
  type ParsedRun,
} from "./aggregate.js";
import {
  buildRefIndex,
  buildPrIndex,
  buildRunDetail,
  buildMetricSummaryViews,
  buildBadges,
} from "./views.js";
import { classifyFetchFailure } from "./git-fetch.js";
import { classifyPushFailure } from "./git-push.js";
import {
  computeRetryDelayMs,
  DEFAULT_PUSH_RETRY_COUNT,
  sleep,
} from "@octo11y/core";

interface AggregateOutputs {
  runCount: number;
  metrics: string[];
}

async function run(): Promise<void> {
  const dataBranch = core.getInput("data-branch") || DEFAULT_DATA_BRANCH;
  const token = core.getInput("github-token", { required: true });
  const maxRuns = parseInt(core.getInput("max-runs") || "0", 10);
  if (maxRuns < 0 || maxRuns > 10_000) {
    throw new Error(`max-runs must be between 0 and 10000, got ${maxRuns}`);
  }
  const writeBadges = core.getInput("badges") !== "false";

  await configureGit(token);

  const outputs = await aggregateWithRetry(dataBranch, maxRuns, writeBadges);
  core.setOutput("run-count", String(outputs.runCount));
  core.setOutput("metrics", outputs.metrics.join(","));
}

async function aggregateWithRetry(dataBranch: string, maxRuns: number, writeBadges: boolean): Promise<AggregateOutputs> {
  for (let attempt = 1; attempt <= DEFAULT_PUSH_RETRY_COUNT; attempt++) {
    const worktree = await checkoutDataBranch(dataBranch);
    if (!worktree) {
      return { runCount: 0, metrics: [] };
    }

    try {
      const { outputs, hasChanges } = await rebuildAggregates(worktree, maxRuns, writeBadges);
      if (!hasChanges) {
        core.info("No changes to commit");
        return outputs;
      }

      await exec.exec("git", [
        "-C", worktree, "commit", "-m",
        `bench: rebuild index and series (${outputs.runCount} runs)`,
      ]);

      const pushResult = await pushAggregates(worktree, dataBranch);
      if (!pushResult) {
        core.info(`Pushed aggregated data to ${dataBranch}`);
        return outputs;
      }

      if (pushResult.failure.kind === "non-fast-forward" && attempt < DEFAULT_PUSH_RETRY_COUNT) {
        const delayMs = computeRetryDelayMs(Math.random());
        core.warning(
          `Aggregate push was rejected by concurrent bench-data updates (attempt ${attempt}/${DEFAULT_PUSH_RETRY_COUNT}); waiting ${delayMs}ms before refetching and recomputing...`,
        );
        await sleep(delayMs);
        continue;
      }

      throw new Error(
        `Failed to push aggregated data to '${dataBranch}': ${pushResult.stderr.trim() || "git push failed"}`,
      );
    } finally {
      const removeCode = await exec.exec(
        "git", ["worktree", "remove", worktree, "--force"],
        { ignoreReturnCode: true },
      );
      if (removeCode !== 0) {
        core.warning(`Failed to remove worktree '${worktree}'; it may need manual cleanup.`);
      }
    }
  }

  throw new Error(`Failed to push aggregated data to '${dataBranch}' after ${DEFAULT_PUSH_RETRY_COUNT} attempts`);
}

// ── Helpers ─────────────────────────────────────────────────────────

async function configureGit(token: string): Promise<void> {
  await exec.exec("git", ["config", "user.name", "github-actions[bot]"]);
  await exec.exec("git", [
    "config", "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
  await exec.exec("git", [
    "config", "--local",
    "http.https://github.com/.extraheader",
    `AUTHORIZATION: basic ${basicAuth}`,
  ]);
}

async function checkoutDataBranch(dataBranch: string): Promise<string | null> {
  const worktree = path.join(os.tmpdir(), `benchkit-agg-${Date.now()}`);
  let fetchStderr = "";
  const fetchCode = await exec.exec(
    "git", ["fetch", "origin", `+${dataBranch}:${dataBranch}`],
    {
      ignoreReturnCode: true,
      listeners: { stderr: (data: Buffer) => { fetchStderr += data.toString(); } },
    },
  );
  if (fetchCode !== 0) {
    const fetchFailure = classifyFetchFailure(dataBranch, fetchStderr);
    if (fetchFailure.kind === "checked-out") {
      throw new Error(fetchFailure.message);
    }
    if (fetchFailure.kind === "branch-missing") {
      core.warning(`Branch '${dataBranch}' does not exist. Nothing to aggregate.`);
      return null;
    }
    throw new Error(
      `Failed to fetch '${dataBranch}' from origin: ${fetchStderr.trim() || `git fetch exited with code ${fetchCode}`}`,
    );
  }

  await exec.exec("git", ["worktree", "add", worktree, dataBranch]);
  return worktree;
}

async function rebuildAggregates(
  worktree: string,
  maxRuns: number,
  writeBadges: boolean,
): Promise<{ outputs: AggregateOutputs; hasChanges: boolean }> {
  const runsDir = path.join(worktree, "data", "runs");
  if (!fs.existsSync(runsDir)) {
    core.warning("No runs directory found. Nothing to aggregate.");
    return { outputs: { runCount: 0, metrics: [] }, hasChanges: false };
  }

  const runs = readRuns(runsDir);
  core.info(`Found ${runs.length} run file(s)`);

  sortRuns(runs);
  const pruned = pruneRuns(runs, maxRuns);
  for (const id of pruned) {
    fs.unlinkSync(path.join(runsDir, `${id}.json`));
    core.info(`Pruned old run: ${id}`);
  }

  const index = buildIndex(runs);
  const allMetrics = index.metrics ?? [];
  const seriesMap = buildSeries(runs);

  writeAggregatedFiles(worktree, index, seriesMap, runs, writeBadges);
  core.info(`Wrote index.json (${index.runs.length} runs, ${allMetrics.length} metrics)`);

  await exec.exec("git", ["-C", worktree, "add", "."]);
  const diffCode = await exec.exec(
    "git", ["-C", worktree, "diff", "--cached", "--quiet"],
    { ignoreReturnCode: true },
  );

  return {
    outputs: { runCount: runs.length, metrics: allMetrics },
    hasChanges: diffCode !== 0,
  };
}

async function pushAggregates(
  worktree: string,
  dataBranch: string,
): Promise<{ failure: ReturnType<typeof classifyPushFailure>; stderr: string } | null> {
  let pushStderr = "";
  const pushCode = await exec.exec(
    "git",
    ["-C", worktree, "push", "origin", `HEAD:${dataBranch}`],
    {
      ignoreReturnCode: true,
      listeners: { stderr: (data: Buffer) => { pushStderr += data.toString(); } },
    },
  );

  if (pushCode === 0) {
    return null;
  }

  return {
    failure: classifyPushFailure(pushStderr),
    stderr: pushStderr,
  };
}

function writeAggregatedFiles(
  worktree: string,
  index: ReturnType<typeof buildIndex>,
  seriesMap: ReturnType<typeof buildSeries>,
  runs: ParsedRun[],
  writeBadges: boolean,
): void {
  const dataDir = path.join(worktree, "data");
  fs.writeFileSync(path.join(dataDir, "index.json"), JSON.stringify(index, null, 2) + "\n");

  const seriesDir = path.join(dataDir, "series");
  fs.mkdirSync(seriesDir, { recursive: true });

  // Remove stale series files
  if (fs.existsSync(seriesDir)) {
    fs.rmSync(seriesDir, { recursive: true, force: true });
  }
  fs.mkdirSync(seriesDir, { recursive: true });

  for (const [metricName, series] of seriesMap) {
    const fileName = `${metricName}.json`;
    const filePath = path.join(seriesDir, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(series, null, 2) + "\n");
    core.info(`Wrote series/${fileName}`);
  }

  // ── Navigation indexes ──────────────────────────────────────────
  const indexDir = path.join(dataDir, "index");
  if (fs.existsSync(indexDir)) {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
  fs.mkdirSync(indexDir, { recursive: true });

  const refsIndex = buildRefIndex(index.runs);
  fs.writeFileSync(path.join(indexDir, "refs.json"), JSON.stringify(refsIndex, null, 2) + "\n");
  core.info(`Wrote index/refs.json (${refsIndex.length} refs)`);

  const prsIndex = buildPrIndex(index.runs);
  fs.writeFileSync(path.join(indexDir, "prs.json"), JSON.stringify(prsIndex, null, 2) + "\n");
  core.info(`Wrote index/prs.json (${prsIndex.length} PRs)`);

  const metricsIndex = buildMetricSummaryViews(seriesMap);
  fs.writeFileSync(path.join(indexDir, "metrics.json"), JSON.stringify(metricsIndex, null, 2) + "\n");
  core.info(`Wrote index/metrics.json (${metricsIndex.length} metrics)`);

  // ── Run detail views ────────────────────────────────────────────
  const runsViewDir = path.join(dataDir, "views", "runs");
  if (fs.existsSync(runsViewDir)) {
    fs.rmSync(runsViewDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runsViewDir, { recursive: true });

  for (const run of runs) {
    const detail = buildRunDetail(run.id, runs);
    if (detail) {
      const runDetailDir = path.join(runsViewDir, run.id);
      fs.mkdirSync(runDetailDir, { recursive: true });
      fs.writeFileSync(path.join(runDetailDir, "detail.json"), JSON.stringify(detail, null, 2) + "\n");
    }
  }
  core.info(`Wrote views/runs/{id}/detail.json for ${runs.length} run(s)`);

  // ── Badge endpoints ─────────────────────────────────────────────
  if (writeBadges) {
    const badgesDir = path.join(dataDir, "badges");
    if (fs.existsSync(badgesDir)) {
      fs.rmSync(badgesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(badgesDir, { recursive: true });

    const badges = buildBadges(seriesMap);
    for (const [metric, badge] of badges) {
      const fileName = `${metric}.json`;
      const filePath = path.join(badgesDir, fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(badge, null, 2) + "\n");
    }
    core.info(`Wrote badges/ for ${badges.size} metric(s)`);
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
