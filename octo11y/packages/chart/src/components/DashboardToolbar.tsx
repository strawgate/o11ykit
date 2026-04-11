import type { SeriesFile } from "@benchkit/format";
import type { DashboardLabels } from "../dashboard-labels.js";
import { TagFilter, filterSeriesFile } from "./TagFilter.js";
import { DateRangeFilter, type DateRangePreset } from "./DateRangeFilter.js";

export interface DashboardToolbarProps {
  /** All user (non-monitor) metric names */
  metricNames: string[];
  /** Currently focused metric, or null for overview */
  selectedMetric: string | null;
  /** Full user-metric series map (unfiltered) */
  userSeriesMap: Map<string, SeriesFile>;
  activeFilters: Record<string, string>;
  dateRange: DateRangePreset;
  formatMetric: (metric: string) => string;
  onMetricClick: (metric: string) => void;
  onOverview: () => void;
  onFilterChange: (filters: Record<string, string>) => void;
  onDateRangeChange: (preset: DateRangePreset) => void;
  labels: DashboardLabels;
}

export function DashboardToolbar({
  metricNames,
  selectedMetric,
  userSeriesMap,
  activeFilters,
  dateRange,
  formatMetric,
  onMetricClick,
  onOverview,
  onFilterChange,
  onDateRangeChange,
  labels,
}: DashboardToolbarProps) {
  const activeFilterCount = Object.keys(activeFilters).length;
  const totalUserSeriesCount = [...userSeriesMap.values()].reduce(
    (sum, sf) => sum + Object.keys(sf.series).length,
    0,
  );
  const visibleSeriesCount = [...userSeriesMap.values()].reduce(
    (sum, sf) => sum + Object.keys(filterSeriesFile(sf, activeFilters).series).length,
    0,
  );

  const selectedSeries = selectedMetric ? userSeriesMap.get(selectedMetric) : null;
  const focusedSeriesCount = selectedSeries
    ? Object.keys(filterSeriesFile(selectedSeries, activeFilters).series).length
    : 0;

  return (
    <section class="bk-toolbar" aria-label="Dashboard controls">
      <div class="bk-toolbar__row">
        <div class="bk-toolbar__group">
          <span class="bk-toolbar__label">{labels.viewLabel}</span>
          <button class="bk-link-button" type="button" onClick={onOverview}>
            {labels.overviewButton}
          </button>
          {selectedSeries && (
            <span class="bk-badge bk-badge--muted">
              Focused metric: {formatMetric(selectedSeries.metric)}
            </span>
          )}
        </div>
        <div class="bk-toolbar__group">
          {activeFilterCount > 0 && <span class="bk-badge bk-badge--muted">{activeFilterCount} active filters</span>}
          <span class="bk-badge bk-badge--muted">
            {selectedSeries ? `${focusedSeriesCount} visible series` : `${visibleSeriesCount}/${totalUserSeriesCount} visible series`}
          </span>
          <DateRangeFilter value={dateRange} onChange={onDateRangeChange} />
        </div>
      </div>
      <div class="bk-toolbar__row">
        <div class="bk-toolbar__group" role="tablist" aria-label={labels.metricsLabel}>
          <span class="bk-toolbar__label" id="bk-metrics-label">{labels.metricsLabel}</span>
          {metricNames.map((metric) => (
            <button
              key={metric}
              type="button"
              class="bk-tab"
              role="tab"
              aria-selected={selectedMetric === metric}
              onClick={() => onMetricClick(metric)}
            >
              {formatMetric(metric)}
            </button>
          ))}
        </div>
      </div>
      <TagFilter seriesMap={userSeriesMap} activeFilters={activeFilters} onFilterChange={onFilterChange} />
    </section>
  );
}
