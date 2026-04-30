import {
  asEngineHistogramModel,
  asEngineLatestValueModel,
  asEngineWideTableModel,
  type EngineAdapterOptions,
  type EngineHistogramInput,
  type EngineHistogramOptions,
  type EngineLatestValueInput,
  type EngineWideTableInput,
} from "./engine.js";
import { gaugeValue } from "./engine-chart-shared.js";

export type ApexChartsChartType =
  | "line"
  | "area"
  | "bar"
  | "donut"
  | "latestBar"
  | "histogram"
  | "scatter"
  | "sparkline"
  | "gauge";

export interface ApexChartsAdapterOptions extends EngineAdapterOptions {
  readonly chartType?: ApexChartsChartType;
  readonly chartId?: string;
  readonly title?: string;
}

export interface ApexChartsOptions {
  readonly chart: {
    readonly type: "line" | "bar" | "scatter" | "donut" | "radialBar";
    readonly id?: string;
    readonly sparkline?: { readonly enabled: boolean };
  };
  readonly series: readonly unknown[];
  readonly labels?: readonly string[];
  readonly xaxis?: {
    readonly type: "datetime" | "category";
    readonly categories?: readonly string[];
  };
  readonly stroke?: { readonly curve: "smooth" };
  readonly fill?: { readonly opacity: number };
}

export function toApexChartsTimeSeriesOptions(
  model: EngineWideTableInput,
  options: ApexChartsAdapterOptions = {}
): ApexChartsOptions {
  const wide = asEngineWideTableModel(model, options);
  const chartType = options.chartType ?? "line";
  return {
    chart: {
      ...(options.chartId ? { id: options.chartId } : {}),
      type: chartType === "bar" ? "bar" : chartType === "scatter" ? "scatter" : "line",
      sparkline: { enabled: chartType === "sparkline" },
    },
    series: wide.series.map((series, index) => ({
      name: series.label,
      data: wide.rows.map((row) => [row.t, row.values[index] ?? null]),
    })),
    xaxis: { type: "datetime" },
    stroke: { curve: "smooth" },
    fill: { opacity: chartType === "area" ? 0.22 : 1 },
  };
}

export function toApexChartsLatestValuesOptions(
  model: EngineLatestValueInput,
  options: ApexChartsAdapterOptions = {}
): ApexChartsOptions {
  const latest = asEngineLatestValueModel(model, options);
  const chartType = options.chartType ?? "donut";
  if (chartType === "gauge") {
    return {
      chart: {
        ...(options.chartId ? { id: options.chartId } : {}),
        type: "radialBar",
        sparkline: { enabled: true },
      },
      series: [gaugeValue(latest)],
      labels: ["average"],
    };
  }
  const rows = latest.rows.filter((row) => row.value !== null);
  if (chartType === "bar" || chartType === "latestBar") {
    return {
      chart: { ...(options.chartId ? { id: options.chartId } : {}), type: "bar" },
      xaxis: { type: "category", categories: rows.map((row) => row.label) },
      series: [{ name: options.title ?? "latest", data: rows.map((row) => row.value ?? 0) }],
    };
  }
  return {
    chart: { ...(options.chartId ? { id: options.chartId } : {}), type: "donut" },
    labels: rows.map((row) => row.label),
    series: rows.map((row) => row.value ?? 0),
  };
}

export function toApexChartsHistogramOptions(
  model: EngineHistogramInput,
  options: ApexChartsAdapterOptions & EngineHistogramOptions = {}
): ApexChartsOptions {
  const histogram = asEngineHistogramModel(model, options);
  return {
    chart: { ...(options.chartId ? { id: options.chartId } : {}), type: "bar" },
    xaxis: { type: "category", categories: histogram.buckets.map((bucket) => bucket.label) },
    series: [
      { name: options.title ?? "samples", data: histogram.buckets.map((bucket) => bucket.count) },
    ],
  };
}

export function toApexChartsSeriesUpdate(model: ApexChartsOptions): {
  readonly series: ApexChartsOptions["series"];
  readonly labels?: ApexChartsOptions["labels"];
} {
  return {
    series: model.series,
    ...(model.labels ? { labels: model.labels } : {}),
  };
}
