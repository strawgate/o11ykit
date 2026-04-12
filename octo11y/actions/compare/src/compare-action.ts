import * as fs from "node:fs";
import * as path from "node:path";
import {
  compareRuns as compare,
  formatComparisonMarkdown,
  parseBenchmarks as parse,
  MetricsBatch,
  type Format,
} from "@benchkit/format";
import type { OtlpMetricsDocument } from "@octo11y/core";

export function parseCurrentRun(files: string[], format: Format): MetricsBatch {
  if (files.length === 0) {
    throw new Error("No benchmark result files provided");
  }

  const batches = files.map((file) => {
    const content = fs.readFileSync(file, "utf-8");
    return MetricsBatch.fromOtlp(parse(content, format));
  });

  return MetricsBatch.merge(...batches);
}

export function readBaselineRuns(runsDir: string, maxRuns: number): MetricsBatch[] {
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const files = fs.readdirSync(runsDir)
    .filter((file) => file.endsWith(".json"));

  const baselines = files.map((file) => {
    const content = fs.readFileSync(path.join(runsDir, file), "utf-8");
    const doc = JSON.parse(content) as OtlpMetricsDocument;
    const batch = MetricsBatch.fromOtlp(doc);
    return {
      file,
      batch,
      latestTimestamp: latestTimestampNanos(batch),
    };
  });

  baselines.sort((a, b) => {
    if (a.latestTimestamp === b.latestTimestamp) {
      return b.file.localeCompare(a.file);
    }
    return a.latestTimestamp > b.latestTimestamp ? -1 : 1;
  });

  return baselines
    .slice(0, maxRuns)
    .map((entry) => entry.batch);
}

function latestTimestampNanos(batch: MetricsBatch): bigint {
  let latest = 0n;
  for (const point of batch.points) {
    if (!point.timestamp || !/^\d+$/.test(point.timestamp)) {
      continue;
    }
    const nanos = BigInt(point.timestamp);
    if (nanos > latest) {
      latest = nanos;
    }
  }
  return latest;
}

export interface CompareOptions {
  files: string[];
  format: Format;
  runsDir: string;
  baselineRuns: number;
  threshold: number;
  title?: string;
  currentCommit?: string;
  currentRef?: string;
}

export interface CompareOutput {
  markdown: string;
  hasRegression: boolean;
}

export function runComparison(options: CompareOptions): CompareOutput {
  const current = parseCurrentRun(options.files, options.format);
  const baseline = readBaselineRuns(options.runsDir, options.baselineRuns);
  const result = compare(current, baseline, {
    test: "percentage",
    threshold: options.threshold,
  });
  const markdown = formatComparisonMarkdown(result, {
    title: options.title ?? "Benchmark Comparison",
    currentCommit: options.currentCommit,
    currentRef: options.currentRef,
  });
  return { markdown, hasRegression: result.hasRegression };
}
