import type { SeriesFile, SeriesEntry } from "@benchkit/format";
import type { DashboardLabels } from "../dashboard-labels.js";
import { TrendChart } from "./TrendChart.js";
import { filterSeriesFile } from "./TagFilter.js";
import { getWinner } from "../leaderboard.js";
import { regressionTooltip, type RegressionResult } from "../utils.js";

export interface MetricCardProps {
  metric: string;
  seriesFile: SeriesFile;
  activeFilters: Record<string, string>;
  regressions: RegressionResult[];
  maxPoints: number;
  formatMetric: (metric: string) => string;
  seriesNameFormatter?: (name: string, entry: SeriesEntry) => string;
  onClick: (metric: string) => void;
  labels: DashboardLabels;
}

export function MetricCard({
  metric,
  seriesFile,
  activeFilters,
  regressions,
  maxPoints,
  formatMetric,
  seriesNameFormatter,
  onClick,
  labels,
}: MetricCardProps) {
  const filteredSeries = filterSeriesFile(seriesFile, activeFilters);
  const visibleEntries = Object.keys(filteredSeries.series);
  const isCompetitive = visibleEntries.length > 1;
  const winnerName = isCompetitive ? getWinner(filteredSeries) : undefined;
  const winnerLabel = winnerName
    ? (seriesNameFormatter ? seriesNameFormatter(winnerName, filteredSeries.series[winnerName]) : winnerName)
    : undefined;
  const hasRegression = regressions.length > 0;
  const tooltipText = hasRegression
    ? regressions.map((r) => regressionTooltip(metric, r, formatMetric)).join("\n")
    : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      class="bk-card bk-card--interactive"
      onClick={() => onClick(metric)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(metric);
        }
      }}
      title={tooltipText}
      aria-label={`View ${formatMetric(metric)} metric`}
    >
      <div class="bk-card__top">
        <div>
          <h4 class="bk-card__title">{formatMetric(metric)}</h4>
        </div>
        <span class="bk-badge bk-badge--muted">{visibleEntries.length} series</span>
      </div>
      <div class="bk-badge-row">
        {winnerLabel && <span class="bk-badge bk-badge--success">{labels.winnerPrefix} {winnerLabel}</span>}
        {hasRegression && <span class="bk-badge bk-badge--danger">{labels.regressionBadge}</span>}
      </div>
      <TrendChart
        series={filteredSeries}
        height={152}
        maxPoints={maxPoints}
        seriesNameFormatter={seriesNameFormatter}
        compact={true}
        showLegend={false}
        showSeriesCount={false}
        regressions={regressions}
      />
    </div>
  );
}
