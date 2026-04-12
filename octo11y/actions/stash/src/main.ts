import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildResult,
  buildRunId,
  createTempResultPath,
  formatResultSummaryMarkdown,
  getEmptyBenchmarksWarning,
  parseBenchmarkFiles,
  readMonitorOutput,
  writeResultFile,
} from "./stash.js";
import type { Format } from "@benchkit/format";
import {
  MetricsBatch,
  DEFAULT_DATA_BRANCH,
} from "@benchkit/format";
import {
  configureGit,
  checkoutDataBranch,
  pushWithRetry,
} from "@benchkit/actions-common";
import { DEFAULT_PUSH_RETRY_COUNT } from "@octo11y/core";

async function run(): Promise<void> {
  const resultsPattern = core.getInput("results", { required: true });
  const format = (core.getInput("format") || "auto") as Format;
  const dataBranch = core.getInput("data-branch") || DEFAULT_DATA_BRANCH;
  const token = core.getInput("github-token", { required: true });

  const monitorPath = core.getInput("monitor-results") || "";

  const commitResultsInputRaw = core.getInput("commit-results");
  let saveDataFile = true;
  const commitInputName = "commit-results";

  if (commitResultsInputRaw !== "") {
    saveDataFile = core.getBooleanInput("commit-results");
  }

  const writeSummary = core.getBooleanInput("summary");
  const runId = buildRunId({
    customRunId: core.getInput("run-id") || undefined,
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    githubJob: process.env.GITHUB_JOB,
  });

  // Parse benchmark files
  const globber = await glob.create(resultsPattern);
  const files = await globber.glob();
  if (files.length === 0) {
    throw new Error(`No files matched pattern: ${resultsPattern}`);
  }
  core.info(`Found ${files.length} result file(s)`);
  const benchmarkDoc = parseBenchmarkFiles(files, format);
  const emptyBenchmarksWarning = getEmptyBenchmarksWarning(benchmarkDoc);
  if (emptyBenchmarksWarning) {
    core.warning(emptyBenchmarksWarning);
  }

  // Merge monitor output if provided
  const monitorDoc = monitorPath ? readMonitorOutput(monitorPath) : undefined;

  const result = buildResult({
    benchmarkDoc,
    monitorDoc,
    context: {
      commit: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF,
      timestamp: new Date().toISOString(),
      runner: process.env.RUNNER_OS
        ? `${process.env.RUNNER_OS}/${process.env.RUNNER_ARCH}`
        : undefined,
    },
  });

  const batch = MetricsBatch.fromOtlp(result);
  const monitorCount = monitorDoc
    ? MetricsBatch.fromOtlp(monitorDoc).size
    : 0;
  core.info(`Parsed ${batch.withoutMonitor().size} benchmark metric(s)${monitorCount ? ` + ${monitorCount} monitor metric(s)` : ""}`);

  const tempResultPath = createTempResultPath(runId);
  writeResultFile(result, runId, tempResultPath);
  core.info(`Wrote ${tempResultPath}`);

  if (writeSummary) {
    await core.summary
      .addRaw(formatResultSummaryMarkdown(result, { runId }), true)
      .write();
  }

  let filePathOutput = tempResultPath;

  if (saveDataFile) {
    // Git setup and push
    await configureGit(token);
    const worktree = await checkoutDataBranch(dataBranch, "benchkit-stash");

    const resultPath = path.join(worktree, "data", "runs", runId, "benchmark.otlp.json");
    if (fs.existsSync(resultPath)) {
      throw new Error(
        `Refusing to overwrite existing run document: data/runs/${runId}/benchmark.otlp.json already exists on '${dataBranch}'. `
        + "run-id values must be unique per write.",
      );
    }
    writeResultFile(result, runId, resultPath);
    core.info(`Wrote ${resultPath}`);

    await exec.exec("git", ["-C", worktree, "add", "."]);
    await exec.exec("git", ["-C", worktree, "commit", "-m", `bench: add run ${runId}`]);
    await pushWithRetry(worktree, dataBranch, DEFAULT_PUSH_RETRY_COUNT);
    await exec.exec("git", ["worktree", "remove", worktree, "--force"]);
    filePathOutput = `data/runs/${runId}/benchmark.otlp.json`;
  } else {
    core.info(`${commitInputName}=false; skipping data branch commit`);
  }

  core.setOutput("run-id", runId);
  core.setOutput("file-path", filePathOutput);
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
