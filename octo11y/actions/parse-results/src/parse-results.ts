import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseBenchmarks as parse,
  MetricsBatch,
  type Format,
} from "@benchkit/format";
import type { OtlpMetricsDocument } from "@octo11y/core";

export type ParseMode = "auto" | "file";

export interface ParseContext {
  commit?: string;
  ref?: string;
  runner?: string;
}

export function resolveMode(input: string): ParseMode {
  if (input === "auto" || input === "file") {
    return input;
  }
  throw new Error(`Invalid mode '${input}'. Expected 'auto' or 'file'.`);
}

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

export function parseBenchmarkContent(
  content: string,
  format: Format,
  sourceName: string,
): OtlpMetricsDocument {
  const strippedAnsi = content.replace(
    // Strip ANSI color/control sequences that commonly appear in workflow logs.
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*[A-Za-z]/g,
    "",
  );
  const normalized = strippedAnsi.replace(
    // Strip the GH Actions timestamp prefix that appears in downloaded logs,
    // e.g. `2026-04-11T17:24:52.7651143Z `.
    /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/gm,
    "",
  );
  try {
    return parse(normalized, format);
  } catch (err) {
    throw new Error(
      `Failed to parse '${sourceName}': ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export function mergeDocuments(
  benchmarkDoc: OtlpMetricsDocument,
  monitorDoc: OtlpMetricsDocument | undefined,
  context: ParseContext,
): OtlpMetricsDocument {
  let batch = MetricsBatch.fromOtlp(benchmarkDoc);
  if (monitorDoc) {
    batch = MetricsBatch.merge(batch, MetricsBatch.fromOtlp(monitorDoc));
  }

  const mergedContext = {
    ...batch.context,
    commit: context.commit ?? batch.context.commit,
    ref: context.ref ?? batch.context.ref,
    runner: context.runner ?? batch.context.runner,
  };
  return MetricsBatch.fromPoints([...batch.points], mergedContext).toOtlp();
}

export function readMonitorOutput(monitorPath: string): OtlpMetricsDocument {
  if (!fs.existsSync(monitorPath)) {
    throw new Error(`Monitor file not found: ${monitorPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(monitorPath, "utf-8"));
  if (!parsed.resourceMetrics) {
    throw new Error(`Monitor file is not valid OTLP JSON: ${monitorPath}`);
  }
  return parsed as OtlpMetricsDocument;
}

export function createTempResultPath(runId: string): string {
  return path.join(os.tmpdir(), `benchkit-parse-results-${runId}.json`);
}

export function writeResultFile(result: OtlpMetricsDocument, outputPath: string): string {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
  return outputPath;
}

export function getEmptyBenchmarksWarning(doc: OtlpMetricsDocument): string | undefined {
  const batch = MetricsBatch.fromOtlp(doc);
  if (batch.size > 0) {
    return undefined;
  }
  return (
    "Parsed 0 benchmarks from the selected source. " +
    "If you used mode=auto, ensure benchmark output is written to step logs in a parseable format."
  );
}

export function formatSummaryMarkdown(result: OtlpMetricsDocument, runId: string, source: ParseMode): string {
  const batch = MetricsBatch.fromOtlp(result);
  const lines: string[] = [
    "## Benchkit Parse Results",
    "",
    `Run ID: \`${runId}\``,
    `Source: \`${source}\``,
    `Metrics parsed: **${batch.size}**`,
  ];
  if (batch.context.commit || batch.context.ref) {
    const parts = [
      batch.context.commit ? `commit \`${batch.context.commit.slice(0, 8)}\`` : "",
      batch.context.ref ? `ref \`${batch.context.ref}\`` : "",
    ].filter(Boolean);
    if (parts.length > 0) {
      lines.push(`Context: ${parts.join(" on ")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
