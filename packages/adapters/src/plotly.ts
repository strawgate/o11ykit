import type {
  EngineHistogramModel,
  EngineLatestValueModel,
  EngineWideTableModel,
} from "./engine.js";
import { gaugeValue } from "./engine-chart-shared.js";

export type PlotlyEngineChartType =
  | "line"
  | "area"
  | "bar"
  | "donut"
  | "histogram"
  | "scatter"
  | "sparkline"
  | "gauge";

export interface PlotlyTrace {
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

export interface PlotlyEngineModel {
  readonly data: readonly PlotlyTrace[];
  readonly layout: Record<string, unknown>;
}

export function toPlotlyEngineTimeSeriesModel(
  model: EngineWideTableModel,
  options: { readonly chartType?: PlotlyEngineChartType } = {}
): PlotlyEngineModel {
  const chartType = options.chartType ?? "line";
  return {
    data: model.series.map((series, index) => ({
      type: chartType === "bar" ? "bar" : "scatter",
      mode: chartType === "bar" ? undefined : chartType === "scatter" ? "markers" : "lines",
      name: series.label,
      x: model.rows.map((row) => row.t),
      y: model.rows.map((row) => row.values[index] ?? null),
      fill: chartType === "area" ? "tozeroy" : undefined,
    })),
    layout: { xaxis: { type: "date" } },
  };
}

export function toPlotlyEngineLatestValuesModel(
  model: EngineLatestValueModel,
  options: { readonly chartType?: PlotlyEngineChartType } = {}
): PlotlyEngineModel {
  const chartType = options.chartType ?? "donut";
  if (chartType === "gauge") {
    return {
      data: [{ type: "indicator", mode: undefined, value: gaugeValue(model) }],
      layout: { margin: { t: 16, b: 16 } },
    };
  }
  const rows = model.rows.filter((row) => row.value !== null);
  return {
    data: [
      {
        type: "pie",
        labels: rows.map((row) => row.label),
        values: rows.map((row) => row.value ?? 0),
      },
    ],
    layout: {},
  };
}

export function toPlotlyEngineHistogramModel(model: EngineHistogramModel): PlotlyEngineModel {
  return {
    data: [
      {
        type: "bar",
        x: model.buckets.map((bucket) => bucket.label),
        y: model.buckets.map((bucket) => bucket.count),
      },
    ],
    layout: {},
  };
}
