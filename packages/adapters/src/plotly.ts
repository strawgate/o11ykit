import type {
  EngineAdapterOptions,
  EngineHistogramInput,
  EngineHistogramOptions,
  EngineLatestValueInput,
  EngineWideTableInput,
} from "./engine.js";
import {
  asEngineHistogramModel,
  asEngineLatestValueModel,
  asEngineWideTableModel,
} from "./engine.js";
import { gaugeValue } from "./engine-chart-shared.js";

export type PlotlyChartType =
  | "line"
  | "area"
  | "bar"
  | "donut"
  | "histogram"
  | "scatter"
  | "sparkline"
  | "gauge";

export interface PlotlyTrace {
  readonly uid?: string;
  readonly type: "scatter" | "bar" | "pie" | "indicator";
  readonly mode?: "lines" | "markers" | undefined;
  readonly name?: string;
  readonly x?: readonly number[] | readonly string[];
  readonly y?: readonly (number | null)[];
  readonly labels?: readonly string[];
  readonly values?: readonly number[];
  readonly fill?: "tozeroy" | undefined;
  readonly value?: number;
  readonly gauge?: Record<string, unknown>;
}

export interface PlotlyFigure {
  readonly data: readonly PlotlyTrace[];
  readonly layout: Record<string, unknown>;
  readonly config: {
    readonly responsive: boolean;
    readonly displaylogo: boolean;
  };
}

export function toPlotlyTimeSeriesFigure(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & { readonly chartType?: PlotlyChartType } = {}
): PlotlyFigure {
  const wide = asEngineWideTableModel(model, options);
  const chartType = options.chartType ?? "line";
  return {
    data: wide.series.map((series, index) => ({
      uid: plotlyTraceUid(series.id, index),
      type: chartType === "bar" ? "bar" : "scatter",
      mode: chartType === "bar" ? undefined : chartType === "scatter" ? "markers" : "lines",
      name: series.label,
      x: wide.rows.map((row) => row.t),
      y: wide.rows.map((row) => row.values[index] ?? null),
      fill: chartType === "area" ? "tozeroy" : undefined,
    })),
    layout: { xaxis: { type: "date" }, uirevision: "engine-series" },
    config: { responsive: true, displaylogo: false },
  };
}

export function toPlotlyLatestValuesFigure(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions & { readonly chartType?: PlotlyChartType } = {}
): PlotlyFigure {
  const latest = asEngineLatestValueModel(model, options);
  const chartType = options.chartType ?? "donut";
  if (chartType === "gauge") {
    return {
      data: [
        { uid: "latest-gauge", type: "indicator", mode: undefined, value: gaugeValue(latest) },
      ],
      layout: { margin: { t: 16, b: 16 }, uirevision: "engine-latest" },
      config: { responsive: true, displaylogo: false },
    };
  }
  const rows = latest.rows.filter((row) => row.value !== null);
  return {
    data: [
      {
        uid: "latest-values",
        type: "pie",
        labels: rows.map((row) => row.label),
        values: rows.map((row) => row.value ?? 0),
      },
    ],
    layout: { uirevision: "engine-latest" },
    config: { responsive: true, displaylogo: false },
  };
}

export function toPlotlyHistogramFigure(
  model: EngineHistogramInput,
  options: EngineAdapterOptions & EngineHistogramOptions = {}
): PlotlyFigure {
  const histogram = asEngineHistogramModel(model, options);
  return {
    data: [
      {
        uid: "histogram",
        type: "bar",
        x: histogram.buckets.map((bucket) => bucket.label),
        y: histogram.buckets.map((bucket) => bucket.count),
      },
    ],
    layout: { uirevision: "engine-histogram" },
    config: { responsive: true, displaylogo: false },
  };
}

function plotlyTraceUid(id: string, index: number): string {
  return `engine-${index}-${stableHash(id)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
