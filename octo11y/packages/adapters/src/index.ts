/**
 * Main entry point for @benchkit/adapters.
 *
 * Exports reusable data transforms that work across all charting libraries.
 * Library-specific adapters (Chart.js, ECharts, etc.) are in separate modules.
 */

export type {
  AdapterBaseOptions,
  AdapterChartIntent,
  AdapterTagFilters,
  AxisValueFormatter,
  CoordinatePoint,
  ComparisonCoordinatePoint,
  LatestValueRow,
} from './shared-contract';
export {
  DEFAULT_MAX_POINTS,
  MAX_ALLOWED_POINTS,
  normalizeMaxPoints,
  validateTagFilters,
} from './shared-contract.js';

export {
  alignComparisonCoordinates,
  getLatestValueRows,
  seriesEntryToCoordinates,
} from './coordinate-transforms.js';

export type {
  RechartsComparisonOptions,
  RechartsTrendOptions,
  RechartsComparisonRow,
  RechartsBarRow,
} from './recharts.js';
export {
  trendLineData,
  comparisonLineData,
  comparisonBarData,
} from './recharts.js';

export type {
  EchartsBaseOptions,
  EchartsComparisonOptions,
  EchartsOption,
} from './echarts.js';
export {
  trendLineOption,
  comparisonLineOption,
  comparisonBarOption,
} from './echarts.js';

export type {
  VisxPoint,
  VisxSeries,
  VisxBarDatum,
  VisxTrendOptions,
  VisxComparisonOptions,
} from './visx.js';
export {
  trendLineSeries,
  comparisonLineSeries,
  comparisonBarSeries,
} from './visx.js';

export type { TransformOptions } from './transforms';
export {
  filterMetricsByTags,
  getLatestDataPoint,
  getLatestNPoints,
  getUniqueTags,
  normalizeValues,
} from './transforms';

export type {
  RegressionOptions,
  Regression,
  DataPointWithRegression,
} from './regression';
export { detectRegressions, getRegressions, percentChange } from './regression';
