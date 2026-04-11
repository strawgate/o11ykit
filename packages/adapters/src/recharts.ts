import type { HistogramFrame, LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

import { histogramRows, pivotTimeSeriesFrame } from "./shared.js";

export interface RechartsSeriesDescriptor {
  readonly dataKey: string;
  readonly name: string;
}

export interface RechartsTimeSeriesModel {
  readonly data: readonly Record<string, number | string | null>[];
  readonly xAxisKey: "timeMs";
  readonly tooltipKey: "isoTime";
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
