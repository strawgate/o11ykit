/**
 * Customizable label/text strings for Dashboard components.
 *
 * Every property has a sensible default in `defaultDashboardLabels`.
 * Users can override individual strings via a partial `DashboardLabels` object.
 */
export interface DashboardLabels {
  // Hero / header
  brand: string;
  heroTitle: string;
  metricsKpi: string;
  runsKpi: string;
  seriesKpi: string;
  monitorKpi: string;

  // Loading / error / empty states
  loadingTitle: string;
  loadingBody: string;
  errorTitle: string;
  emptyTitle: string;
  emptyBody: string;

  // Toolbar
  viewLabel: string;
  overviewButton: string;
  metricsLabel: string;

  // Overview grid
  primaryMetricsTitle: string;
  metricLoadHint: string;
  loadErrorBadge: string;

  // Metric card
  winnerPrefix: string;
  regressionBadge: string;

  // Metric detail view
  backButton: string;
  trendSummary: string;
  leaderboardTitle: string;
  leaderboardDescription: string;

  // Run table
  recentRunsTitle: string;
  recentRunsDescription: string;
  runColumn: string;
  timeColumn: string;
  commitColumn: string;
  refColumn: string;
  benchmarksColumn: string;
  metricsColumn: string;

  // Monitor section
  monitorTitle: string;
  monitorDescription: string;

  // Trend chart
  noSeriesTitle: string;
  noSeriesHint: string;
}

export const defaultDashboardLabels: DashboardLabels = {
  brand: "Benchkit dashboard",
  heroTitle: "Performance overview",
  metricsKpi: "Metrics",
  runsKpi: "Runs",
  seriesKpi: "Series",
  monitorKpi: "Monitor",

  loadingTitle: "Loading benchmark dashboard",
  loadingBody: "Fetching benchmark index and metric series for the latest runs.",
  errorTitle: "Could not load benchmark data",
  emptyTitle: "No benchmark data found",
  emptyBody: "This dashboard needs an aggregated `data/index.json` and metric series files.",

  viewLabel: "View",
  overviewButton: "Overview",
  metricsLabel: "Metrics",

  primaryMetricsTitle: "Primary metrics",
  metricLoadHint: "This metric could not be loaded.",
  loadErrorBadge: "Load error",

  winnerPrefix: "Winner:",
  regressionBadge: "Regression detected",

  backButton: "Back to overview",
  trendSummary: "Time trend across the currently visible series.",
  leaderboardTitle: "Leaderboard",
  leaderboardDescription: "Fastest or best-performing series at the latest run.",

  recentRunsTitle: "Recent runs",
  recentRunsDescription: "Commit context and captured metric coverage for the latest benchmark executions.",
  runColumn: "Run",
  timeColumn: "Time",
  commitColumn: "Commit",
  refColumn: "Ref",
  benchmarksColumn: "Benchmarks",
  metricsColumn: "Metrics",

  monitorTitle: "Runner metrics",
  monitorDescription: "Host and process telemetry from the Benchkit monitor action, kept visually secondary to the benchmark results.",

  noSeriesTitle: "No series to display.",
  noSeriesHint: "Try clearing filters or widening the selected metric.",
};

/** Merge a partial labels override with the defaults. */
export function resolveLabels(overrides?: Partial<DashboardLabels>): DashboardLabels {
  if (!overrides) return defaultDashboardLabels;
  return { ...defaultDashboardLabels, ...overrides };
}
