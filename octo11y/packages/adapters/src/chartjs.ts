import { SeriesEntry } from '@benchkit/format';
import { detectRegressions, RegressionOptions } from './regression';

/**
 * Chart.js trend chart options.
 */
export interface TrendChartOptions extends RegressionOptions {
  metricName?: string;
  color?: string;
  regressionColor?: string;
  improvementColor?: string;
  pointRadius?: number;
  borderWidth?: number;
  fill?: boolean;
}

/**
 * Chart.js dataset format.
 */
export interface ChartJsDataset {
  label: string;
  data: Array<{ x: string; y: number | null }>;
  borderColor?: string | string[];
  backgroundColor?: string | string[];
  borderWidth?: number;
  pointRadius?: number;
  pointBackgroundColor?: string | string[];
  pointBorderColor?: string | string[];
  fill?: boolean;
  tension?: number;
}

/**
 * Transform a benchkit series entry into a Chart.js trend chart dataset.
 *
 * Includes regression highlighting via point colors.
 */
export function trendChartDataset(
  metricName: string,
  entry: SeriesEntry,
  options: TrendChartOptions = {},
): { labels: string[]; dataset: ChartJsDataset } {
  const {
    color = '#3b82f6',
    regressionColor = '#ef4444',
    improvementColor = '#10b981',
    pointRadius = 4,
    borderWidth = 2,
    fill = false,
    threshold = 10,
    window = 5,
    direction = 'smaller_is_better',
  } = options;

  const pointsWithRegressions = detectRegressions(entry, {
    threshold,
    window,
    direction,
  });

  const labels = pointsWithRegressions.map((p) =>
    new Date(p.timestamp).toISOString().split('T')[0],
  );

  const data = pointsWithRegressions.map((p) => ({
    x: p.timestamp,
    y: p.value ?? null,
  }));

  const pointColors = pointsWithRegressions.map((p) => {
    if (!p.regression) return color;
    return p.regression.isBigger ? regressionColor : improvementColor;
  });

  return {
    labels,
    dataset: {
      label: metricName,
      data,
      borderColor: color,
      pointBackgroundColor: pointColors,
      pointBorderColor: pointColors,
      borderWidth,
      pointRadius,
      fill,
      tension: 0.3,
    },
  };
}

/**
 * Transform two runs into a Chart.js dual-trace comparison dataset.
 *
 * Useful for before/after comparisons (e.g., baseline vs current PR).
 */
export interface ComparisonChartOptions {
  baselineLabel?: string;
  currentLabel?: string;
  baselineColor?: string;
  currentColor?: string;
  pointRadius?: number;
  borderWidth?: number;
}

export function comparisonChartDataset(
  baselineData: Array<{ x: string; y: number }>,
  currentData: Array<{ x: string; y: number }>,
  options: ComparisonChartOptions = {},
): {
  labels: string[];
  datasets: ChartJsDataset[];
} {
  const {
    baselineLabel = 'Baseline',
    currentLabel = 'Current',
    baselineColor = '#9ca3af',
    currentColor = '#3b82f6',
    pointRadius = 3,
    borderWidth = 2,
  } = options;

  const allLabels = new Set<string>();
  baselineData.forEach((p) => allLabels.add(p.x));
  currentData.forEach((p) => allLabels.add(p.x));
  const labels = Array.from(allLabels);

  return {
    labels,
    datasets: [
      {
        label: baselineLabel,
        data: baselineData.map((p) => ({ x: p.x, y: p.y })),
        borderColor: [baselineColor],
        pointBackgroundColor: [baselineColor],
        borderWidth,
        pointRadius,
        tension: 0.3,
        fill: false,
      },
      {
        label: currentLabel,
        data: currentData.map((p) => ({ x: p.x, y: p.y })),
        borderColor: [currentColor],
        pointBackgroundColor: [currentColor],
        borderWidth,
        pointRadius,
        tension: 0.3,
        fill: false,
      },
    ],
  };
}

/**
 * Transform latest metric values into a Chart.js bar chart dataset.
 *
 * Useful for leaderboard-style comparisons.
 */
export interface ComparisonBarOptions {
  color?: string;
  // horizontal?: boolean;  // Reserved for future use
}

export function comparisonBarDataset(
  labels: string[],
  values: number[],
  options: ComparisonBarOptions = {},
): {
  labels: string[];
  dataset: ChartJsDataset;
} {
  const { color = '#3b82f6' } = options;

  return {
    labels,
    dataset: {
      label: 'Value',
      data: values.map((v, i) => ({
        x: labels[i],
        y: v,
      })),
      borderColor: color,
      backgroundColor: `${color}33`,
      borderWidth: 1,
      fill: true,
    },
  };
}
