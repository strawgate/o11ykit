import type {
  EngineHistogramModel,
  EngineLatestValueModel,
  EngineWideTableModel,
} from "./engine.js";
import { gaugeValue } from "./engine-chart-shared.js";

export type HighchartsEngineChartType =
  | "line"
  | "area"
  | "bar"
  | "donut"
  | "histogram"
  | "scatter"
  | "sparkline"
  | "gauge";

export interface HighchartsSeries {
  readonly id?: string;
  readonly name?: string;
  readonly type?: "line" | "area" | "bar" | "scatter" | "pie" | "gauge" | "column" | undefined;
  readonly data: readonly unknown[];
}

export interface HighchartsEngineOptions {
  readonly chartType?: HighchartsEngineChartType;
}

export interface HighchartsEngineOptionsModel {
  readonly chart: { readonly type: string };
  readonly xAxis?: Record<string, unknown>;
  readonly plotOptions?: Record<string, unknown>;
  readonly series: readonly HighchartsSeries[];
}

export function toHighchartsEngineTimeSeriesOptions(
  model: EngineWideTableModel,
  options: HighchartsEngineOptions = {}
): HighchartsEngineOptionsModel {
  const chartType = options.chartType ?? "line";
  return {
    chart: { type: chartType === "bar" ? "bar" : chartType === "scatter" ? "scatter" : "line" },
    xAxis: { type: "datetime" },
    series: model.series.map((series, index) => ({
      id: series.id,
      name: series.label,
      data: model.rows.map((row) => [row.t, row.values[index] ?? null]),
      type: chartType === "area" ? "area" : chartType === "sparkline" ? "line" : undefined,
    })),
  };
}

export function toHighchartsEngineLatestValuesOptions(
  model: EngineLatestValueModel,
  options: HighchartsEngineOptions = {}
): HighchartsEngineOptionsModel {
  const chartType = options.chartType ?? "donut";
  if (chartType === "gauge") {
    return {
      chart: { type: "gauge" },
      series: [{ name: "average", data: [gaugeValue(model)] }],
    };
  }
  return {
    chart: { type: "pie" },
    plotOptions: { pie: { innerSize: "55%" } },
    series: [
      {
        data: model.rows.flatMap((row) => (row.value === null ? [] : [[row.label, row.value]])),
      },
    ],
  };
}

export function toHighchartsEngineHistogramOptions(
  model: EngineHistogramModel
): HighchartsEngineOptionsModel {
  return {
    chart: { type: "column" },
    xAxis: { categories: model.buckets.map((bucket) => bucket.label) },
    series: [{ name: "samples", data: model.buckets.map((bucket) => bucket.count) }],
  };
}
