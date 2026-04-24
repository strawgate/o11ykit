import type {
  CompareConfig,
  ComparisonEntry,
  ComparisonMatrixLane,
  ComparisonMatrixSummary,
  ComparisonResult,
  MatrixDimensionValue,
  MatrixLaneClass,
  MatrixLaneMatcher,
  MatrixMatcherValue,
  MatrixPolicy,
} from "./types.js";
import { inferDirection } from "./infer-direction.js";
import type { MetricsBatch, MetricPoint } from "./metrics-batch.js";

const DEFAULT_CONFIG: CompareConfig = { test: "percentage", threshold: 5 };
const MAX_EXPECTED_LANES = 10_000;

type LaneDimensions = Record<string, string>;

function normalizeDimensionValue(value: MatrixDimensionValue): string {
  return String(value);
}

function normalizeSeriesValue(series: string | undefined, scenario: string): string | undefined {
  if (!series || series === scenario) {
    return undefined;
  }
  return series;
}

function normalizePointTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function formatTagSuffix(tags: Readonly<Record<string, string>>): string {
  const entries = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "";
  }
  return ` [${entries.map(([key, value]) => `${key}=${value}`).join(", ")}]`;
}

function formatPointLane(point: MetricPoint): string {
  const normalizedSeries = normalizeSeriesValue(point.series, point.scenario);
  const seriesPart = normalizedSeries
    ? ` / ${normalizedSeries}`
    : "";
  return `${point.scenario}${seriesPart}${formatTagSuffix(point.tags)}`;
}

function pointComparisonKey(point: MetricPoint): string {
  return JSON.stringify([
    point.scenario,
    normalizeSeriesValue(point.series, point.scenario),
    Object.entries(normalizePointTags(point.tags)),
    point.metric,
  ]);
}

function getPointDimensionValue(point: MetricPoint, dimension: string): string | undefined {
  if (dimension === "scenario" || dimension === "benchmark") {
    return point.scenario;
  }
  if (dimension === "series") {
    return normalizeSeriesValue(point.series, point.scenario);
  }
  return point.tags[dimension];
}

function getEntryDimensionValue(entry: ComparisonEntry, dimension: string): string | undefined {
  if (dimension === "scenario" || dimension === "benchmark") {
    return entry.benchmark;
  }
  if (dimension === "series") {
    return normalizeSeriesValue(entry.series, entry.benchmark);
  }
  return entry.tags?.[dimension];
}

function cartesianDimensions(
  entries: Array<[string, MatrixDimensionValue[]]>,
  index = 0,
  current: LaneDimensions = {},
): LaneDimensions[] {
  if (index >= entries.length) {
    return [{ ...current }];
  }

  const [name, values] = entries[index];
  const lanes: LaneDimensions[] = [];
  for (const value of values) {
    current[name] = normalizeDimensionValue(value);
    lanes.push(...cartesianDimensions(entries, index + 1, current));
  }
  delete current[name];
  return lanes;
}

function validateLaneBudget(entries: Array<[string, MatrixDimensionValue[]]>): void {
  let expectedLaneCount = 1;
  for (const [name, values] of entries) {
    expectedLaneCount *= values.length;
    if (expectedLaneCount > MAX_EXPECTED_LANES) {
      throw new Error(
        `matrix-policy expands to ${expectedLaneCount.toLocaleString("en-US")} lanes after '${name}', exceeding the limit of ${MAX_EXPECTED_LANES.toLocaleString("en-US")}`,
      );
    }
  }
}

function toNumber(value: string): number | null {
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    return null;
  }
  return Number(value);
}

function matchesMatcherValue(actual: string, matcher: MatrixMatcherValue): boolean {
  if (Array.isArray(matcher)) {
    return matcher.map(normalizeDimensionValue).includes(actual);
  }

  if (typeof matcher !== "object" || matcher === null) {
    return normalizeDimensionValue(matcher) === actual;
  }

  const exact = matcher.eq;
  if (exact !== undefined && normalizeDimensionValue(exact) !== actual) {
    return false;
  }

  const includes = matcher.in;
  if (includes && !includes.map(normalizeDimensionValue).includes(actual)) {
    return false;
  }

  const excludes = matcher.notIn;
  if (excludes && excludes.map(normalizeDimensionValue).includes(actual)) {
    return false;
  }

  const numeric = toNumber(actual);
  if (
    matcher.lt !== undefined
    || matcher.lte !== undefined
    || matcher.gt !== undefined
    || matcher.gte !== undefined
  ) {
    if (numeric === null) {
      return false;
    }
    if (matcher.lt !== undefined && !(numeric < matcher.lt)) {
      return false;
    }
    if (matcher.lte !== undefined && !(numeric <= matcher.lte)) {
      return false;
    }
    if (matcher.gt !== undefined && !(numeric > matcher.gt)) {
      return false;
    }
    if (matcher.gte !== undefined && !(numeric >= matcher.gte)) {
      return false;
    }
  }

  return true;
}

