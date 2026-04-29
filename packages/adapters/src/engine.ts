export type EngineTimestampUnit = "nanoseconds" | "milliseconds" | "seconds";

export type EngineLabels = ReadonlyMap<string, string>;

export interface EngineSeriesResult {
  readonly labels: EngineLabels;
  readonly timestamps: BigInt64Array;
  readonly values: Float64Array;
}

export interface EngineQueryResult {
  readonly series: readonly EngineSeriesResult[];
}

export interface EngineAdapterOptions {
  readonly timestampUnit?: EngineTimestampUnit;
  readonly seriesLabel?: (series: EngineSeriesResult, index: number) => string;
  readonly maxPoints?: number;
}

export interface EnginePoint {
  readonly t: number;
  readonly v: number | null;
}

export interface EngineLineSeries {
  readonly id: string;
  readonly label: string;
  readonly labels: EngineLabels;
  readonly points: readonly EnginePoint[];
}

export interface EngineLineSeriesModel {
  readonly kind: "engine-line-series";
  readonly series: readonly EngineLineSeries[];
}

export interface EngineWideRow {
  readonly t: number;
  readonly values: readonly (number | null)[];
}

export interface EngineWideTableModel {
  readonly kind: "engine-wide-table";
  readonly columns: readonly string[];
  readonly series: readonly {
    readonly id: string;
    readonly label: string;
    readonly labels: EngineLabels;
  }[];
  readonly rows: readonly EngineWideRow[];
}

export interface EngineLatestValueRow {
  readonly id: string;
  readonly label: string;
  readonly labels: EngineLabels;
  readonly t: number | null;
  readonly value: number | null;
}

export interface EngineLatestValueModel {
  readonly kind: "engine-latest-values";
  readonly rows: readonly EngineLatestValueRow[];
}

export interface EngineHistogramBucket {
  readonly label: string;
  readonly count: number;
  readonly start: number;
  readonly end: number;
}

export interface EngineHistogramModel {
  readonly kind: "engine-histogram";
  readonly buckets: readonly EngineHistogramBucket[];
}

export interface EngineHistogramOptions {
  readonly bucketCount?: number;
  readonly valueFormatter?: (start: number, end: number, index: number) => string;
}

export function toEngineLineSeriesModel(
  result: EngineQueryResult,
  options: EngineAdapterOptions = {}
): EngineLineSeriesModel {
  return {
    kind: "engine-line-series",
    series: result.series.map((series, index) => ({
      id: seriesId(series, index),
      label: seriesLabel(series, index, options),
      labels: series.labels,
      points: applyPointBudget(
        pointsForSeries(series, index, options.timestampUnit),
        options.maxPoints
      ),
    })),
  };
}

export function toEngineWideTableModel(
  result: EngineQueryResult,
  options: EngineAdapterOptions = {}
): EngineWideTableModel {
  const line = toEngineLineSeriesModel(result, options);
  const rowValues = new Map<number, Array<number | null>>();

  for (let seriesIndex = 0; seriesIndex < line.series.length; seriesIndex++) {
    const series = line.series[seriesIndex];
    if (!series) continue;
    for (const point of series.points) {
      let values = rowValues.get(point.t);
      if (!values) {
        values = new Array(line.series.length).fill(null);
        rowValues.set(point.t, values);
      }
      values[seriesIndex] = point.v;
    }
  }

  return {
    kind: "engine-wide-table",
    columns: ["t", ...line.series.map((series) => series.label)],
    series: line.series.map((series) => ({
      id: series.id,
      label: series.label,
      labels: series.labels,
    })),
    rows: [...rowValues.entries()]
      .sort(([left], [right]) => left - right)
      .map(([t, values]) => ({ t, values })),
  };
}

export function toEngineLatestValueModel(
  result: EngineQueryResult,
  options: EngineAdapterOptions = {}
): EngineLatestValueModel {
  return {
    kind: "engine-latest-values",
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
        value: lastIndex >= 0 ? finiteOrNull(series.values[lastIndex] ?? Number.NaN) : null,
      };
    }),
  };
}

