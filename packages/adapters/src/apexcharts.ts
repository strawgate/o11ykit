import type { EngineLatestValueModel, EngineWideTableModel } from "./engine.js";
import { gaugeValue } from "./engine-chart-shared.js";

export type ApexChartsEngineChartType =
  | "line"
  | "area"
  | "bar"
  | "donut"
  | "scatter"
  | "sparkline"
  | "gauge";

export interface ApexChartsEngineOptions {
  readonly chartType?: ApexChartsEngineChartType;
  readonly chartId?: string;
}

export interface ApexChartsEngineModel {
  readonly chart: {
    readonly type: "line" | "bar" | "scatter" | "donut" | "radialBar";
    readonly id?: string;
    readonly sparkline?: { readonly enabled: boolean };
  };
  readonly series: readonly unknown[];
  readonly labels?: readonly string[];
  readonly xaxis?: { readonly type: "datetime" | "category" };
  readonly stroke?: { readonly curve: "smooth" };
  readonly fill?: { readonly opacity: number };
}

export function toApexChartsEngineTimeSeriesOptions(
  model: EngineWideTableModel,
  options: ApexChartsEngineOptions = {}
): ApexChartsEngineModel {
  const chartType = options.chartType ?? "line";
  return {
    chart: {
      ...(options.chartId ? { id: options.chartId } : {}),
      type: chartType === "bar" ? "bar" : chartType === "scatter" ? "scatter" : "line",
      sparkline: { enabled: chartType === "sparkline" },
    },
    series: model.series.map((series, index) => ({
      name: series.label,
      data: model.rows.map((row) => [row.t, row.values[index] ?? null]),
    })),
    xaxis: { type: "datetime" },
    stroke: { curve: "smooth" },
    fill: { opacity: chartType === "area" ? 0.22 : 1 },
  };
}

export function toApexChartsEngineLatestValuesOptions(
  model: EngineLatestValueModel,
  options: ApexChartsEngineOptions = {}
): ApexChartsEngineModel {
  const chartType = options.chartType ?? "donut";
  if (chartType === "gauge") {
    return {
      chart: {
        ...(options.chartId ? { id: options.chartId } : {}),
        type: "radialBar",
        sparkline: { enabled: true },
      },
      series: [gaugeValue(model)],
      labels: ["average"],
    };
  }
  const rows = model.rows.filter((row) => row.value !== null);
  return {
    chart: { ...(options.chartId ? { id: options.chartId } : {}), type: "donut" },
    labels: rows.map((row) => row.label),
    series: rows.map((row) => row.value ?? 0),
  };
}

export function toApexChartsEngineSeriesUpdate(model: ApexChartsEngineModel): {
  readonly series: ApexChartsEngineModel["series"];
  readonly labels?: ApexChartsEngineModel["labels"];
} {
  return {
    series: model.series,
    ...(model.labels ? { labels: model.labels } : {}),
  };
}
