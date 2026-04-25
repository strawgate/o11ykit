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

type MatrixDimensionValue = string | number | boolean;

interface MatrixValueMatcher {
  eq?: MatrixDimensionValue;
  in?: MatrixDimensionValue[];
  notIn?: MatrixDimensionValue[];
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
}

type MatrixMatcherValue =
  | MatrixDimensionValue
  | MatrixDimensionValue[]
  | MatrixValueMatcher;

interface MatrixLaneMatcher {
  [dimension: string]: MatrixMatcherValue;
}

interface MatrixPolicy {
  dimensions: Record<string, MatrixDimensionValue[]>;
  excludes?: MatrixLaneMatcher[];
  required?: MatrixLaneMatcher[];
  probe?: MatrixLaneMatcher[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDimensionValue(value: unknown): value is MatrixDimensionValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

const RECOGNIZED_MATCHER_KEYS = new Set(["eq", "in", "notIn", "lt", "lte", "gt", "gte"]);

function validateMatcherValue(listName: string, index: number, dimension: string, value: unknown): void {
  if (isDimensionValue(value)) {
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      if (!isDimensionValue(element)) {
        throw new Error(
          `matrix-policy.${listName}[${index}].${dimension}: array elements must be string, number, or boolean`,
        );
      }
    }
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      throw new Error(
        `matrix-policy.${listName}[${index}].${dimension}: matcher object must have at least one key`,
      );
    }
    for (const key of keys) {
      if (!RECOGNIZED_MATCHER_KEYS.has(key)) {
        throw new Error(
          `matrix-policy.${listName}[${index}].${dimension}: unrecognized matcher key "${key}"`,
        );
      }
    }
    if (value.in !== undefined && !Array.isArray(value.in)) {
      throw new Error(
        `matrix-policy.${listName}[${index}].${dimension}: "in" must be an array`,
      );
    }
    if (value.notIn !== undefined && !Array.isArray(value.notIn)) {
      throw new Error(
        `matrix-policy.${listName}[${index}].${dimension}: "notIn" must be an array`,
      );
    }
    return;
  }
  throw new Error(
    `matrix-policy.${listName}[${index}].${dimension}: value must be a primitive, array, or matcher object`,
  );
}

function validateMatcherList(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((matcher) => !isRecord(matcher))) {
    throw new Error(`matrix-policy.${name} must be an array of matcher objects`);
  }
  for (let i = 0; i < value.length; i++) {
    const matcher = value[i] as Record<string, unknown>;
    for (const [dimension, matcherValue] of Object.entries(matcher)) {
      validateMatcherValue(name, i, dimension, matcherValue);
    }
  }
}

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
  matrixPolicyInput?: string;
  title?: string;
  currentCommit?: string;
  currentRef?: string;
}

export interface CompareOutput {
  markdown: string;
  hasRegression: boolean;
  hasRequiredFailure: boolean;
  missingResultCount: number;
  requiredPassedCount: number;
  requiredFailedCount: number;
  probeFailedCount: number;
  matrixSummaryJson: string;
}

export function parseMatrixPolicyInput(input: string | undefined): MatrixPolicy | undefined {
  if (!input || input.trim() === "") {
    return undefined;
  }

  const trimmed = input.trim();
  const filePath = path.resolve(trimmed);
  const fromFile = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  const payload = fromFile
    ? fs.readFileSync(filePath, "utf-8")
    : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    const source = fromFile ? `file '${filePath}'` : "inline JSON";
    throw new Error(
      `Failed to parse matrix-policy from ${source}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("matrix-policy must be a JSON object");
  }

  const dimensions = parsed.dimensions;
  if (!isRecord(dimensions)) {
    throw new Error("matrix-policy.dimensions must be an object whose values are arrays");
  }

  for (const [name, value] of Object.entries(dimensions)) {
    if (!Array.isArray(value)) {
      throw new Error(`matrix-policy.dimensions.${name} must be an array`);
    }
    if (value.length === 0) {
      throw new Error(`matrix-policy.dimensions.${name} must have at least one element`);
    }
    for (const element of value) {
      if (!isDimensionValue(element)) {
        throw new Error(
          `matrix-policy.dimensions.${name}: each value must be a string, number, or boolean`,
        );
      }
    }
  }

  validateMatcherList("excludes", parsed.excludes);
  validateMatcherList("required", parsed.required);
  validateMatcherList("probe", parsed.probe);

  if (Object.keys(dimensions).length === 0) {
    throw new Error("matrix-policy.dimensions must define at least one dimension");
  }
  return parsed as unknown as MatrixPolicy;
}

export function runComparison(options: CompareOptions): CompareOutput {
  const current = parseCurrentRun(options.files, options.format);
  const baseline = readBaselineRuns(options.runsDir, options.baselineRuns);
  const matrixPolicy = parseMatrixPolicyInput(options.matrixPolicyInput);
  const result = compare(current, baseline, {
    test: "percentage",
    threshold: options.threshold,
    ...(matrixPolicy ? { matrixPolicy } : {}),
  });
  const markdown = formatComparisonMarkdown(result, {
    title: options.title ?? "Benchmark Comparison",
    currentCommit: options.currentCommit,
    currentRef: options.currentRef,
  });
  return {
    markdown,
    hasRegression: result.hasRegression,
    hasRequiredFailure: result.matrix?.hasRequiredFailure ?? false,
    missingResultCount: result.matrix?.missingResultCount ?? 0,
    requiredPassedCount: result.matrix?.requiredPassedCount ?? 0,
    requiredFailedCount: result.matrix?.requiredFailedCount ?? 0,
    probeFailedCount: result.matrix?.probeFailedCount ?? 0,
    matrixSummaryJson: result.matrix ? JSON.stringify(result.matrix) : "",
  };
}
