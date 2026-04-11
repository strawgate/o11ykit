import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import * as glob from "@actions/glob";
import { countDataPoints, mergeOtlpDocuments } from "./build-otlp.js";
import { readCurrentRunLogs } from "./log-source.js";
import { parseToOtlpDocument } from "./parsers.js";
import { buildRunId, createTempResultPath, stashResult, writeResultFile } from "./stash.js";
import type { Format, OtlpMetricsDocument, ParseMode } from "./types.js";

function resolveMode(raw: string): ParseMode {
  if (raw === "auto" || raw === "file") return raw;
  throw new Error(`Invalid mode '${raw}'. Expected 'auto' or 'file'.`);
}

async function readFileModeContent(
  pattern: string
): Promise<{ sourceName: string; content: string }> {
  const globber = await glob.create(pattern);
  const files = await globber.glob();
  if (files.length === 0) {
    throw new Error(`No files matched pattern: ${pattern}`);
  }
  const sorted = files.sort();
  const combined = sorted.map((filePath) => fs.readFileSync(filePath, "utf-8")).join("\n");
  return {
    sourceName:
      sorted.length === 1 ? path.basename(sorted[0] ?? pattern) : `${sorted.length} files`,
    content: combined,
  };
}

function readMonitorDocument(monitorPath: string): OtlpMetricsDocument {
  if (!fs.existsSync(monitorPath)) {
    throw new Error(`monitor-results path does not exist: ${monitorPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(monitorPath, "utf-8")) as Partial<OtlpMetricsDocument>;
  if (!Array.isArray(parsed.resourceMetrics)) {
    throw new Error("monitor-results file is not a valid OTLP metrics document.");
  }
  return parsed as OtlpMetricsDocument;
}

function summaryMarkdown(options: {
  readonly runId: string;
  readonly mode: ParseMode;
  readonly format: Format;
  readonly dataPoints: number;
  readonly filePath: string;
}): string {
  return [
    "## Parse Results",
    "",
    `Run ID: \`${options.runId}\``,
    `Mode: \`${options.mode}\``,
    `Format: \`${options.format}\``,
    `Datapoints: **${options.dataPoints}**`,
    `Output: \`${options.filePath}\``,
    "",
  ].join("\n");
}

async function run(): Promise<void> {
  const mode = resolveMode(core.getInput("mode") || "auto");
  const format = (core.getInput("format") || "auto") as Format;
  const dataBranch = core.getInput("data-branch") || "bench-data";
  const token = core.getInput("github-token");
  const resultsPattern = core.getInput("results");
  const monitorPath = core.getInput("monitor-results");
  const commitResults = core.getBooleanInput("commit-results");
  const includeSummary = core.getBooleanInput("summary");
  const customRunId = core.getInput("run-id");

  const runId = buildRunId({
    ...(customRunId ? { customRunId } : {}),
    ...(process.env.GITHUB_RUN_ID ? { githubRunId: process.env.GITHUB_RUN_ID } : {}),
    ...(process.env.GITHUB_RUN_ATTEMPT ? { githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT } : {}),
    ...(process.env.GITHUB_JOB ? { githubJob: process.env.GITHUB_JOB } : {}),
  });

  let sourceName = "";
  let sourceContent = "";
  if (mode === "auto") {
    if (!token) {
      throw new Error("github-token is required when mode=auto.");
    }
    sourceName = `run-${process.env.GITHUB_RUN_ID ?? "unknown"}-logs`;
    sourceContent = await readCurrentRunLogs(token);
  } else {
    if (!resultsPattern) {
      throw new Error("results is required when mode=file.");
    }
    const fileSource = await readFileModeContent(resultsPattern);
    sourceName = fileSource.sourceName;
    sourceContent = fileSource.content;
  }

  const parsed = parseToOtlpDocument(sourceContent, format, {
    runId,
    ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
    ...(process.env.GITHUB_REF ? { ref: process.env.GITHUB_REF } : {}),
    ...(process.env.GITHUB_WORKFLOW ? { workflow: process.env.GITHUB_WORKFLOW } : {}),
    ...(process.env.GITHUB_JOB ? { job: process.env.GITHUB_JOB } : {}),
    ...(process.env.GITHUB_RUN_ATTEMPT ? { runAttempt: process.env.GITHUB_RUN_ATTEMPT } : {}),
    ...(process.env.RUNNER_OS
      ? {
          runner: `${process.env.RUNNER_OS}/${process.env.RUNNER_ARCH ?? "unknown"}`,
        }
      : {}),
  });

  const merged = mergeOtlpDocuments(
    parsed,
    monitorPath ? readMonitorDocument(monitorPath) : undefined
  );

  const dataPoints = countDataPoints(merged);
  if (dataPoints === 0) {
    core.warning(
      `Parsed 0 datapoints from ${sourceName}. Confirm your format (${format}) and log/file content.`
    );
  }

  const tempPath = createTempResultPath(runId);
  writeResultFile(merged, tempPath);

  let outputPath = tempPath;
  if (commitResults) {
    if (!token) {
      throw new Error("github-token is required when commit-results=true.");
    }
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    outputPath = stashResult({
      workspace,
      token,
      dataBranch,
      runId,
      document: merged,
    });
  } else {
    core.info("commit-results=false, skipping stash push.");
  }

  if (includeSummary) {
    await core.summary
      .addRaw(
        summaryMarkdown({
          runId,
          mode,
          format,
          dataPoints,
          filePath: outputPath,
        }),
        true
      )
      .write();
  }

  core.setOutput("run-id", runId);
  core.setOutput("file-path", outputPath);
  core.setOutput("source", mode);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
