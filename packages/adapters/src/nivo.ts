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
import { rowToRecord } from "./engine-chart-shared.js";

export interface NivoPoint {
  readonly x: number;
  readonly y: number | null;
}

export interface NivoSeries {
  readonly id: string;
  readonly data: readonly NivoPoint[];
}

export interface NivoBarData {
  readonly data: readonly Record<string, number | string | null>[];
  readonly keys: readonly string[];
  readonly indexBy: string;
}

export interface NivoLineProps {
  readonly data: readonly NivoSeries[];
  readonly xScale: { readonly type: "linear" };
  readonly yScale: { readonly type: "linear"; readonly stacked: boolean };
  readonly curve: "monotoneX" | "linear";
  readonly enablePoints: boolean;
}

export interface NivoBarProps extends NivoBarData {
  readonly groupMode: "grouped" | "stacked";
}

export interface NivoPieProps {
  readonly data: readonly NivoPieDatum[];
  readonly id: "id";
  readonly value: "value";
}

export interface NivoPieDatum {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly color?: string;
}

export function toNivoLineSeries(
  model: EngineWideTableInput,
  options: EngineAdapterOptions = {}
): readonly NivoSeries[] {
  const wide = asEngineWideTableModel(model, options);
  return wide.series.map((series, index) => ({
    id: series.label,
    data: wide.rows.map((row) => ({ x: row.t, y: row.values[index] ?? null })),
  }));
}

export function toNivoLineProps(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & {
    readonly chartType?: "line" | "area" | "sparkline";
    readonly stacked?: boolean;
  } = {}
): NivoLineProps {
  return {
    data: toNivoLineSeries(model, options),
    xScale: { type: "linear" },
    yScale: { type: "linear", stacked: options.stacked ?? options.chartType === "area" },
    curve: "monotoneX",
    enablePoints: options.chartType !== "sparkline",
  };
}

export function toNivoBarData(
  model: EngineWideTableInput,
  options: EngineAdapterOptions = {}
): NivoBarData {
  const wide = asEngineWideTableModel(model, options);
  return {
    data: wide.rows.map((row) => rowToRecord(row, wide.series, "time")),
    keys: wide.series.map((series) => series.id),
    indexBy: "time",
  };
}

export function toNivoBarProps(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & { readonly groupMode?: "grouped" | "stacked" } = {}
): NivoBarProps {
  return {
    ...toNivoBarData(model, options),
    groupMode: options.groupMode ?? "grouped",
  };
}

export function toNivoLatestBarData(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions = {}
): NivoBarData {
  return {
    data: asEngineLatestValueModel(model, options).rows.flatMap((row) =>
      row.value === null ? [] : [{ label: row.label, value: row.value }]
    ),
    keys: ["value"],
    indexBy: "label",
  };
}

export function toNivoLatestBarProps(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions & { readonly groupMode?: "grouped" | "stacked" } = {}
): NivoBarProps {
  return {
    ...toNivoLatestBarData(model, options),
    groupMode: options.groupMode ?? "grouped",
  };
}

export function toNivoHistogramBarData(
  model: EngineHistogramInput,
  options: EngineAdapterOptions & EngineHistogramOptions = {}
): NivoBarData {
  const histogram = asEngineHistogramModel(model, options);
  return {
    data: histogram.buckets.map((bucket) => ({ label: bucket.label, count: bucket.count })),
    keys: ["count"],
    indexBy: "label",
  };
}

export function toNivoHistogramBarProps(
  model: EngineHistogramInput,
  options: EngineAdapterOptions &
    EngineHistogramOptions & { readonly groupMode?: "grouped" | "stacked" } = {}
): NivoBarProps {
  return {
    ...toNivoHistogramBarData(model, options),
    groupMode: options.groupMode ?? "grouped",
  };
}

export function toNivoPieData(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions = {}
): readonly NivoPieDatum[] {
  return asEngineLatestValueModel(model, options).rows.flatMap((row) =>
    row.value === null
      ? []
      : [
          {
            id: row.label,
            label: row.label,
            value: row.value,
          },
        ]
  );
}

export function toNivoPieProps(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions = {}
): NivoPieProps {
  return {
    data: toNivoPieData(model, options),
    id: "id",
    value: "value",
  };
}

export function toNivoScatterSeries(
  model: EngineWideTableInput,
  options: EngineAdapterOptions = {}
): readonly NivoSeries[] {
  return toNivoLineSeries(model, options);
}
