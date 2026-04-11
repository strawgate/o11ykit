/**
 * Shared Chart.js configuration factories.
 *
 * These composable helpers eliminate duplication across TrendChart,
 * ComparisonChart, and SampleChart while keeping chart-specific
 * callbacks and interaction modes at the call site.
 */

import type { ChartOptions } from "chart.js";
import type { ChartTheme } from "./theme.js";

/** Tooltip visual styling shared by all line charts. */
export function sharedTooltipStyle(theme: ChartTheme) {
  return {
    backgroundColor: theme.tooltipBackground,
    borderColor: theme.tooltipBorder,
    borderWidth: 1,
    titleColor: theme.tooltipTitle,
    bodyColor: theme.tooltipBody,
    padding: 12,
    displayColors: true,
  } as const;
}

/** Layout padding with optional compact mode. */
export function layoutPadding(compact = false) {
  return compact
    ? { left: 2, right: 6, top: 2, bottom: 0 }
    : { left: 4, right: 8, top: 4, bottom: 2 };
}

/** Common responsive + hidden-legend base. */
export function baseLineOptions(): Pick<
  ChartOptions<"line">,
  "responsive" | "maintainAspectRatio"
> {
  return { responsive: true, maintainAspectRatio: false };
}

/** Common Y-axis configuration. */
export function yAxisConfig(
  theme: ChartTheme,
  opts?: {
    title?: string;
    showTitle?: boolean;
    tickCallback?: (value: number | string) => string;
    maxTicksLimit?: number;
  },
) {
  return {
    beginAtZero: false as const,
    title: {
      display: opts?.showTitle ?? false,
      text: opts?.title ?? "",
      color: theme.mutedText,
    },
    grid: { color: theme.grid },
    ticks: {
      color: theme.mutedText,
      maxTicksLimit: opts?.maxTicksLimit ?? 6,
      ...(opts?.tickCallback ? { callback: opts.tickCallback } : {}),
    },
    border: { color: theme.border },
  };
}

/** Time-series X-axis used by TrendChart and ComparisonChart (time mode). */
export function timeXAxis(
  theme: ChartTheme,
  opts?: { maxTicksLimit?: number },
) {
  return {
    type: "time" as const,
    time: { tooltipFormat: "PPpp" },
    grid: { color: theme.grid },
    ticks: {
      color: theme.mutedText,
      maxRotation: 0,
      autoSkipPadding: 18,
      maxTicksLimit: opts?.maxTicksLimit ?? 7,
    },
    border: { color: theme.border },
  };
}

/** Linear X-axis used by SampleChart and ComparisonChart (samples mode). */
export function linearXAxis(
  theme: ChartTheme,
  opts?: {
    title?: string;
    showTitle?: boolean;
    maxTicksLimit?: number;
    tickCallback?: (value: number | string) => string;
  },
) {
  return {
    type: "linear" as const,
    title: {
      display: opts?.showTitle ?? false,
      text: opts?.title ?? "",
      color: theme.mutedText,
    },
    grid: { color: theme.grid },
    ticks: {
      color: theme.mutedText,
      maxTicksLimit: opts?.maxTicksLimit ?? 7,
      ...(opts?.tickCallback ? { callback: opts.tickCallback } : {}),
    },
    border: { color: theme.border },
  };
}
