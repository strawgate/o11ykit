/**
 * Report generator — formats benchmark results as Markdown tables.
 */

import type { StorageResult } from "./measure-storage.js";
import type { BenchQueryResults } from "./query-bench.js";
import type { IngestResult } from "./ingest.js";
import type { BenchConfig } from "./config.js";

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value.toFixed(1)} ${units[exp]}`;
}

export interface FullReport {
  markdown: string;
  json: {
    config: BenchConfig;
    storage: StorageResult[];
    queries: BenchQueryResults[];
    ingest: IngestResult[];
    timestamp: string;
  };
}

export function generateReport(
  config: BenchConfig,
  storageResults: StorageResult[],
  queryResults: BenchQueryResults[],
  ingestResults: IngestResult[],
): FullReport {
  const lines: string[] = [];

  lines.push("# TSDB Benchmark Results");
  lines.push("");
  lines.push(`**Date**: ${new Date().toISOString()}`);
  lines.push("");

  // ── Config summary ──
  lines.push("## Configuration");
  lines.push("");
  lines.push(`| Parameter | Value |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| Series per metric type | ${config.seriesCount} |`);
  lines.push(`| Samples per series | ${config.samplesPerSeries} |`);
  lines.push(`| Sample interval | ${config.sampleIntervalSec}s |`);
  lines.push(`| Metric types | 5 (gauge, sum, histogram, exp_histogram, summary) |`);
  lines.push(`| Total data points | ${config.seriesCount * config.samplesPerSeries * 5} |`);
  lines.push(`| Query iterations | ${config.queryIterations} (+ ${config.queryWarmup} warmup) |`);
  lines.push("");

  // ── Ingest summary ──
  lines.push("## Ingestion Summary");
  lines.push("");
  lines.push("| TSDB | Requests | Success | Duration |");
  lines.push("|------|----------|---------|----------|");
  for (const r of ingestResults) {
    lines.push(
      `| ${pad(r.target, 20)} | ${r.totalRequests} | ${r.successCount}/${r.totalRequests} | ${(r.durationMs / 1000).toFixed(1)}s |`
    );
  }
  lines.push("");

  // ── Storage comparison ──
  lines.push("## Storage Efficiency");
  lines.push("");
  lines.push("| TSDB | Disk Usage | Series Count | Bytes/Series |");
  lines.push("|------|-----------|--------------|-------------|");
  for (const r of storageResults) {
    const seriesCount = Number(r.internalMetrics.series_count ?? 0);
    const bytesPerSeries = seriesCount > 0 ? Math.round(r.diskBytes / seriesCount) : 0;
    lines.push(
      `| ${pad(r.target, 20)} | ${pad(r.diskHuman, 10)} | ${seriesCount || "N/A"} | ${bytesPerSeries ? fmtBytes(bytesPerSeries) : "N/A"} |`
    );
  }
  lines.push("");

  // Storage breakdown
  lines.push("### Storage Breakdown");
  lines.push("");
  for (const r of storageResults) {
    lines.push(`#### ${r.target}`);
    lines.push("");
    lines.push("| Directory | Size |");
    lines.push("|-----------|------|");
    const entries = Object.entries(r.breakdown).sort(([, a], [, b]) => b - a);
    for (const [dir, bytes] of entries) {
      lines.push(`| ${dir} | ${fmtBytes(bytes)} |`);
    }
    lines.push("");
  }

  // ── Query performance ──
  lines.push("## Query Performance");
  lines.push("");

  // Build a comparison table: queries × targets
  const targetNames = queryResults.map((r) => r.target);

  // Header
  const header = ["| Query |", ...targetNames.map((t) => ` ${t} p50 |`), ...targetNames.map((t) => ` ${t} p95 |`)];
  lines.push(header.join(""));
  lines.push(
    "|" + "-------|".repeat(1 + targetNames.length * 2)
  );

  // Get all query names from first target
  const queryNames = queryResults[0]?.queries.map((q) => q.query) ?? [];

  for (const qName of queryNames) {
    const row = [`| ${pad(qName, 22)} |`];
    // p50 columns
    for (const targetResult of queryResults) {
      const q = targetResult.queries.find((q) => q.query === qName);
      row.push(` ${q ? fmtMs(q.p50) : "N/A"} |`);
    }
    // p95 columns
    for (const targetResult of queryResults) {
      const q = targetResult.queries.find((q) => q.query === qName);
      row.push(` ${q ? fmtMs(q.p95) : "N/A"} |`);
    }
    lines.push(row.join(""));
  }
  lines.push("");

  // Detailed per-query breakdown
  lines.push("### Detailed Query Latencies");
  lines.push("");
  for (const qName of queryNames) {
    lines.push(`#### ${qName}`);
    lines.push("");
    lines.push("| TSDB | Min | p50 | p95 | p99 | Max | Mean | Series |");
    lines.push("|------|-----|-----|-----|-----|-----|------|--------|");
    for (const targetResult of queryResults) {
      const q = targetResult.queries.find((q) => q.query === qName);
      if (!q) continue;
      lines.push(
        `| ${pad(targetResult.target, 20)} | ${fmtMs(q.min)} | ${fmtMs(q.p50)} | ${fmtMs(q.p95)} | ${fmtMs(q.p99)} | ${fmtMs(q.max)} | ${fmtMs(q.mean)} | ${q.seriesCount} |`
      );
    }
    lines.push("");
  }

  const markdown = lines.join("\n");

  const json = {
    config,
    storage: storageResults,
    queries: queryResults,
    ingest: ingestResults,
    timestamp: new Date().toISOString(),
  };

  return { markdown, json };
}
