import type { HistogramFrame, LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

import type { EngineLatestValueModel, EngineWideTableModel } from "./engine.js";
import { histogramRows, pivotTimeSeriesFrame } from "./shared.js";

export interface RechartsSeriesDescriptor {
  readonly dataKey: string;
  readonly name: string;
  readonly id?: string;
}

export interface RechartsTimeSeriesModel {
  readonly data: readonly Record<string, number | string | null>[];
  readonly xAxisKey: string;
  readonly tooltipKey: string;
  readonly unit: string | null;
  readonly series: readonly RechartsSeriesDescriptor[];
}

export interface RechartsBarModel {
  readonly data: readonly Record<string, number | string>[];
  readonly categoryKey: string;
  readonly valueKey: string;
  readonly unit: string | null;
}

export function toRechartsTimeSeriesModel(frame: TimeSeriesFrame): RechartsTimeSeriesModel {
  const pivoted = pivotTimeSeriesFrame(frame);
  return {
    data: pivoted.rows,
    xAxisKey: "timeMs",
    tooltipKey: "isoTime",
    unit: frame.unit,
    series: frame.series.map((series) => ({
      dataKey: series.key,
      name: series.label,
    })),
  };
}

export function toRechartsLatestValuesModel(frame: LatestValuesFrame): RechartsBarModel {
  return {
    data: frame.rows.map((row) => ({
      label: row.label,
      value: row.value,
    })),
    categoryKey: "label",
    valueKey: "value",
    unit: frame.unit,
  };
}

export function toRechartsHistogramModel(frame: HistogramFrame): RechartsBarModel {
  return {
    data: histogramRows(frame),
    categoryKey: "label",
    valueKey: "count",
    unit: frame.unit,
  };
}

export interface RechartsEngineTimeSeriesOptions {
  readonly xAxisKey?: string;
  readonly tooltipKey?: string;
  readonly unit?: string | null;
  readonly seriesName?: (series: EngineWideTableModel["series"][number], index: number) => string;
}

export function toRechartsEngineTimeSeriesModel(
  model: EngineWideTableModel,
  options: RechartsEngineTimeSeriesOptions = {}
): RechartsTimeSeriesModel {
  const xAxisKey = options.xAxisKey ?? "time";
  const tooltipKey = options.tooltipKey ?? xAxisKey;
  return {
    data: model.rows.map((row) => {
      const output: Record<string, number | string | null> = {
        [xAxisKey]: row.t,
      };
      if (tooltipKey !== xAxisKey) {
        output[tooltipKey] = row.t;
      }
      for (let i = 0; i < model.series.length; i++) {
        const series = model.series[i];
        if (!series) continue;
        output[series.id] = row.values[i] ?? null;
      }
      return output;
    }),
    xAxisKey,
    tooltipKey,
    unit: options.unit ?? null,
    series: model.series.map((series, index) => ({
      id: series.id,
      dataKey: series.id,
      name: options.seriesName?.(series, index) ?? series.label,
    })),
  };
}

export function toRechartsEngineLatestValuesModel(
  model: EngineLatestValueModel,
  options: { readonly unit?: string | null } = {}
): RechartsBarModel {
  return {
    data: model.rows.flatMap((row) =>
      row.value === null
        ? []
        : [
            {
              label: row.label,
              value: row.value,
            },
          ]
    ),
    categoryKey: "label",
    valueKey: "value",
    unit: options.unit ?? null,
  };
}
