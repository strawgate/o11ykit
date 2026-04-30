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

export interface VisxDatum {
  readonly x: number | string;
  readonly y: number | null;
}

export interface VisxSeries {
  readonly key: string;
  readonly label: string;
  readonly data: readonly VisxDatum[];
}

export interface VisxXYChartModel {
  readonly data: readonly VisxSeries[];
  readonly accessors: {
    readonly xAccessor: (datum: VisxDatum) => VisxDatum["x"];
    readonly yAccessor: (datum: VisxDatum) => VisxDatum["y"];
  };
  readonly xScale: { readonly type: "time" | "band" | "linear" };
  readonly yScale: { readonly type: "linear"; readonly nice: boolean };
}

export function toVisxXYChartModel(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & {
    readonly chartType?: "line" | "area" | "bar" | "scatter" | "sparkline";
  } = {}
): VisxXYChartModel {
  const wide = asEngineWideTableModel(model, options);
  return {
    data: wide.series.map((series, index) => ({
      key: series.id,
      label: series.label,
      data: wide.rows.map((row) => ({ x: row.t, y: row.values[index] ?? null })),
    })),
    accessors: {
      xAccessor: (datum) => datum.x,
      yAccessor: (datum) => datum.y,
    },
    xScale: { type: options.chartType === "bar" ? "band" : "time" },
    yScale: { type: "linear", nice: true },
  };
}

export function toVisxLatestValuesModel(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions = {}
): VisxXYChartModel {
  const latest = asEngineLatestValueModel(model, options);
  return {
    data: [
      {
        key: "latest",
        label: "latest",
        data: latest.rows.flatMap((row) =>
          row.value === null ? [] : [{ x: row.label, y: row.value }]
        ),
      },
    ],
    accessors: {
      xAccessor: (datum) => datum.x,
      yAccessor: (datum) => datum.y,
    },
    xScale: { type: "band" },
    yScale: { type: "linear", nice: true },
  };
}

export function toVisxHistogramModel(
  model: EngineHistogramInput,
  options: EngineAdapterOptions & EngineHistogramOptions = {}
): VisxXYChartModel {
  const histogram = asEngineHistogramModel(model, options);
  return {
    data: [
      {
        key: "histogram",
        label: "samples",
        data: histogram.buckets.map((bucket) => ({ x: bucket.label, y: bucket.count })),
      },
    ],
    accessors: {
      xAccessor: (datum) => datum.x,
      yAccessor: (datum) => datum.y,
    },
    xScale: { type: "band" },
    yScale: { type: "linear", nice: true },
  };
}
