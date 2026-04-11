import type { SeriesFile } from "@octo11y/core";

/** Describes a detected regression for a single series within a metric. */
export interface RegressionResult {
  /** Series name (key in SeriesFile.series). */
  seriesName: string;
  /** The latest data-point value. */
  latestValue: number;
  /** Mean of the previous `window` data points. */
  previousMean: number;
  /** Percentage change from previousMean to latestValue (positive = increase). */
  percentChange: number;
  /** Number of preceding points that were averaged (may be less than requested window). */
  window: number;
}

/**
 * Detect regressions in a single metric's series file.
 *
 * A regression is defined as:
 *  - For `smaller_is_better`: the latest value increased by more than `threshold`%
 *    relative to the mean of the previous `window` points.
 *  - For `bigger_is_better`: the latest value decreased by more than `threshold`%
 *    relative to the mean of the previous `window` points.
 *
 * Returns an empty array when there are not enough data points (< window + 1).
 *
 * @param series    The series file for a single metric.
 * @param threshold Percentage change that triggers a regression (default: 10).
 * @param window    Number of preceding data points to average (default: 5).
 */
export function detectRegressions(
  series: SeriesFile,
  threshold = 10,
  window = 5,
): RegressionResult[] {
  const direction = series.direction ?? "smaller_is_better";
  const results: RegressionResult[] = [];

  for (const [name, entry] of Object.entries(series.series)) {
    const pts = entry.points;
    // Need at least window + 1 points: window for history, 1 for the latest.
    if (pts.length < window + 1) continue;

    const latest = pts[pts.length - 1];
    const prevPts = pts.slice(-(window + 1), -1);
    const actualWindow = prevPts.length;

    if (actualWindow === 0) continue;

    const sum = prevPts.reduce((acc, p) => acc + p.value, 0);
    const mean = sum / actualWindow;

    // Avoid division by zero.
    if (mean < 1e-10) continue;

    const percentChange = ((latest.value - mean) / mean) * 100;

    const isRegression =
      direction === "smaller_is_better"
        ? percentChange > threshold
        : percentChange < -threshold;

    if (isRegression) {
      results.push({
        seriesName: name,
        latestValue: latest.value,
        previousMean: mean,
        percentChange,
        window: actualWindow,
      });
    }
  }

  return results;
}

/**
 * Build a human-readable regression tooltip string.
 *
 * Example: "ns_per_op increased 15.3% vs 5-run average (320 → 368)"
 */
export function regressionTooltip(
  metric: string,
  r: RegressionResult,
  metricLabelFormatter?: (m: string) => string,
): string {
  const label = metricLabelFormatter ? metricLabelFormatter(metric) : metric;
  const direction = r.percentChange > 0 ? "increased" : "decreased";
  const pct = Math.abs(r.percentChange).toFixed(1);
  const prev = r.previousMean % 1 === 0 ? r.previousMean.toFixed(0) : r.previousMean.toFixed(2);
  const latest = r.latestValue % 1 === 0 ? r.latestValue.toFixed(0) : r.latestValue.toFixed(2);
  return `${label} ${direction} ${pct}% vs ${r.window}-run average (${prev} → ${latest})`;
}