export function toEngineHistogramModel(
  model: EngineWideTableModel,
  options: EngineHistogramOptions = {}
): EngineHistogramModel {
  const values = model.rows.flatMap((row) =>
    row.values.filter((value): value is number => value !== null && Number.isFinite(value))
  );
  const bucketCount = Math.max(1, Math.floor(options.bucketCount ?? 7));
  if (values.length === 0) {
    return {
      kind: "engine-histogram",
      buckets: Array.from({ length: bucketCount }, (_, index) => ({
        label: options.valueFormatter?.(index, index + 1, index) ?? `${index}-${index + 1}`,
        count: 0,
        start: index,
        end: index + 1,
      })),
    };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = (max - min || 1) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const start = min + index * width;
    const end = min + (index + 1) * width;
    return {
      label:
        options.valueFormatter?.(start, end, index) ?? `${Math.round(start)}-${Math.round(end)}`,
      count: 0,
      start,
      end,
    };
  });

  for (const value of values) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((value - min) / width)));
    const bucket = buckets[index];
    if (bucket) {
      bucket.count += 1;
    }
  }

  return { kind: "engine-histogram", buckets };
}

function pointsForSeries(
  series: EngineSeriesResult,
  index: number,
  timestampUnit: EngineTimestampUnit | undefined
): EnginePoint[] {
  assertAlignedSeries(series, index);
  const points: EnginePoint[] = [];
  for (let i = 0; i < series.timestamps.length; i++) {
    points.push({
      t: timestampToMillis(series.timestamps[i] ?? 0n, timestampUnit),
      v: finiteOrNull(series.values[i] ?? Number.NaN),
    });
  }
  return points;
}

function applyPointBudget<T>(points: readonly T[], maxPoints: number | undefined): readonly T[] {
  const pointBudget = maxPoints === undefined ? undefined : Math.floor(maxPoints);
  if (pointBudget !== undefined && pointBudget <= 0) {
    return [];
  }
  if (pointBudget === undefined || points.length <= pointBudget) {
    return points;
  }
  return points.slice(points.length - pointBudget);
}

function assertAlignedSeries(series: EngineSeriesResult, index: number): void {
  if (series.timestamps.length !== series.values.length) {
    throw new RangeError(
      `series ${index} has mismatched timestamps (${series.timestamps.length}) and values (${series.values.length})`
    );
  }
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function seriesId(series: EngineSeriesResult, index: number): string {
  const parts = sortedLabelEntries(series.labels).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(",") : `series-${index}`;
}

function seriesLabel(
  series: EngineSeriesResult,
  index: number,
  options: EngineAdapterOptions
): string {
  if (options.seriesLabel) {
    return options.seriesLabel(series, index);
  }
  const name = series.labels.get("__name__") ?? `series-${index}`;
  const labelParts: string[] = [];
  for (const [key, value] of sortedLabelEntries(series.labels)) {
    if (key !== "__name__") {
      labelParts.push(`${key}=${value}`);
    }
  }
  return labelParts.length > 0 ? `${name}{${labelParts.join(",")}}` : name;
}

function sortedLabelEntries(labels: EngineLabels): [string, string][] {
  return [...labels.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function timestampToMillis(timestamp: bigint, unit: EngineTimestampUnit = "nanoseconds"): number {
  const millis = timestampToMillisBigInt(timestamp, unit);
  if (millis > BigInt(Number.MAX_SAFE_INTEGER) || millis < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(
      `timestamp ${timestamp.toString()} cannot be represented safely as milliseconds`
    );
  }
  return Number(millis);
}

function timestampToMillisBigInt(
  timestamp: bigint,
  unit: EngineTimestampUnit = "nanoseconds"
): bigint {
  switch (unit) {
    case "seconds":
      return timestamp * 1_000n;
    case "milliseconds":
      return timestamp;
    case "nanoseconds":
      return timestamp / 1_000_000n;
  }
}
