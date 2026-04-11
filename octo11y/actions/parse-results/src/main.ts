import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MetricsBatch,
  type Format,
  DEFAULT_DATA_BRANCH,
} from "@benchkit/format";
import {
  checkoutDataBranch,
  configureGit,
  pushWithRetry,
} from "@benchkit/actions-common";
import { DEFAULT_PUSH_RETRY_COUNT } from "@octo11y/core";
import { loadWorkflowAttemptLogs } from "./log-source.js";
import {
  buildRunId,
  createTempResultPath,
  formatSummaryMarkdown,
  getEmptyBenchmarksWarning,
  mergeDocuments,
  parseBenchmarkContent,
  readMonitorOutput,
  resolveMode,
  writeResultFile,
} from "./parse-results.js";

async function parseFromFiles(resultsPattern: string): Promise<{ contentName: string; content: string }> {
  const globber = await glob.create(resultsPattern);
  const files = await globber.glob();
  if (files.length === 0) {
    throw new Error(`No files matched pattern: ${resultsPattern}`);
  }
  core.info(`Found ${files.length} result file(s)`);
  const parts: string[] = [];
  for (const filePath of files.sort()) {
    parts.push(fs.readFileSync(filePath, "utf-8"));
  }
  return {
    contentName: files.length === 1 ? files[0] : `${files.length} files from ${resultsPattern}`,
    content: parts.join("\n"),
  };
}

async function run(): Promise<void> {
  const mode = resolveMode(core.getInput("mode") || "auto");
  const format = (core.getInput("format") || "auto") as Format;
  const dataBranch = core.getInput("data-branch") || DEFAULT_DATA_BRANCH;
  const token = core.getInput("github-token");
  const resultsPattern = core.getInput("results");
  const monitorPath = core.getInput("monitor-results");
  const writeSummary = core.getBooleanInput("summary");
  const commitResults = core.getBooleanInput("commit-results");
  const runId = buildRunId({
    customRunId: core.getInput("run-id") || undefined,
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    githubJob: process.env.GITHUB_JOB,
  });

  let sourceName: string;
  let sourceContent: string;
  if (mode === "auto") {
    if (!token) {
      throw new Error("github-token is required when mode=auto");
    }
    sourceName = `workflow-run-${process.env.GITHUB_RUN_ID ?? "unknown"}-logs`;
    sourceContent = await loadWorkflowAttemptLogs(token);
    core.info(`Loaded ${sourceContent.length} bytes from GitHub Actions logs`);
  } else {
    if (!resultsPattern) {
      throw new Error("results input is required when mode=file");
    }
    const source = await parseFromFiles(resultsPattern);
    sourceName = source.contentName;
    sourceContent = source.content;
  }

  const benchmarkDoc = parseBenchmarkContent(sourceContent, format, sourceName);
  const warning = getEmptyBenchmarksWarning(benchmarkDoc);
  if (warning) {
    core.warning(warning);
  }

  const monitorDoc = monitorPath ? readMonitorOutput(monitorPath) : undefined;
  const result = mergeDocuments(benchmarkDoc, monitorDoc, {
    commit: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    runner: process.env.RUNNER_OS
      ? `${process.env.RUNNER_OS}/${process.env.RUNNER_ARCH}`
      : undefined,
  });

  const batch = MetricsBatch.fromOtlp(result);
  core.info(`Parsed ${batch.size} metric datapoint(s) from mode=${mode}`);

  const tempResultPath = createTempResultPath(runId);
  writeResultFile(result, tempResultPath);
  core.info(`Wrote ${tempResultPath}`);

  if (writeSummary) {
    await core.summary
      .addRaw(formatSummaryMarkdown(result, runId, mode), true)
      .write();
  }

  let filePathOutput = tempResultPath;
  if (commitResults) {
    if (!token) {
      throw new Error("github-token is required when commit-results=true");
    }
    await configureGit(token);
    const worktree = await checkoutDataBranch(dataBranch, "benchkit-parse-results");
    const resultPath = path.join(worktree, "data", "runs", runId, "benchmark.otlp.json");
    if (fs.existsSync(resultPath)) {
      throw new Error(
        `Refusing to overwrite existing run document: data/runs/${runId}/benchmark.otlp.json already exists on '${dataBranch}'. `
        + "run-id values must be unique per write.",
      );
    }
    writeResultFile(result, resultPath);
    await exec.exec("git", ["-C", worktree, "add", "."]);
    await exec.exec("git", ["-C", worktree, "commit", "-m", `bench: add run ${runId}`]);
    await pushWithRetry(worktree, dataBranch, DEFAULT_PUSH_RETRY_COUNT);
    await exec.exec("git", ["worktree", "remove", worktree, "--force"]);
    filePathOutput = `data/runs/${runId}/benchmark.otlp.json`;
  } else {
    core.info("commit-results=false; skipping data branch commit");
  }

  core.setOutput("run-id", runId);
  core.setOutput("file-path", filePathOutput);
  core.setOutput("source", mode);
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
