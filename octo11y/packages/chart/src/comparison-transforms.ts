import type { Sample } from "@benchkit/format";
import type { DataPoint } from "@octo11y/core";

/**
 * Converts an array of intra-run samples to `{x, y}` chart points for a
 * given metric.  The x value is the elapsed time in seconds (`sample.t`).
 *
 * Samples that do not contain the requested metric are skipped.
 */
export function samplesToDataPoints(
  samples: Sample[],
  metric: string,
): { x: number; y: number }[] {
  return samples
    .filter((s) => metric in s)
    .map((s) => ({ x: s.t, y: s[metric] }));
}

/**
 * Converts an array of aggregated `DataPoint` entries to `{x, y}` chart
 * points where x is the ISO-8601 timestamp string consumed by Chart.js's
 * time scale.
 */
export function dataPointsToComparisonData(
  points: DataPoint[],
): { x: string; y: number }[] {
  return points.map((p) => ({ x: p.timestamp, y: p.value }));
}
