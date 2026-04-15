import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseBenchmarks as parse,
  MetricsBatch,
  type Format,
} from "@benchkit/format";
import type { OtlpMetricsDocument } from "@octo11y/core";

export interface StashContext {
  commit?: string;
  ref?: string;
  timestamp: string;
  runner?: string;
}

export interface BuildResultOptions {
  benchmarkDoc?: OtlpMetricsDocument;
  monitorDoc?: OtlpMetricsDocument;
  metricsDirDoc?: OtlpMetricsDocument;
  context: StashContext;
}

export interface SummaryOptions {
  runId: string;
}

/** Assemble an OtlpMetricsDocument from parsed benchmarks, optional monitor data, and CI context. */
export function buildResult(opts: BuildResultOptions): OtlpMetricsDocument {
  const batches: MetricsBatch[] = [];
  if (opts.benchmarkDoc) {
    batches.push(MetricsBatch.fromOtlp(opts.benchmarkDoc));
  }
  if (opts.monitorDoc) {
    batches.push(MetricsBatch.fromOtlp(opts.monitorDoc));
  }
  if (opts.metricsDirDoc) {
    batches.push(MetricsBatch.fromOtlp(opts.metricsDirDoc));
  }
  if (batches.length === 0) {
    throw new Error("No benchmark or monitor metrics were provided to stash.");
  }

  const batch = MetricsBatch.merge(...batches);

  // Override resource context with stash-provided CI context
  const ctx = {
    ...batch.context,
    commit: opts.context.commit ?? batch.context.commit,
    ref: opts.context.ref ?? batch.context.ref,
    runner: opts.context.runner ?? batch.context.runner,
  };
  return MetricsBatch.fromPoints([...batch.points], ctx).toOtlp();
}

/** Parse all benchmark files (synchronous file reads). Throws if the list is empty. */
export function parseBenchmarkFiles(files: string[], format: Format): OtlpMetricsDocument {
  if (files.length === 0) {
    throw new Error("No benchmark result files provided");
  }
  const docs: OtlpMetricsDocument[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    docs.push(parseBenchmarks(content, format, file));
  }
  const batches = docs.map((d) => MetricsBatch.fromOtlp(d));
  return MetricsBatch.merge(...batches).toOtlp();
}

export function getEmptyBenchmarksWarning(doc: OtlpMetricsDocument): string | undefined {
  const batch = MetricsBatch.fromOtlp(doc);
  if (batch.size !== 0) {
    return undefined;
  }
  return (
    "Parsed 0 benchmarks from the provided file(s). The stash will be saved but contains no benchmark data. " +
    "Check that your benchmark output contains parseable results and that the correct format is specified."
  );
}

/**
 * Parse a single benchmark file's content in the given format.
 * Throws a descriptive error including the filename if parsing fails.
 */
