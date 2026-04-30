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

export type HighchartsChartType =
  | "line"
  | "area"
  | "bar"
  | "donut"
  | "latestBar"
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

export interface HighchartsAdapterOptions extends EngineAdapterOptions, EngineHistogramOptions {
  readonly chartType?: HighchartsChartType;
}

export interface HighchartsOptions {
  readonly chart: { readonly type: string };
  readonly xAxis?: Record<string, unknown>;
  readonly plotOptions?: Record<string, unknown>;
  readonly series: readonly HighchartsSeries[];
}

export function toHighchartsTimeSeriesOptions(
  model: EngineWideTableInput,
  options: HighchartsAdapterOptions = {}
): HighchartsOptions {
  const wide = asEngineWideTableModel(model, options);
  const chartType = options.chartType ?? "line";
  return {
    chart: { type: chartType === "bar" ? "bar" : chartType === "scatter" ? "scatter" : "line" },
    xAxis: { type: "datetime" },
    series: wide.series.map((series, index) => ({
      id: series.id,
      name: series.label,
      data: wide.rows.map((row) => [row.t, row.values[index] ?? null]),
      type: chartType === "area" ? "area" : chartType === "sparkline" ? "line" : undefined,
    })),
  };
}

export function toHighchartsLatestValuesOptions(
  model: EngineLatestValueInput,
  options: HighchartsAdapterOptions = {}
): HighchartsOptions {
  const latest = asEngineLatestValueModel(model, options);
  const chartType = options.chartType ?? "donut";
  if (chartType === "gauge") {
    return {
      chart: { type: "gauge" },
      series: [{ name: "average", data: [gaugeValue(latest)] }],
    };
  }
  const rows = latest.rows.filter((row) => row.value !== null);
  if (chartType === "bar" || chartType === "latestBar") {
    return {
      chart: { type: "bar" },
      xAxis: { categories: rows.map((row) => row.label) },
      series: [{ name: "latest", type: "bar", data: rows.map((row) => row.value ?? 0) }],
    };
  }
  return {
    chart: { type: "pie" },
    plotOptions: { pie: { innerSize: "55%" } },
    series: [
      {
        data: rows.map((row) => [row.label, row.value]),
      },
    ],
  };
}

export function toHighchartsHistogramOptions(
  model: EngineHistogramInput,
  options: HighchartsAdapterOptions = {}
): HighchartsOptions {
  const histogram = asEngineHistogramModel(model, options);
  return {
    chart: { type: "column" },
    xAxis: { categories: histogram.buckets.map((bucket) => bucket.label) },
    series: [{ name: "samples", data: histogram.buckets.map((bucket) => bucket.count) }],
  };
}
