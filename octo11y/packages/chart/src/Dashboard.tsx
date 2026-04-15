import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import type { IndexFile, SeriesFile, SeriesEntry, RunEntry } from "@benchkit/format";
import { fetchIndex, fetchSeries, type DataSource } from "./fetch.js";
import { type DashboardLabels, resolveLabels } from "./dashboard-labels.js";
import { HeroSection } from "./components/HeroSection.js";
import { DashboardToolbar } from "./components/DashboardToolbar.js";
import { OverviewGrid } from "./components/OverviewGrid.js";
import { MetricDetailView } from "./components/MetricDetailView.js";
import { RunTable } from "./components/RunTable.js";
import { MonitorSection } from "./components/MonitorSection.js";
import { filterSeriesFile } from "./components/TagFilter.js";
import { presetToDateRange, type DateRangePreset } from "./components/DateRangeFilter.js";
import { type RegressionResult } from "./utils.js";
import { defaultMetricLabel, isMonitorMetric } from "./labels.js";
import { partitionSeriesMap, applyDateRangeToMap, detectAllRegressions } from "./dataset-transforms.js";

export interface DashboardProps {
  source: DataSource;
  class?: string;
  /** Max data points per sparkline (default: 20) */
  maxPoints?: number;
  /** Max run rows in the table (default: 20) */
  maxRuns?: number;
  /** Custom metric label renderer */
  metricLabelFormatter?: (metric: string) => string;
  /** Custom series name renderer */
  seriesNameFormatter?: (name: string, entry: SeriesEntry) => string;
  /** Link commits to GitHub or other VCS */
  commitHref?: (commit: string, run: RunEntry) => string | undefined;
  /** Percentage change that triggers a regression warning (default: 10) */
  regressionThreshold?: number;
  /** Number of preceding data points to average for regression detection (default: 5) */
  regressionWindow?: number;
  /** Override any user-facing label/text string in the dashboard */
  labels?: Partial<DashboardLabels>;
}

type View = "overview" | { metric: string };