export function parseBenchmarks(
  content: string,
  format: Format,
  fileName: string,
): OtlpMetricsDocument {
  try {
    return parse(content, format);
  } catch (err) {
    throw new Error(
      `Failed to parse '${path.basename(fileName)}': ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Read and parse a monitor output file (OTLP JSON).
 */
export function readMonitorOutput(monitorPath: string): OtlpMetricsDocument {
  if (!fs.existsSync(monitorPath)) {
    throw new Error(`Monitor file not found: ${monitorPath}`);
  }
  const content = fs.readFileSync(monitorPath, "utf-8");
  const parsed = JSON.parse(content);

  if (!parsed.resourceMetrics) {
    throw new Error(`Monitor file is not valid OTLP JSON: ${monitorPath}`);
  }

  return parsed as OtlpMetricsDocument;
}

/**
 * Read all *.otlp.json files in a metrics directory and merge them.
 */
export function readMetricsDir(metricsDir: string): OtlpMetricsDocument | undefined {
  if (!fs.existsSync(metricsDir)) {
    throw new Error(`Metrics directory not found: ${metricsDir}`);
  }
  const stat = fs.statSync(metricsDir);
  if (!stat.isDirectory()) {
    throw new Error(`Metrics path is not a directory: ${metricsDir}`);
  }

  const files = fs
    .readdirSync(metricsDir)
    .filter((name) => name.endsWith(".otlp.json"))
    .sort()
    .map((name) => path.join(metricsDir, name));

  if (files.length === 0) {
    return undefined;
  }

  const docs: OtlpMetricsDocument[] = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as OtlpMetricsDocument;
    if (!Array.isArray(parsed.resourceMetrics)) {
      throw new Error(`Metrics file is not valid OTLP JSON: ${file}`);
    }
    docs.push(parsed);
  }

  return MetricsBatch.merge(...docs.map((doc) => MetricsBatch.fromOtlp(doc))).toOtlp();
}

/**
 * Build a collision-resistant run identifier.
 *
 * Priority:
 * 1. `customRunId` — use as-is when explicitly provided.
 * 2. `{githubRunId}-{githubRunAttempt}--{sanitized(githubJob)}` — when a job
 *    name is available, append it (separated by `--`) so that multiple jobs
 *    within the same workflow run do not overwrite each other's raw data.
 * 3. `{githubRunId}-{githubRunAttempt}` — fallback when no job name is set.
 *
 * The job segment is lower-cased and any characters outside `[a-z0-9-]` are
 * replaced with `-`, with consecutive dashes collapsed and leading/trailing
 * dashes stripped.
 */
/** Sanitize a runId for safe use as a filename (strip path separators and shell-unsafe chars). */
function sanitizeRunId(raw: string): string {
  return raw.replace(/[/\\:*?"<>|]/g, "_");
}

export function buildRunId(options: {
  customRunId?: string;
  githubRunId?: string;
  githubRunAttempt?: string;
  githubJob?: string;
}): string {
  if (options.customRunId) return sanitizeRunId(options.customRunId);
  const base = `${options.githubRunId ?? "local"}-${options.githubRunAttempt ?? "1"}`;
  if (options.githubJob) {
    const sanitized = options.githubJob
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (sanitized) return `${base}--${sanitized}`;
  }
  return base;
}

export function writeResultFile(result: OtlpMetricsDocument, runId: string, outputPath: string): string {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
  return outputPath;
}

export function createTempResultPath(runId: string): string {
  return path.join(os.tmpdir(), `benchkit-run-${runId}.json`);
}

export function formatResultSummaryMarkdown(result: OtlpMetricsDocument, options: SummaryOptions): string {
  const batch = MetricsBatch.fromOtlp(result);
  // Detect monitor points by scenario name (legacy: _monitor/) or metric name (OTLP: _monitor.)
  const isMonitor = (p: { scenario: string; metric: string }): boolean =>
    p.scenario.startsWith("_monitor/") || p.metric.startsWith("_monitor.");
  const benchmarkPoints = batch.filter((p) => !isMonitor(p));
  const monitorPoints = batch.filter(isMonitor);

  const lines: string[] = [
    `## Benchkit Stash`,
    "",
    `Run ID: \`${options.runId}\``,
  ];

  const ctx = batch.context;
  if (ctx.commit || ctx.ref) {
    const parts = [
      ctx.commit ? `commit \`${ctx.commit.slice(0, 8)}\`` : "",
      ctx.ref ? `ref \`${ctx.ref}\`` : "",
    ].filter(Boolean);
    lines.push(`Parsed for ${parts.join(" on ")}.`);
  }

  lines.push("");

  if (benchmarkPoints.size > 0) {
    lines.push("### Benchmarks");
    lines.push("");
    lines.push("| Benchmark | Metrics |");
    lines.push("| --- | --- |");
    for (const [scenario, scenarioBatch] of benchmarkPoints.groupByScenario()) {
      const metrics = scenarioBatch.points
        .map((p) => {
          const parts = [String(p.value)];
          if (p.unit) parts.push(p.unit);
          return `\`${p.metric}\`: ${parts.join(" ")}`;
        })
        .join("<br>");
      lines.push(`| \`${scenario}\` | ${metrics} |`);
    }
    lines.push("");
  }

  if (monitorPoints.size > 0) {
    lines.push("<details>");
    lines.push("<summary>Monitor metrics</summary>");
    lines.push("");
    lines.push("| Benchmark | Metrics |");
    lines.push("| --- | --- |");
    for (const [scenario, scenarioBatch] of monitorPoints.groupByScenario()) {
      const metrics = scenarioBatch.points
        .map((p) => {
          const parts = [String(p.value)];
          if (p.unit) parts.push(p.unit);
          return `\`${p.metric}\`: ${parts.join(" ")}`;
        })
        .join("<br>");
      lines.push(`| \`${scenario}\` | ${metrics} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}
