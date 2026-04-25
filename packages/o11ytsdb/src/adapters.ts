import type { Labels, QueryResult, SeriesResult } from "./types.js";

export type TsdbTimestampUnit = "nanoseconds" | "milliseconds" | "seconds";

export interface TsdbAdapterOptions {
  readonly timestampUnit?: TsdbTimestampUnit;
  readonly seriesLabel?: (series: SeriesResult, index: number) => string;
}

export interface TsdbPoint {
  readonly t: number;
  readonly v: number;
}

export interface TsdbLineSeries {
  readonly id: string;
  readonly label: string;
  readonly labels: Labels;
  readonly points: readonly TsdbPoint[];
}

export interface TsdbLineSeriesModel {
  readonly kind: "tsdb-line-series";
  readonly series: readonly TsdbLineSeries[];
}

export interface TsdbWideTableRow {
  readonly t: number;
  readonly values: readonly (number | null)[];
}

export interface TsdbWideTableModel {
  readonly kind: "tsdb-wide-table";
  readonly columns: readonly string[];
  readonly series: readonly {
    readonly id: string;
    readonly label: string;
    readonly labels: Labels;
  }[];
  readonly rows: readonly TsdbWideTableRow[];
}

export interface TsdbLatestValueRow {
  readonly id: string;
  readonly label: string;
  readonly labels: Labels;
  readonly t: number | null;
  readonly value: number | null;
}

export interface TsdbLatestValueModel {
  readonly kind: "tsdb-latest-values";
  readonly rows: readonly TsdbLatestValueRow[];
}

export function toTsdbLineSeriesModel(
  result: QueryResult,
  options: TsdbAdapterOptions = {}
): TsdbLineSeriesModel {
  return {
    kind: "tsdb-line-series",
    series: result.series.map((series, index) => ({
      id: seriesId(series, index),
      label: seriesLabel(series, index, options),
      labels: series.labels,
      points: pointsForSeries(series, index, options.timestampUnit),
    })),
  };
}

export function toTsdbWideTableModel(
  result: QueryResult,
  options: TsdbAdapterOptions = {}
): TsdbWideTableModel {
  const seriesMeta = result.series.map((series, index) => ({
    id: seriesId(series, index),
    label: seriesLabel(series, index, options),
    labels: series.labels,
  }));
  const rowValues = new Map<number, Array<number | null>>();

  for (let seriesIndex = 0; seriesIndex < result.series.length; seriesIndex++) {
    const series = result.series[seriesIndex];
    if (!series) continue;
    assertAlignedSeries(series, seriesIndex);
    for (let pointIndex = 0; pointIndex < series.timestamps.length; pointIndex++) {
      const t = timestampToMillis(series.timestamps[pointIndex] ?? 0n, options.timestampUnit);
      let values = rowValues.get(t);
      if (!values) {
        values = new Array(result.series.length).fill(null);
        rowValues.set(t, values);
      }
      values[seriesIndex] = series.values[pointIndex] ?? null;
    }
  }

  return {
    kind: "tsdb-wide-table",
    columns: ["t", ...seriesMeta.map((series) => series.label)],
    series: seriesMeta,
    rows: [...rowValues.entries()]
      .sort(([left], [right]) => left - right)
      .map(([t, values]) => ({ t, values })),
  };
}

export function toTsdbLatestValueModel(
  result: QueryResult,
  options: TsdbAdapterOptions = {}
): TsdbLatestValueModel {
  return {
    kind: "tsdb-latest-values",
    rows: result.series.map((series, index) => {
      assertAlignedSeries(series, index);
      const lastIndex = series.values.length - 1;
      return {
        id: seriesId(series, index),
        label: seriesLabel(series, index, options),
        labels: series.labels,
        t:
          lastIndex >= 0
            ? timestampToMillis(series.timestamps[lastIndex] ?? 0n, options.timestampUnit)
            : null,
        value: lastIndex >= 0 ? (series.values[lastIndex] ?? null) : null,
      };
    }),
  };
}

function pointsForSeries(
  series: SeriesResult,
  index: number,
  timestampUnit: TsdbTimestampUnit | undefined
): TsdbPoint[] {
  assertAlignedSeries(series, index);
  const points: TsdbPoint[] = [];
  for (let i = 0; i < series.timestamps.length; i++) {
    points.push({
      t: timestampToMillis(series.timestamps[i] ?? 0n, timestampUnit),
      v: series.values[i] ?? Number.NaN,
    });
  }
  return points;
}

function assertAlignedSeries(series: SeriesResult, index: number): void {
  if (series.timestamps.length !== series.values.length) {
    throw new RangeError(
      `series ${index} has mismatched timestamps (${series.timestamps.length}) and values (${series.values.length})`
    );
  }
}

function seriesId(series: SeriesResult, index: number): string {
  const parts = [...series.labels.entries()].map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join("\0") : `series-${index}`;
}

function seriesLabel(series: SeriesResult, index: number, options: TsdbAdapterOptions): string {
  if (options.seriesLabel) {
    return options.seriesLabel(series, index);
  }
  const name = series.labels.get("__name__") ?? `series-${index}`;
  const labelParts: string[] = [];
  for (const [key, value] of series.labels) {
    if (key !== "__name__") {
      labelParts.push(`${key}=${value}`);
    }
  }
  return labelParts.length > 0 ? `${name}{${labelParts.join(",")}}` : name;
}

function timestampToMillis(timestamp: bigint, unit: TsdbTimestampUnit = "nanoseconds"): number {
  switch (unit) {
    case "seconds":
      return Number(timestamp) * 1_000;
    case "milliseconds":
      return Number(timestamp);
    case "nanoseconds":
      return Number(timestamp) / 1_000_000;
  }
}
