import { useMemo } from "preact/hooks";
import { formatValue } from "../format-utils.js";
import {
  sharedTooltipStyle,
  layoutPadding,
  baseLineOptions,
  yAxisConfig,
  linearXAxis,
} from "../chart-config.js";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import type { Sample } from "@benchkit/format";
import { COLORS } from "../colors.js";
import { useChartLifecycle } from "../hooks/useChartLifecycle.js";
import { extractSampleMetrics } from "../sample-utils.js";

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend);

export interface SampleChartProps {
  /** Intra-run time-series data points. */
  samples: Sample[];
  /** Metric keys to plot. Defaults to all keys found in the samples. */
  metrics?: string[];
  height?: number;
  title?: string;
  subtitle?: string;
  /** Compact "sparkline" mode for embedding in summary cards. */
  compact?: boolean;
  /** Stroke width for trend lines. */
  lineWidth?: number;
  /** Custom label for a metric key. */
  metricLabelFormatter?: (metric: string) => string;
  showLegend?: boolean;
  /** CSS class name */
  class?: string;
}

export function SampleChart({
  samples,
  metrics,
  height = 300,
  title,
  subtitle,
  compact = false,
  lineWidth,
  metricLabelFormatter,
  showLegend = true,
  class: className,
}: SampleChartProps) {
  const resolvedMetrics = useMemo(() => {
    if (metrics && metrics.length > 0) return metrics;
    return extractSampleMetrics(samples);
  }, [samples, metrics]);

  const datasets = useMemo<ChartData<"line">["datasets"]>(() => {
    return resolvedMetrics.map((metric, idx) => {
      const color = COLORS[idx % COLORS.length];
      const label = metricLabelFormatter ? metricLabelFormatter(metric) : metric;
      return {
        label,
        data: samples.map((s) => ({ x: s.t, y: s[metric] ?? null })),
        borderColor: color,
        backgroundColor: `${color}22`,
        fill: resolvedMetrics.length === 1,
        tension: 0,
        borderWidth: lineWidth ?? (compact ? 1.5 : 1.75),
        clip: 8,
        spanGaps: true,
        pointRadius: compact ? 1.75 : 2.5,
        pointHoverRadius: compact ? 4 : 6,
        pointBackgroundColor: color,
        pointBorderColor: color,
      };
    });
  }, [resolvedMetrics, samples, metricLabelFormatter, compact, lineWidth]);

  const { canvasRef, wrapperRef } = useChartLifecycle<"line">(
    (theme) => {
      if (datasets.length === 0 || samples.length === 0) return null;

      const options: ChartOptions<"line"> = {
        ...baseLineOptions(),
        layout: { padding: layoutPadding(compact) },
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...sharedTooltipStyle(theme),
            callbacks: {
              title: (items) => `t = ${items[0]?.label ?? ""}s`,
            },
          },
        },
        scales: {
          x: linearXAxis(theme, {
            title: "Elapsed time (s)",
            showTitle: !compact,
            maxTicksLimit: compact ? 4 : 7,
            tickCallback: (value) => `${value}s`,
          }),
          y: yAxisConfig(theme, {
            showTitle: !compact && resolvedMetrics.length === 1,
            title: resolvedMetrics[0] ?? "",
            maxTicksLimit: compact ? 4 : 6,
            tickCallback: (value) => formatValue(Number(value), compact),
          }),
        },
      };

      return { type: "line" as const, data: { datasets }, options };
    },
    [compact, datasets, samples.length, resolvedMetrics],
  );

  const isEmpty = samples.length === 0 || resolvedMetrics.length === 0;

  return (
    <div ref={wrapperRef} class={["bk-chart-panel", className].filter(Boolean).join(" ")}>
      {(title || subtitle) && (
        <div class="bk-chart-panel__header">
          <div>
            {title && <h3 class="bk-chart-panel__title">{title}</h3>}
            {subtitle && <p class="bk-chart-panel__subtitle">{subtitle}</p>}
          </div>
        </div>
      )}

      {showLegend && !compact && resolvedMetrics.length > 1 && (
        <div class="bk-chart-legend">
          {resolvedMetrics.map((metric, idx) => {
            const color = COLORS[idx % COLORS.length];
            const label = metricLabelFormatter ? metricLabelFormatter(metric) : metric;
            return (
              <span key={metric} class="bk-chart-legend__item" title={label}>
                <span class="bk-chart-legend__swatch" style={{ background: color }} />
                <span class="bk-chart-legend__label">{label}</span>
              </span>
            );
          })}
        </div>
      )}

      <div class="bk-chart-panel__canvas" style={{ height: `${height}px` }}>
        {isEmpty ? (
          <div class="bk-chart-panel__empty">
            <div>
              <strong>No sample data.</strong>
              <div>No intra-run time-series samples are available for this benchmark.</div>
            </div>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={title ?? "Sample chart"}
          >
            {title ?? "Sample chart"}
          </canvas>
        )}
      </div>
    </div>
  );
}
