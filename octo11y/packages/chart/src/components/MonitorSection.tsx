import type { SeriesFile, SeriesEntry, IndexFile, MonitorContext } from "@benchkit/format";
import type { DashboardLabels } from "../dashboard-labels.js";
import { TrendChart } from "./TrendChart.js";
import { defaultMonitorMetricLabel } from "../labels.js";

export interface MonitorSectionProps {
  /** Map of _monitor/ prefixed metric names → series files */
  monitorSeriesMap: Map<string, SeriesFile>;
  /** The full index, used to surface the latest runner context */
  index: IndexFile;
  /** Max data points per sparkline */
  maxPoints?: number;
  /** Custom metric label renderer */
  metricLabelFormatter?: (metric: string) => string;
  /** Custom series name renderer */
  seriesNameFormatter?: (name: string, entry: SeriesEntry) => string;
  /** Called when user clicks a monitor metric card */
  onMetricClick?: (metric: string) => void;
  /** Currently selected metric (for highlighting) */
  selectedMetric?: string | null;
  labels?: DashboardLabels;
}

function RunnerContextCard({ ctx }: { ctx: MonitorContext }) {
  const items: Array<[string, string]> = [];

  if (ctx.runner_os) items.push(["OS", ctx.runner_arch ? `${ctx.runner_os} (${ctx.runner_arch})` : ctx.runner_os]);
  if (ctx.kernel) items.push(["Kernel", ctx.kernel]);
  if (ctx.cpu_model) items.push(["CPU", ctx.cpu_count ? `${ctx.cpu_model} × ${ctx.cpu_count}` : ctx.cpu_model]);
  if (ctx.total_memory_mb !== null && ctx.total_memory_mb !== undefined) items.push(["Memory", `${Math.round(ctx.total_memory_mb / 1024)} GB`]);
  if (ctx.poll_interval_ms) items.push(["Poll interval", `${ctx.poll_interval_ms} ms`]);

  if (items.length === 0) return null;

  return (
    <div class="bk-monitor-context">
      {items.map(([label, value]) => (
        <span key={label} class="bk-monitor-context__item">
          <strong>{label}:</strong> {value}
        </span>
      ))}
    </div>
  );
}

export function MonitorSection({
  monitorSeriesMap,
  index,
  maxPoints = 20,
  metricLabelFormatter,
  seriesNameFormatter,
  onMetricClick,
  selectedMetric,
  labels,
}: MonitorSectionProps) {
  if (monitorSeriesMap.size === 0) return null;

  // Find the most recent run that has a monitor context
  const latestMonitorContext = index.runs.find((r) => r.monitor)?.monitor ?? null;

  // Strip the _monitor/ prefix for display unless the formatter handles it
  const displayLabel = (metric: string) => {
    if (metricLabelFormatter) return metricLabelFormatter(metric);
    return defaultMonitorMetricLabel(metric);
  };

  return (
    <section class="bk-section">
      <div class="bk-section__header">
        <div>
          <h3 class="bk-section__title">{labels?.monitorTitle ?? "Runner metrics"}</h3>
          <p class="bk-section__description">
            {labels?.monitorDescription ?? "Host and process telemetry from the Benchkit monitor action, kept visually secondary to the benchmark results."}
          </p>
        </div>
      </div>

      {latestMonitorContext && <RunnerContextCard ctx={latestMonitorContext} />}

      <div class="bk-monitor-grid">
        {[...monitorSeriesMap.entries()].map(([metric, sf]) => (
          <div
            key={metric}
            role="button"
            tabIndex={0}
            onClick={() => onMetricClick?.(metric)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onMetricClick?.(metric);
              }
            }}
            class={`bk-card bk-card--interactive ${selectedMetric === metric ? "bk-card--selected" : ""}`}
            aria-label={`View ${displayLabel(metric)} metric`}
            aria-pressed={selectedMetric === metric}
          >
            <TrendChart
              series={sf}
              title={displayLabel(metric)}
              height={156}
              maxPoints={maxPoints}
              seriesNameFormatter={seriesNameFormatter}
              compact={true}
              showLegend={false}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
