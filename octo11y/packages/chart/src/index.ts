// Components
export { TrendChart, type TrendChartProps } from "./components/TrendChart.js";
export { ComparisonChart, type ComparisonChartProps } from "./components/ComparisonChart.js";
export { SampleChart, type SampleChartProps } from "./components/SampleChart.js";
export { ComparisonBar, type ComparisonBarProps } from "./components/ComparisonBar.js";
export { RunTable, type RunTableProps } from "./components/RunTable.js";
export { MonitorSection, type MonitorSectionProps } from "./components/MonitorSection.js";
export { TagFilter, type TagFilterProps, extractTags, filterSeriesFile } from "./components/TagFilter.js";
export { DateRangeFilter, type DateRangeFilterProps, type DateRangePreset, type DateRange, presetToDateRange, filterSeriesFileByDateRange } from "./components/DateRangeFilter.js";
export { Leaderboard, type LeaderboardProps } from "./components/Leaderboard.js";
export { VerdictBanner, type VerdictBannerProps } from "./components/VerdictBanner.js";
export { ComparisonSummaryTable, type ComparisonSummaryTableProps } from "./components/ComparisonSummaryTable.js";
export { RunSelector, type RunSelectorProps } from "./components/RunSelector.js";
export { Dashboard, type DashboardProps } from "./Dashboard.js";
export { RunDashboard, type RunDashboardProps } from "./RunDashboard.js";
export { RunDetail, type RunDetailProps, type MetricSnapshotCardProps, MetricSnapshotCard } from "./RunDetail.js";

// Label customization
export { type DashboardLabels, defaultDashboardLabels, resolveLabels } from "./dashboard-labels.js";

// Shared formatting utilities
export {
  formatValue,
  formatFixedValue,
  formatRef,
  formatPct,
  formatTimestamp,
  shortCommit,
  formatDirection,
} from "./format-utils.js";

// Data fetching
export { fetchIndex, fetchSeries, fetchRun, fetchPrIndex, fetchRefIndex, fetchMetricSummary, fetchRunDetail, compareRuns, type DataSource } from "./fetch.js";

// Ranking utilities
export { rankSeries, getWinner, type RankedEntry } from "./leaderboard.js";
// Hooks
export { useChartLifecycle, type ChartLifecycleResult } from "./hooks/useChartLifecycle.js";
// Utilities
export { detectRegressions, regressionTooltip, type RegressionResult } from "./utils.js";
export { defaultMetricLabel, defaultMonitorMetricLabel, isMonitorMetric } from "./labels.js";
export { samplesToDataPoints, dataPointsToComparisonData } from "./comparison-transforms.js";
export { extractSampleMetrics } from "./sample-utils.js";

// Dataset-local transform layer
export {
  transformSeriesDataset,
  partitionSeriesMap,
  applyDateRangeToMap,
  detectAllRegressions,
  partitionSnapshots,
  type DatasetAggregate,
  type DatasetFilter,
  type TransformSeriesDatasetOptions,
} from "./dataset-transforms.js";

// Embed API (also available via @benchkit/chart/embed)
export { mount, type EmbedOptions, type EmbedMode } from "./embed.js";
