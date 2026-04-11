import { SeriesEntry, DataPoint } from '@benchkit/format';

/**
 * Regression detection options.
 */
export interface RegressionOptions {
  /** Percentage threshold for regression detection (default: 10) */
  threshold?: number;
  /** Sliding window size for baseline calculation (default: 5) */
  window?: number;
  /** Direction: 'bigger_is_better' or 'smaller_is_better' (default: 'smaller_is_better') */
  direction?: 'bigger_is_better' | 'smaller_is_better';
}

/**
 * Detected regression.
 */
export interface Regression {
  index: number;
  value: number;
  baseline: number;
  percentChange: number;
  isBigger: boolean;
}

/**
 * Data point with regression metadata.
 */
export interface DataPointWithRegression extends DataPoint {
  regression?: Regression;
}

/**
 * Calculate regression detection for a series entry.
 *
 * A regression is detected when a value deviates from the baseline (rolling average)
 * by more than the threshold percentage. Direction determines whether we're looking
 * for increases or decreases.
 */
export function detectRegressions(
  entry: SeriesEntry,
  options: RegressionOptions = {},
): DataPointWithRegression[] {
  const {
    threshold = 10,
    window = 5,
    direction = 'smaller_is_better',
  } = options;

  const points = entry.points;
  if (points.length < 2) return points;

  return points.map((point, index) => {
    if (index < window) {
      return point; // Not enough history for baseline
    }

    // Calculate baseline as average of previous `window` points
    const baseline =
      points
        .slice(index - window, index)
        .reduce((sum: number, p: DataPoint) => sum + p.value, 0) / window;

    const value = point.value;
    const change = ((value - baseline) / baseline) * 100;
    const isBigger = value > baseline;

    // Determine if this is a regression based on direction
    let isRegression = false;
    if (direction === 'smaller_is_better' && isBigger && change >= threshold) {
      isRegression = true; // Metric went up when it should go down
    } else if (
      direction === 'bigger_is_better' &&
      !isBigger &&
      Math.abs(change) >= threshold
    ) {
      isRegression = true; // Metric went down when it should go up
    }

    return {
      ...point,
      regression: isRegression
        ? {
            index,
            value,
            baseline,
            percentChange: change,
            isBigger,
          }
        : undefined,
    };
  });
}

/**
 * Get all regressions from a series entry.
 */
export function getRegressions(
  entry: SeriesEntry,
  options: RegressionOptions = {},
): Regression[] {
  return detectRegressions(entry, options)
    .map((point) => point.regression)
    .filter((r) => r !== undefined) as Regression[];
}

/**
 * Calculate percentage change between two values.
 */
export function percentChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : 100;
  return ((to - from) / Math.abs(from)) * 100;
}
