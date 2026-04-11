import { useMemo } from "preact/hooks";
import { formatValue } from "../format-utils.js";
import { REGRESSION_COLOR, REGRESSION_BORDER_COLOR } from "../colors.js";
import {
  sharedTooltipStyle,
  layoutPadding,
  baseLineOptions,
  yAxisConfig,
  timeXAxis,
} from "../chart-config.js";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Filler,
  type ChartDataset,
  type ChartOptions,
} from "chart.js";
import "chartjs-adapter-date-fns";
import type { SeriesFile, SeriesEntry } from "@benchkit/format";
import { COLORS } from "../colors.js";
import { useChartLifecycle } from "../hooks/useChartLifecycle.js";
import type { RegressionResult } from "../utils.js";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Filler,
);

export interface TrendChartProps {
  series: SeriesFile;
  height?: number;
  title?: string;
  subtitle?: string;
  summary?: string;
  compact?: boolean;
  /** Stroke width for trend lines. Defaults to a thinner metrics-friendly width. */
  lineWidth?: number;
  /** Max points per series to display (default: all) */
  maxPoints?: number;
  /** Custom series name renderer */
  seriesNameFormatter?: (name: string, entry: SeriesEntry) => string;
  showLegend?: boolean;
  showSeriesCount?: boolean;
  /** CSS class name */
  class?: string;
  /** Regression results to highlight on the chart (last data point of each flagged series). */
  regressions?: RegressionResult[];
}

export function TrendChart({
  series,
  height = 300,
  title,
  subtitle,
  summary,
  compact = false,
  lineWidth,
  maxPoints,
  seriesNameFormatter,
  showLegend = true,
  showSeriesCount = true,
  class: className,
  regressions,
}: TrendChartProps) {
  const entries = useMemo(() => {
    return Object.entries(series.series)
      .map(([name, entry], idx) => {
        const points = maxPoints && entry.points.length > maxPoints
          ? entry.points.slice(-maxPoints)
          : entry.points;
        if (points.length === 0) return null;

        return {
          name,
          entry,
          points,
          color: COLORS[idx % COLORS.length],
          label: seriesNameFormatter ? seriesNameFormatter(name, entry) : name,
          isRegressed: regressions?.some((result) => result.seriesName === name) ?? false,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }, [series, maxPoints, seriesNameFormatter, regressions]);

  const { canvasRef, wrapperRef } = useChartLifecycle<"line">(
    (theme) => {
      if (entries.length === 0) return null;

      const resolvedLineWidth = lineWidth ?? (compact ? 1.5 : 1.75);
      const datasets = entries.map((entry) => {
        const lastIdx = entry.points.length - 1;
        return {
          label: entry.label,
          data: entry.points.map((point) => ({ x: point.timestamp, y: point.value })),
          borderColor: entry.color,
          backgroundColor: `${entry.color}22`,
          fill: entries.length === 1,
          tension: 0,
          borderWidth: resolvedLineWidth,
          clip: 8,
          spanGaps: true,
          pointRadius: entry.points.map((_, index) => (entry.isRegressed && index === lastIdx ? (compact ? 4 : 5) : (compact ? 1.75 : 2.5))),
          pointHoverRadius: compact ? 4 : 6,
          pointBackgroundColor: entry.points.map((_, index) => (
            entry.isRegressed && index === lastIdx ? REGRESSION_COLOR : entry.color
          )),
          pointBorderColor: entry.points.map((_, index) => (
            entry.isRegressed && index === lastIdx ? REGRESSION_BORDER_COLOR : entry.color
          )),
        };
      });

      const options: ChartOptions<"line"> = {
        ...baseLineOptions(),
        layout: { padding: layoutPadding(compact) },
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...sharedTooltipStyle(theme),
            callbacks: {
              title: (items) => {
                const ts = items[0]?.label;
                return ts ? new Date(ts).toLocaleString() : "";
              },
              afterLabel: (item) => {
                const seriesEntry = entries[item.datasetIndex];
                if (!seriesEntry) return "";
                const pt = seriesEntry.points[item.dataIndex];
                const parts: string[] = [];
                if (pt?.commit) parts.push(`commit: ${pt.commit.slice(0, 8)}`);
                if (pt?.range !== null && pt?.range !== undefined) parts.push(`± ${pt.range}`);
                return parts.join("\n");
              },
            },
          },
        },
        scales: {
          x: timeXAxis(theme, { maxTicksLimit: compact ? 4 : 7 }),
          y: yAxisConfig(theme, {
            showTitle: !compact,
            title: series.unit ?? series.metric,
            maxTicksLimit: compact ? 4 : 6,
            tickCallback: (value) => formatValue(Number(value), compact),
          }),
        },
      };

      return { type: "line" as const, data: { datasets: datasets as unknown as ChartDataset<"line">[] }, options };
    },
    [compact, entries, lineWidth, series.metric, series.unit],
  );

  return (
    <div ref={wrapperRef} class={["bk-chart-panel", className].filter(Boolean).join(" ")}>
      {(title || subtitle) && (
        <div class="bk-chart-panel__header">
          <div>
            {title && <h3 class="bk-chart-panel__title">{title}</h3>}
            {subtitle && <p class="bk-chart-panel__subtitle">{subtitle}</p>}
            {summary && <p class="bk-chart-panel__summary">{summary}</p>}
          </div>
          {showSeriesCount && (
            <span class="bk-badge bk-badge--muted">
              {entries.length} visible
            </span>
          )}
        </div>
      )}

      {showLegend && entries.length > 1 && (
        <div class="bk-chart-legend">
          {entries.map((entry) => (
            <span key={entry.name} class="bk-chart-legend__item" title={entry.label}>
              <span class="bk-chart-legend__swatch" style={{ background: entry.color }} />
              <span class="bk-chart-legend__label">{entry.label}</span>
            </span>
          ))}
        </div>
      )}

      <div class="bk-chart-panel__canvas" style={{ height: `${height}px` }}>
        {entries.length === 0 ? (
          <div class="bk-chart-panel__empty">
            <div>
              <strong>No series to display.</strong>
              <div>Try clearing filters or widening the selected metric.</div>
            </div>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={title ?? `Trend chart for ${series.metric}`}
          >
            Trend chart for {title ?? series.metric}
          </canvas>
        )}
      </div>
    </div>
  );
}
