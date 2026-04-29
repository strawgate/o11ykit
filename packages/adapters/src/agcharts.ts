import type { EngineLatestValueModel, EngineWideTableModel } from "./engine.js";
import { gaugeValue, rowToRecord } from "./engine-chart-shared.js";

export type AgChartsEngineChartType = "line" | "area" | "bar" | "donut" | "scatter" | "gauge";

export interface AgChartsSeriesOptions {
  readonly type: "line" | "area" | "bar" | "donut" | "scatter";
  readonly xKey?: string;
  readonly yKey?: string;
  readonly yName?: string;
  readonly angleKey?: string;
  readonly calloutLabelKey?: string;
}

export interface AgChartsEngineOptionsModel {
  readonly data?: readonly Record<string, number | string | null>[];
  readonly series?: readonly AgChartsSeriesOptions[];
  readonly type?: "radial-gauge";
  readonly value?: number;
  readonly scale?: { readonly min: number; readonly max: number };
}

export function toAgChartsEngineTimeSeriesOptions(
  model: EngineWideTableModel,
  options: { readonly chartType?: AgChartsEngineChartType } = {}
): AgChartsEngineOptionsModel {
  const chartType = options.chartType ?? "line";
  return {
    data: model.rows.map((row) => rowToRecord(row, model.series, "time")),
    series: model.series.map((series) => ({
      type:
        chartType === "bar"
          ? "bar"
          : chartType === "scatter"
            ? "scatter"
            : chartType === "area"
              ? "area"
              : "line",
      xKey: "time",
      yKey: series.id,
      yName: series.label,
    })),
  };
}

export function toAgChartsEngineLatestValuesOptions(
  model: EngineLatestValueModel,
  options: { readonly chartType?: AgChartsEngineChartType } = {}
): AgChartsEngineOptionsModel {
  const chartType = options.chartType ?? "donut";
  if (chartType === "gauge") {
    return {
      type: "radial-gauge",
      value: gaugeValue(model),
      scale: { min: 0, max: 200 },
    };
  }
  return {
    data: model.rows.flatMap((row) =>
      row.value === null ? [] : [{ label: row.label, value: row.value }]
    ),
    series: [{ type: "donut", angleKey: "value", calloutLabelKey: "label" }],
  };
}