function matchesLane(dimensions: LaneDimensions, matcher: MatrixLaneMatcher): boolean {
  return Object.entries(matcher).every(([dimension, expected]) => {
    const actual = dimensions[dimension];
    if (actual === undefined) {
      return false;
    }
    return matchesMatcherValue(actual, expected);
  });
}

function classifyLane(dimensions: LaneDimensions, policy: MatrixPolicy): MatrixLaneClass {
  if (policy.required?.some((matcher) => matchesLane(dimensions, matcher))) {
    return "required";
  }
  if (policy.probe?.some((matcher) => matchesLane(dimensions, matcher))) {
    return "probe";
  }
  return "required";
}

function formatMatrixLaneLabel(dimensions: LaneDimensions): string {
  return Object.entries(dimensions)
    .map(([dimension, value]) => `${dimension}=${value}`)
    .join(", ");
}

function laneDimensionsKey(dimensions: LaneDimensions): string {
  return JSON.stringify(
    Object.entries(dimensions).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function pointMatrixDimensions(point: MetricPoint, dimensionNames: string[]): LaneDimensions | null {
  const dimensions: LaneDimensions = {};
  for (const name of dimensionNames) {
    const value = getPointDimensionValue(point, name);
    if (value === undefined || value === "") {
      return null;
    }
    dimensions[name] = value;
  }
  return dimensions;
}

function entryMatrixDimensions(entry: ComparisonEntry, dimensionNames: string[]): LaneDimensions | null {
  const dimensions: LaneDimensions = {};
  for (const name of dimensionNames) {
    const value = getEntryDimensionValue(entry, name);
    if (value === undefined || value === "") {
      return null;
    }
    dimensions[name] = value;
  }
  return dimensions;
}

function computeMatrixSummary(
  current: MetricsBatch,
  entries: ComparisonEntry[],
  policy: MatrixPolicy,
): ComparisonMatrixSummary {
  const dimensionEntries = Object.entries(policy.dimensions);
  validateLaneBudget(dimensionEntries);
  const dimensionNames = dimensionEntries.map(([name]) => name);
  const expectedDimensions = cartesianDimensions(dimensionEntries).filter(
    (dimensions) => !policy.excludes?.some((matcher) => matchesLane(dimensions, matcher)),
  );
  const expectedLaneKeys = new Set(expectedDimensions.map((dimensions) => laneDimensionsKey(dimensions)));

  const regressedLaneKeys = new Set(
    entries
      .filter((entry) => entry.status === "regressed")
      .map((entry) => entryMatrixDimensions(entry, dimensionNames))
      .filter((dimensions): dimensions is LaneDimensions => dimensions !== null)
      .map((dimensions) => laneDimensionsKey(dimensions)),
  );

  const observedExpectedLaneKeys = new Set<string>();
  for (const point of current.points) {
    if (point.scenario.startsWith("_monitor/")) {
      continue;
    }

    const dimensions = pointMatrixDimensions(point, dimensionNames);
    if (!dimensions) {
      continue;
    }

    const key = laneDimensionsKey(dimensions);
    if (expectedLaneKeys.has(key)) {
      observedExpectedLaneKeys.add(key);
    }
  }

  const lanes: ComparisonMatrixLane[] = expectedDimensions.map((dimensions) => {
    const key = laneDimensionsKey(dimensions);
    const laneClass = classifyLane(dimensions, policy);
    const observed = observedExpectedLaneKeys.has(key);
    let status: ComparisonMatrixLane["status"];
    if (!observed) {
      status = "missing";
    } else if (regressedLaneKeys.has(key)) {
      status = "failed";
    } else {
      status = "passed";
    }

    return {
      key,
      label: formatMatrixLaneLabel(dimensions),
      dimensions,
      laneClass,
      status,
    };
  });

  lanes.sort((a, b) => a.label.localeCompare(b.label));

  const requiredPassedCount = lanes.filter(
    (lane) => lane.laneClass === "required" && lane.status === "passed",
  ).length;
  const requiredFailedCount = lanes.filter(
    (lane) => lane.laneClass === "required" && lane.status === "failed",
  ).length;
  const probePassedCount = lanes.filter(
    (lane) => lane.laneClass === "probe" && lane.status === "passed",
  ).length;
  const probeFailedCount = lanes.filter(
    (lane) => lane.laneClass === "probe" && lane.status === "failed",
  ).length;
  const missingResultCount = lanes.filter((lane) => lane.status === "missing").length;

  return {
    expectedCount: lanes.length,
    observedCount: observedExpectedLaneKeys.size,
    missingResultCount,
    requiredPassedCount,
    requiredFailedCount,
    probePassedCount,
    probeFailedCount,
    hasRequiredFailure: requiredFailedCount > 0 || lanes.some(
      (lane) => lane.laneClass === "required" && lane.status === "missing",
    ),
    lanes,
  };
}

/**
 * Compare a current benchmark run against one or more baseline runs.
 *
 * Baseline values are averaged across the provided runs. For each lane+metric
 * pair in `current`, the function computes a percentage change and applies the
 * threshold test to classify the result as improved, stable, or regressed.
 *
 * Metrics present in `current` but absent from every baseline are excluded —
 * new metrics have no history to regress against.
 *
 * When a matrix policy is provided, the result also includes completeness and
 * required/probe lane summaries derived from the current run.
 */
export function compareRuns(
  current: MetricsBatch,
  baseline: MetricsBatch[],
  config: CompareConfig = DEFAULT_CONFIG,
): ComparisonResult {
  const baselineMap = new Map<string, { values: number[]; point: MetricPoint }>();
  for (const run of baseline) {
    for (const point of run.points) {
      const key = pointComparisonKey(point);
      let entry = baselineMap.get(key);
      if (!entry) {
        entry = { values: [], point };
        baselineMap.set(key, entry);
      }
      entry.values.push(point.value);
    }
  }

  const entries: ComparisonEntry[] = [];
  const warnings: string[] = [];

  for (const point of current.points) {
    const baselineEntry = baselineMap.get(pointComparisonKey(point));
    if (!baselineEntry || baselineEntry.values.length === 0) {
      continue;
    }

    const baselineAvg =
      baselineEntry.values.reduce((a, b) => a + b, 0) / baselineEntry.values.length;

    if (baselineAvg === 0) {
      warnings.push(
        `Skipped metric '${point.metric}' for benchmark '${formatPointLane(point)}': baseline mean is zero`,
      );
      continue;
    }

    const direction =
      point.direction ?? inferDirection(point.unit || point.metric);

    const rawChange = ((point.value - baselineAvg) / baselineAvg) * 100;

    const isWorse =
      direction === "smaller_is_better" ? rawChange > 0 : rawChange < 0;
    const isBetter =
      direction === "smaller_is_better" ? rawChange < 0 : rawChange > 0;

    const absChange = Math.abs(rawChange);
    let status: ComparisonEntry["status"];
    if (absChange <= config.threshold) {
      status = "stable";
    } else if (isWorse) {
      status = "regressed";
    } else if (isBetter) {
      status = "improved";
    } else {
      status = "stable";
    }

    entries.push({
      benchmark: point.scenario,
      ...(point.series && point.series !== point.scenario ? { series: point.series } : {}),
      ...(Object.keys(point.tags).length > 0 ? { tags: normalizePointTags(point.tags) } : {}),
      lane: formatPointLane(point),
      metric: point.metric,
      unit: point.unit || undefined,
      direction,
      baseline: baselineAvg,
      current: point.value,
      percentChange: Math.round(rawChange * 100) / 100,
      status,
    });
  }

  let matrix: ComparisonMatrixSummary | undefined;
  if (config.matrixPolicy) {
    const dimensionNames = Object.keys(config.matrixPolicy.dimensions);
    matrix = computeMatrixSummary(current, entries, config.matrixPolicy);
    const laneClassByKey = new Map(
      matrix.lanes.map((lane) => [lane.key, lane.laneClass] as const),
    );
    for (const entry of entries) {
      const dimensions = entryMatrixDimensions(entry, dimensionNames);
      if (!dimensions) {
        continue;
      }
      const key = laneDimensionsKey(dimensions);
      const laneClass = laneClassByKey.get(key);
      if (laneClass) {
        entry.laneClass = laneClass;
      }
    }
  }

  return {
    entries,
    hasRegression: entries.some((entry) => entry.status === "regressed"),
    ...(matrix ? { matrix } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