export function Dashboard({
  source,
  class: className,
  maxPoints = 20,
  maxRuns = 20,
  metricLabelFormatter,
  seriesNameFormatter,
  commitHref,
  regressionThreshold = 10,
  regressionWindow = 5,
  labels: labelOverrides,
}: DashboardProps) {
  const labels = resolveLabels(labelOverrides);
  const [index, setIndex] = useState<IndexFile | null>(null);
  const [seriesMap, setSeriesMap] = useState<Map<string, SeriesFile>>(new Map());
  const [seriesErrors, setSeriesErrors] = useState<Map<string, string>>(new Map());
  const [view, setView] = useState<View>("overview");
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const [dateRange, setDateRange] = useState<DateRangePreset>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    setError(null);
    fetchIndex(source, signal)
      .then(async (idx) => {
        setIndex(idx);
        if (idx.metrics) {
          const results = await Promise.allSettled(
            idx.metrics.map(async (m) => {
              const s = await fetchSeries(source, m, signal);
              return [m, s] as const;
            }),
          );
          const map = new Map<string, SeriesFile>();
          const errs = new Map<string, string>();
          results.forEach((r, i) => {
            const metric = idx.metrics![i];
            if (r.status === "fulfilled") map.set(metric, r.value[1]);
            else errs.set(metric, String(r.reason));
          });
          setSeriesMap(map);
          setSeriesErrors(errs);
        }
      })
      .catch((err) => {
        if (!signal.aborted) setError(String(err));
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [source.owner, source.repo, source.branch, source.baseUrl]);

  const handleMetricClick = useCallback((metric: string) => {
    setView((v) => (typeof v === "object" && v.metric === metric ? "overview" : { metric }));
  }, []);

  const handleOverview = useCallback(() => setView("overview"), []);

  // Apply date range filter to all series data.
  const dateFilteredSeriesMap = useMemo(
    () => applyDateRangeToMap(seriesMap, presetToDateRange(dateRange)),
    [seriesMap, dateRange],
  );

  const regressionMap = useMemo<Map<string, RegressionResult[]>>(
    () => detectAllRegressions(dateFilteredSeriesMap, regressionThreshold, regressionWindow),
    [dateFilteredSeriesMap, regressionThreshold, regressionWindow],
  );

  const [monitorSeriesMap, userMetrics] = useMemo(
    () => partitionSeriesMap(dateFilteredSeriesMap, isMonitorMetric),
    [dateFilteredSeriesMap],
  );

  const rootClassName = ["bk-dashboard", className].filter(Boolean).join(" ");
  const formatMetric = metricLabelFormatter ?? defaultMetricLabel;

  if (loading) {
    return (
      <div class={rootClassName}>
        <div class="bk-loading">
          <h2 class="bk-loading__title">{labels.loadingTitle}</h2>
          <p class="bk-loading__body">{labels.loadingBody}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class={rootClassName}>
        <div class="bk-state">
          <h2 class="bk-state__title">{labels.errorTitle}</h2>
          <p class="bk-state__body">{error}</p>
        </div>
      </div>
    );
  }

  if (!index) {
    return (
      <div class={rootClassName}>
        <div class="bk-state">
          <h2 class="bk-state__title">{labels.emptyTitle}</h2>
          <p class="bk-state__body">{labels.emptyBody}</p>
        </div>
      </div>
    );
  }

  const userMetricNames = (index.metrics ?? []).filter((m) => !isMonitorMetric(m));

  const selectedMetric = typeof view === "object" ? view.metric : null;
  const selectedSeries = selectedMetric ? dateFilteredSeriesMap.get(selectedMetric) : null;
  const selectedMetricError = selectedMetric ? (seriesErrors.get(selectedMetric) ?? null) : null;

  const visibleSeriesCount = [...userMetrics.values()].reduce(
    (sum, sf) => sum + Object.keys(filterSeriesFile(sf, activeFilters).series).length,
    0,
  );

  return (
    <div class={rootClassName}>
      <div class="bk-shell">
        <HeroSection
          userMetricCount={userMetricNames.length}
          runCount={index.runs.length}
          visibleSeriesCount={visibleSeriesCount}
          monitorMetricCount={monitorSeriesMap.size}
          latestRun={index.runs[0]}
          labels={labels}
        />

        <DashboardToolbar
          metricNames={userMetricNames}
          selectedMetric={selectedMetric}
          userSeriesMap={userMetrics}
          activeFilters={activeFilters}
          dateRange={dateRange}
          formatMetric={formatMetric}
          onMetricClick={handleMetricClick}
          onOverview={handleOverview}
          onFilterChange={setActiveFilters}
          onDateRangeChange={setDateRange}
          labels={labels}
        />

        {selectedMetricError ? (
          <div class="bk-state">
            <h2 class="bk-state__title">Could not load {selectedMetric ? formatMetric(selectedMetric) : "metric"}</h2>
            <p class="bk-state__body">{selectedMetricError}</p>
          </div>
        ) : selectedSeries ? (
          <MetricDetailView
            seriesFile={selectedSeries}
            activeFilters={activeFilters}
            regressions={regressionMap.get(selectedMetric!) ?? []}
            maxPoints={maxPoints}
            formatMetric={formatMetric}
            seriesNameFormatter={seriesNameFormatter}
            onBack={handleOverview}
            labels={labels}
          />
        ) : (
          <OverviewGrid
            metricNames={userMetricNames}
            seriesMap={dateFilteredSeriesMap}
            seriesErrors={seriesErrors}
            activeFilters={activeFilters}
            regressionMap={regressionMap}
            maxPoints={maxPoints}
            formatMetric={formatMetric}
            seriesNameFormatter={seriesNameFormatter}
            onMetricClick={handleMetricClick}
            labels={labels}
          />
        )}

        {!selectedSeries && (
          <MonitorSection
            monitorSeriesMap={monitorSeriesMap}
            index={index}
            maxPoints={maxPoints}
            metricLabelFormatter={formatMetric}
            seriesNameFormatter={seriesNameFormatter}
            onMetricClick={handleMetricClick}
            labels={labels}
          />
        )}

        <section class="bk-section" aria-labelledby="bk-recent-runs-title">
          <div class="bk-section__header">
            <div>
              <h3 class="bk-section__title" id="bk-recent-runs-title">{labels.recentRunsTitle}</h3>
              <p class="bk-section__description">{labels.recentRunsDescription}</p>
            </div>
          </div>
          <RunTable index={index} maxRows={maxRuns} commitHref={commitHref} labels={labels} />
        </section>
      </div>
    </div>
  );
}

