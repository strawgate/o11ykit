import {
  asEngineLatestValueModel,
  asEngineWideTableModel,
  type EngineAdapterOptions,
  type EngineLatestValueInput,
  type EngineWideTableInput,
} from "./engine.js";
import { gaugeValue, rowToRecord } from "./engine-chart-shared.js";

export type AgChartsChartType = "line" | "area" | "bar" | "donut" | "scatter" | "gauge";

export interface AgChartsSeriesOptions {
  readonly type: "line" | "area" | "bar" | "donut" | "scatter";
  readonly id?: string;
  readonly xKey?: string;
  readonly yKey?: string;
  readonly yName?: string;
  readonly angleKey?: string;
  readonly calloutLabelKey?: string;
}

export interface AgChartsOptions {
  readonly data?: readonly Record<string, number | string | null>[];
  readonly series?: readonly AgChartsSeriesOptions[];
  readonly type?: "radial-gauge";
  readonly value?: number;
  readonly scale?: { readonly min: number; readonly max: number };
}

export interface AgChartsUpdateDelta {
  readonly data?: AgChartsOptions["data"];
  readonly series?: AgChartsOptions["series"];
  readonly value?: AgChartsOptions["value"];
}

export function toAgChartsTimeSeriesOptions(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & { readonly chartType?: AgChartsChartType } = {}
): AgChartsOptions {
  const wide = asEngineWideTableModel(model, options);
  const chartType = options.chartType ?? "line";
  const seriesKeys = wide.series.map((_series, index) => `series_${index}`);
  return {
    data: wide.rows.map((row) => {
      const output = rowToRecord(row, [], "time");
      for (let index = 0; index < seriesKeys.length; index++) {
        output[seriesKeys[index] ?? `series_${index}`] = row.values[index] ?? null;
      }
      return output;
    }),
    series: wide.series.map((series, index) => ({
      id: series.id,
      type:
        chartType === "bar"
          ? "bar"
          : chartType === "scatter"
            ? "scatter"
            : chartType === "area"
              ? "area"
              : "line",
      xKey: "time",
      yKey: seriesKeys[index] ?? `series_${index}`,
      yName: series.label,
    })),
  };
}

export function toAgChartsUpdateDelta(model: AgChartsOptions): AgChartsUpdateDelta {
  return {
    ...(model.data ? { data: model.data } : {}),
    ...(model.series ? { series: model.series } : {}),
    ...(model.value !== undefined ? { value: model.value } : {}),
  };
}

export function toAgChartsLatestValuesOptions(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions & { readonly chartType?: AgChartsChartType } = {}
): AgChartsOptions {
  const latest = asEngineLatestValueModel(model, options);
  const chartType = options.chartType ?? "donut";
  if (chartType === "gauge") {
    return {
      type: "radial-gauge",
      value: gaugeValue(latest),
      scale: { min: 0, max: 200 },
    };
  }
  return {
    data: latest.rows.flatMap((row) =>
      row.value === null ? [] : [{ label: row.label, value: row.value }]
    ),
    series: [{ type: "donut", angleKey: "value", calloutLabelKey: "label" }],
  };
}
