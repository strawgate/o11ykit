import type { SeriesFile, SeriesEntry } from "@benchkit/format";
import type { DashboardLabels } from "../dashboard-labels.js";
import { MetricCard } from "./MetricCard.js";
import type { RegressionResult } from "../utils.js";

export interface OverviewGridProps {
  metricNames: string[];
  seriesMap: Map<string, SeriesFile>;
  seriesErrors: Map<string, string>;
  activeFilters: Record<string, string>;
  regressionMap: Map<string, RegressionResult[]>;
  maxPoints: number;
  formatMetric: (metric: string) => string;
  seriesNameFormatter?: (name: string, entry: SeriesEntry) => string;
  onMetricClick: (metric: string) => void;
  labels: DashboardLabels;
}

export function OverviewGrid({
  metricNames,
  seriesMap,
  seriesErrors,
  activeFilters,
  regressionMap,
  maxPoints,
  formatMetric,
  seriesNameFormatter,
  onMetricClick,
  labels,
}: OverviewGridProps) {
  return (
    <section class="bk-section">
      <div class="bk-section__header">
        <div>
          <h3 class="bk-section__title">{labels.primaryMetricsTitle}</h3>
        </div>
      </div>
      <div class="bk-overview-grid">
        {metricNames.map((metric) => {
          const metricErr = seriesErrors.get(metric);
          if (metricErr) {
            return (
              <div key={metric} class="bk-card">
                <div class="bk-card__top">
                  <div>
                    <h4 class="bk-card__title">{formatMetric(metric)}</h4>
                    <p class="bk-card__hint">{labels.metricLoadHint}</p>
                  </div>
                  <span class="bk-badge bk-badge--danger">{labels.loadErrorBadge}</span>
                </div>
                <p class="bk-muted">{metricErr}</p>
              </div>
            );
          }

          const sf = seriesMap.get(metric);
          if (!sf) return null;

          return (
            <MetricCard
              key={metric}
              metric={metric}
              seriesFile={sf}
              activeFilters={activeFilters}
              regressions={regressionMap.get(metric) ?? []}
              maxPoints={maxPoints}
              formatMetric={formatMetric}
              seriesNameFormatter={seriesNameFormatter}
              onClick={onMetricClick}
              labels={labels}
            />
          );
        })}
      </div>
    </section>
  );
}
