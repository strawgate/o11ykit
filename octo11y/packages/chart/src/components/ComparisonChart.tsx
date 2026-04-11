import { useMemo } from "preact/hooks";
import { formatValue } from "../format-utils.js";
import { BASE_COLOR, CURRENT_COLOR } from "../colors.js";
import {
  sharedTooltipStyle,
  layoutPadding,
  baseLineOptions,
  yAxisConfig,
  timeXAxis,
  linearXAxis,
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
  type ChartDataset,
  type ChartOptions,
} from "chart.js";
import "chartjs-adapter-date-fns";
import type { Sample, DataPoint } from "@benchkit/format";
import { useChartLifecycle } from "../hooks/useChartLifecycle.js";
import {
  samplesToDataPoints,
  dataPointsToComparisonData,
} from "../comparison-transforms.js";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
);

/** Base (blue) and current/PR (green) — matching the beats-bench convention. */
export interface ComparisonChartProps {
  /** Metric name used to extract values from `Sample[]` data and shown on the y-axis. */
  metric: string;
  unit?: string;

  /**
   * Intra-run time-series mode: pass `Sample[]` arrays.
   * The x-axis uses elapsed seconds (`sample.t`).
   */
  baseSamples?: Sample[];
  currentSamples?: Sample[];

  /**
   * Cross-run aggregated mode: pass `DataPoint[]` arrays.
   * The x-axis uses ISO-8601 timestamps.
   */
  basePoints?: DataPoint[];
  currentPoints?: DataPoint[];

  /** Label for the base/baseline trace. Defaults to "Base". */
  baseLabel?: string;
  /** Label for the current/PR trace. Defaults to "Current". */
  currentLabel?: string;

  height?: number;
  title?: string;
  subtitle?: string;
  /** CSS class name */
  class?: string;
}

export function ComparisonChart({
  metric,
  unit,
  baseSamples,
  currentSamples,
  basePoints,
  currentPoints,
  baseLabel = "Base",
  currentLabel = "Current",
  height = 300,
  title,
  subtitle,
  class: className,
}: ComparisonChartProps) {
  /** true when operating in Sample[] (intra-run) mode */
  const isSamplesMode = baseSamples !== undefined || currentSamples !== undefined;

  const baseData = useMemo(() => {
    if (isSamplesMode) {
      return samplesToDataPoints(baseSamples ?? [], metric);
    }
    return dataPointsToComparisonData(basePoints ?? []);
  }, [isSamplesMode, baseSamples, basePoints, metric]);

  const currentData = useMemo(() => {
    if (isSamplesMode) {
      return samplesToDataPoints(currentSamples ?? [], metric);
    }
    return dataPointsToComparisonData(currentPoints ?? []);
  }, [isSamplesMode, currentSamples, currentPoints, metric]);

  const isEmpty = baseData.length === 0 && currentData.length === 0;

  const { canvasRef, wrapperRef } = useChartLifecycle<"line">(
    (theme) => {
      if (isEmpty) return null;

      const datasets: ChartDataset<"line", { x: string | number; y: number }[]>[] = [
        {
          label: baseLabel,
          data: baseData,
          borderColor: BASE_COLOR,
          backgroundColor: `${BASE_COLOR}22`,
          fill: false,
          tension: 0,
          borderWidth: 1.75,
          clip: 8,
          spanGaps: true,
          pointRadius: 2.5,
          pointHoverRadius: 6,
          pointBackgroundColor: BASE_COLOR,
          pointBorderColor: BASE_COLOR,
        },
        {
          label: currentLabel,
          data: currentData,
          borderColor: CURRENT_COLOR,
          backgroundColor: `${CURRENT_COLOR}22`,
          fill: false,
          tension: 0,
          borderWidth: 1.75,
          clip: 8,
          spanGaps: true,
          pointRadius: 2.5,
          pointHoverRadius: 6,
          pointBackgroundColor: CURRENT_COLOR,
          pointBorderColor: CURRENT_COLOR,
        },
      ].filter((ds) => ds.data.length > 0);

      const xScale: ChartOptions<"line">["scales"] = isSamplesMode
        ? { x: linearXAxis(theme, { title: "Time (s)", showTitle: true }) }
        : { x: timeXAxis(theme) };

      const options: ChartOptions<"line"> = {
        ...baseLineOptions(),
        layout: { padding: layoutPadding() },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...sharedTooltipStyle(theme),
            callbacks: {
              title: (items) => {
                const raw = items[0]?.label;
                if (!raw) return "";
                if (isSamplesMode) return `t = ${Number(raw).toFixed(2)} s`;
                return new Date(raw).toLocaleString();
              },
              label: (item) => {
                const v = item.parsed.y;
                if (v === null || v === undefined) return "";
                const u = unit ?? "";
                return ` ${item.dataset.label}: ${formatValue(v)}${u ? ` ${u}` : ""}`;
              },
            },
          },
        },
        scales: {
          ...xScale,
          y: yAxisConfig(theme, {
            showTitle: true,
            title: unit ?? metric,
            tickCallback: (value) => formatValue(Number(value)),
          }),
        },
      };

      return { type: "line" as const, data: { datasets: datasets as ChartDataset<"line">[] }, options };
    },
    [
      isEmpty,
      isSamplesMode,
      baseData,
      currentData,
      baseLabel,
      currentLabel,
      metric,
      unit,
    ],
  );

  const visibleLabels = [
    ...(baseData.length > 0 ? [{ label: baseLabel, color: BASE_COLOR }] : []),
    ...(currentData.length > 0 ? [{ label: currentLabel, color: CURRENT_COLOR }] : []),
  ];

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

      {visibleLabels.length > 1 && (
        <div class="bk-chart-legend">
          {visibleLabels.map(({ label, color }) => (
            <span key={label} class="bk-chart-legend__item">
              <span class="bk-chart-legend__swatch" style={{ background: color }} />
              <span class="bk-chart-legend__label">{label}</span>
            </span>
          ))}
        </div>
      )}

      <div class="bk-chart-panel__canvas" style={{ height: `${height}px` }}>
        {isEmpty ? (
          <div class="bk-chart-panel__empty">
            <div>
              <strong>No data to display.</strong>
              <div>Provide baseSamples/currentSamples or basePoints/currentPoints.</div>
            </div>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={title ?? `Comparison chart for ${metric}`}
          >
            Comparison chart for {title ?? metric}
          </canvas>
        )}
      </div>
    </div>
  );
}
