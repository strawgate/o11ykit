import type { HistogramFrame, LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

import type {
  EngineAdapterOptions,
  EngineHistogramInput,
  EngineHistogramOptions,
  EngineLatestValueInput,
  EngineWideTableInput,
  EngineWideTableModel,
} from "./engine.js";
import {
  asEngineHistogramModel,
  asEngineLatestValueModel,
  asEngineWideTableModel,
} from "./engine.js";
import { histogramRows, pivotTimeSeriesFrame } from "./shared.js";

export interface RechartsSeriesDescriptor {
  readonly dataKey: string;
  readonly name: string;
  readonly id?: string;
}

export interface RechartsViewTimeSeriesData {
  readonly data: readonly Record<string, number | string | null>[];
  readonly xAxisKey: "timeMs";
  readonly tooltipKey: "isoTime";
  readonly unit: string | null;
  readonly series: readonly RechartsSeriesDescriptor[];
}

export interface RechartsTimeSeriesData {
  readonly data: readonly Record<string, number | string | null>[];
  readonly xAxisKey: string;
  readonly tooltipKey: string;
  readonly unit: string | null;
  readonly series: readonly RechartsSeriesDescriptor[];
}

export interface RechartsCategoryData {
  readonly data: readonly Record<string, number | string>[];
  readonly categoryKey: string;
  readonly valueKey: string;
  readonly unit: string | null;
}

export interface RechartsScatterData {
  readonly data: readonly Record<string, number | string | null>[];
  readonly xAxisKey: string;
  readonly yAxisKey: string;
  readonly seriesKey: string;
  readonly unit: string | null;
  readonly series: readonly {
    readonly id: string;
    readonly name: string;
  }[];
}

export function toRechartsViewTimeSeriesData(frame: TimeSeriesFrame): RechartsViewTimeSeriesData {
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

export function toRechartsViewLatestValuesData(frame: LatestValuesFrame): RechartsCategoryData {
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

export function toRechartsViewHistogramData(frame: HistogramFrame): RechartsCategoryData {
  return {
    data: histogramRows(frame),
    categoryKey: "label",
    valueKey: "count",
    unit: frame.unit,
  };
}

export interface RechartsTimeSeriesOptions extends EngineAdapterOptions {
  readonly xAxisKey?: string;
  readonly tooltipKey?: string;
  readonly unit?: string | null;
  readonly seriesName?: (series: EngineWideTableModel["series"][number], index: number) => string;
}

export function toRechartsTimeSeriesData(
  model: EngineWideTableInput,
  options: RechartsTimeSeriesOptions = {}
): RechartsTimeSeriesData {
  const wide = asEngineWideTableModel(model, options);
  const xAxisKey = options.xAxisKey ?? "time";
  const tooltipKey = options.tooltipKey ?? xAxisKey;
  const reservedKeys = new Set([xAxisKey, tooltipKey]);
  const series = wide.series.map((series, index) => ({
    id: series.id,
    dataKey: uniqueDataKey(series.id, reservedKeys),
    name: options.seriesName?.(series, index) ?? series.label,
  }));

  return {
    data: wide.rows.map((row) => {
      const output: Record<string, number | string | null> = {
        [xAxisKey]: row.t,
      };
      if (tooltipKey !== xAxisKey) {
        output[tooltipKey] = row.t;
      }
      for (let i = 0; i < wide.series.length; i++) {
        const seriesMeta = series[i];
        if (!seriesMeta) continue;
        output[seriesMeta.dataKey] = row.values[i] ?? null;
      }
      return output;
    }),
    xAxisKey,
    tooltipKey,
    unit: options.unit ?? null,
    series,
  };
}

export function toRechartsLatestValuesData(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions & { readonly unit?: string | null } = {}
): RechartsCategoryData {
  const latest = asEngineLatestValueModel(model, options);
  return {
    data: latest.rows.flatMap((row) =>
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

export function toRechartsHistogramData(
  model: EngineHistogramInput,
  options: EngineAdapterOptions & EngineHistogramOptions & { readonly unit?: string | null } = {}
): RechartsCategoryData {
  const histogram = asEngineHistogramModel(model, options);
  return {
    data: histogram.buckets.map((bucket) => ({
      label: bucket.label,
      count: bucket.count,
      start: bucket.start,
      end: bucket.end,
    })),
    categoryKey: "label",
    valueKey: "count",
    unit: options.unit ?? null,
  };
}

export function toRechartsScatterData(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & {
    readonly xAxisKey?: string;
    readonly yAxisKey?: string;
    readonly seriesKey?: string;
    readonly unit?: string | null;
    readonly seriesName?: (series: EngineWideTableModel["series"][number], index: number) => string;
  } = {}
): RechartsScatterData {
  const wide = asEngineWideTableModel(model, options);
  const xAxisKey = options.xAxisKey ?? "time";
  const yAxisKey = options.yAxisKey ?? "value";
  const seriesKey = options.seriesKey ?? "series";
  if (xAxisKey === yAxisKey || xAxisKey === seriesKey || yAxisKey === seriesKey) {
    throw new RangeError("Recharts scatter xAxisKey, yAxisKey, and seriesKey must be distinct");
  }
  const series = wide.series.map((series, index) => ({
    id: series.id,
    name: options.seriesName?.(series, index) ?? series.label,
  }));

  return {
    data: wide.rows.flatMap((row) =>
      series.map((series, index) => ({
        [xAxisKey]: row.t,
        [yAxisKey]: row.values[index] ?? null,
        [seriesKey]: series.name,
        id: series.id,
      }))
    ),
    xAxisKey,
    yAxisKey,
    seriesKey,
    unit: options.unit ?? null,
    series,
  };
}

function uniqueDataKey(base: string, used: Set<string>): string {
  const fallback = base.length > 0 ? base : `series-${used.size}`;
  let key = fallback;
  let suffix = 2;
  while (used.has(key)) {
    key = `${fallback} (${suffix})`;
    suffix += 1;
  }
  used.add(key);
  return key;
}
