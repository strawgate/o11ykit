import type { RunEntry } from "@benchkit/format";
import type { DashboardLabels } from "../dashboard-labels.js";
import { formatRef } from "../format-utils.js";

export interface HeroSectionProps {
  userMetricCount: number;
  runCount: number;
  visibleSeriesCount: number;
  monitorMetricCount: number;
  latestRun: RunEntry | undefined;
  labels: DashboardLabels;
}

export function HeroSection({
  userMetricCount,
  runCount,
  visibleSeriesCount,
  monitorMetricCount,
  latestRun,
  labels,
}: HeroSectionProps) {
  return (
    <section class="bk-hero bk-hero--compact">
      <div class="bk-hero__header bk-hero__header--compact">
        <div>
          <p class="bk-hero__eyebrow">{labels.brand}</p>
          <h2 class="bk-hero__title bk-hero__title--compact">{labels.heroTitle}</h2>
        </div>
        <div class="bk-kpis bk-kpis--compact">
          <div class="bk-kpi">
            <span class="bk-kpi__label">{labels.metricsKpi}</span>
            <span class="bk-kpi__value">{userMetricCount}</span>
          </div>
          <div class="bk-kpi">
            <span class="bk-kpi__label">{labels.runsKpi}</span>
            <span class="bk-kpi__value">{runCount}</span>
          </div>
          <div class="bk-kpi">
            <span class="bk-kpi__label">{labels.seriesKpi}</span>
            <span class="bk-kpi__value">{visibleSeriesCount}</span>
          </div>
          <div class="bk-kpi">
            <span class="bk-kpi__label">{labels.monitorKpi}</span>
            <span class="bk-kpi__value">{monitorMetricCount}</span>
          </div>
        </div>
      </div>
      {latestRun && (
        <p class="bk-hero__body">
          Latest run: <strong>{latestRun.id}</strong>
          {latestRun.ref ? ` on ${formatRef(latestRun.ref)}` : ""}
          {latestRun.commit ? ` at ${latestRun.commit.slice(0, 8)}` : ""}.
        </p>
      )}
    </section>
  );
}
