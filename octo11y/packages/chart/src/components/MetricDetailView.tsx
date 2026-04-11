import type { SeriesFile, SeriesEntry } from "@benchkit/format";
import type { DashboardLabels } from "../dashboard-labels.js";
import { TrendChart } from "./TrendChart.js";
import { ComparisonBar } from "./ComparisonBar.js";
import { Leaderboard } from "./Leaderboard.js";
import { filterSeriesFile } from "./TagFilter.js";
import type { RegressionResult } from "../utils.js";

export interface MetricDetailViewProps {
  seriesFile: SeriesFile;
  activeFilters: Record<string, string>;
  regressions: RegressionResult[];
  maxPoints: number;
  formatMetric: (metric: string) => string;
  seriesNameFormatter?: (name: string, entry: SeriesEntry) => string;
  onBack: () => void;
  labels: DashboardLabels;
}

export function MetricDetailView({
  seriesFile,
  activeFilters,
  regressions,
  maxPoints,
  formatMetric,
  seriesNameFormatter,
  onBack,
  labels,
}: MetricDetailViewProps) {
  const filteredSeries = filterSeriesFile(seriesFile, activeFilters);
  const label = formatMetric(seriesFile.metric);

  return (
    <section class="bk-section">
      <div class="bk-section__header">
        <div>
          <h3 class="bk-section__title">{label}</h3>
        </div>
        <button class="bk-link-button" type="button" onClick={onBack}>
          {labels.backButton}
        </button>
      </div>

      <div class="bk-card">
        <TrendChart
          series={filteredSeries}
          title={label}
          summary={labels.trendSummary}
          height={360}
          maxPoints={maxPoints}
          seriesNameFormatter={seriesNameFormatter}
          regressions={regressions}
        />
      </div>

      <div class="bk-overview-grid">
        <div class="bk-card">
          <ComparisonBar
            series={filteredSeries}
            title={`Latest ${label}`}
            height={300}
            seriesNameFormatter={seriesNameFormatter}
            showValuesList={false}
          />
        </div>

        {Object.keys(filteredSeries.series).length > 1 && (
          <div class="bk-card">
            <div class="bk-section__header">
              <div>
                <h4 class="bk-section__title">{labels.leaderboardTitle}</h4>
                <p class="bk-section__description">{labels.leaderboardDescription}</p>
              </div>
            </div>
            <Leaderboard series={filteredSeries} seriesNameFormatter={seriesNameFormatter} />
          </div>
        )}
      </div>
    </section>
  );
}
