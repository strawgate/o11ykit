import type {
  ComparisonEntry,
  ComparisonResult,
  ThresholdConfig,
} from "./types.js";
import { inferDirection } from "./infer-direction.js";
import type { MetricsBatch, MetricPoint } from "./metrics-batch.js";

const DEFAULT_THRESHOLD: ThresholdConfig = { test: "percentage", threshold: 5 };

/**
 * Compare a current benchmark run against one or more baseline runs.
 *
 * Baseline values are averaged across the provided runs. For each
 * scenario+metric pair in `current`, the function computes a percentage
 * change and applies the threshold test to classify the result as
 * improved, stable, or regressed.
 *
 * Metrics present in `current` but absent from every baseline are
 * excluded — new metrics have no history to regress against.
 *
 * @param current - MetricsBatch for the current run.
 * @param baseline - One or more baseline MetricsBatch objects to compare against.
 * @param config - Threshold configuration (default: 5 % percentage).
 * @returns A `ComparisonResult` with per-metric entries and an overall regression flag.
 */
export function compareRuns(
  current: MetricsBatch,
  baseline: MetricsBatch[],
  config: ThresholdConfig = DEFAULT_THRESHOLD,
): ComparisonResult {
  if (baseline.length === 0) {
    return { entries: [], hasRegression: false };
  }

  // Build a lookup: scenario → metric → values[]
  const baselineMap = new Map<string, Map<string, { values: number[]; point: MetricPoint }>>();
  for (const run of baseline) {
    for (const p of run.points) {
      let metricMap = baselineMap.get(p.scenario);
      if (!metricMap) {
        metricMap = new Map();
        baselineMap.set(p.scenario, metricMap);
      }
      let entry = metricMap.get(p.metric);
      if (!entry) {
        entry = { values: [], point: p };
        metricMap.set(p.metric, entry);
      }
      entry.values.push(p.value);
    }
  }

  const entries: ComparisonEntry[] = [];
  const warnings: string[] = [];

  for (const p of current.points) {
    const baselineMetrics = baselineMap.get(p.scenario);
    if (!baselineMetrics) continue;

    const baselineEntry = baselineMetrics.get(p.metric);
    if (!baselineEntry || baselineEntry.values.length === 0) continue;

    const baselineAvg =
      baselineEntry.values.reduce((a, b) => a + b, 0) / baselineEntry.values.length;

    if (baselineAvg === 0) {
      warnings.push(
        `Skipped metric '${p.metric}' for benchmark '${p.scenario}': baseline mean is zero`,
      );
      continue;
    }

    const direction =
      p.direction ?? inferDirection(p.unit || p.metric);

    const rawChange = ((p.value - baselineAvg) / baselineAvg) * 100;

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
      benchmark: p.scenario,
      metric: p.metric,
      unit: p.unit || undefined,
      direction,
      baseline: baselineAvg,
      current: p.value,
      percentChange: Math.round(rawChange * 100) / 100,
      status,
    });
  }

  return {
    entries,
    hasRegression: entries.some((e) => e.status === "regressed"),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
