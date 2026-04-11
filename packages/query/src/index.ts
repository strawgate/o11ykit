import {
  type AttributeMap,
  collectLogRecords as collectOtlpLogs,
  collectMetricPoints as collectOtlpMetrics,
  collectSpans as collectOtlpSpans,
  isLogsDocument,
  isMetricsDocument,
  isTracesDocument,
  type LogRecord,
  type MetricPointRecord,
  nanosToIso,
  nanosToMillis,
  type OtlpEnvelope,
  type OtlpLogsDocument,
  type OtlpMetricsDocument,
  type OtlpTracesDocument,
  type ScopeInfo,
  type SpanRecord,
  type TelemetryRecord,
  toUnixNanos,
} from "@otlpkit/otlpjson";

function compareBigInts(left: bigint, right: bigint): number {
  return Number(left > right) - Number(left < right);
}

export interface FilterOptions {
  readonly signal?: "metrics" | "traces" | "logs";
  readonly from?: unknown;
  readonly to?: unknown;
  readonly resource?: Record<string, unknown>;
  readonly attributes?: Record<string, unknown>;
  readonly scopeName?: unknown;
  readonly scopeVersion?: unknown;
  readonly name?: unknown;
  readonly traceId?: unknown;
  readonly spanId?: unknown;
}

export interface BucketedPoint {
  readonly timeUnixNano: string;
  readonly timeMs: number | null;
  readonly isoTime: string | null;
  readonly value: number;
  readonly samples: number;
}

export interface BucketedSeries {
  readonly key: string;
  readonly label: string;
  readonly points: readonly BucketedPoint[];
}

interface EnvelopeLike {
  readonly signal: string;
  readonly data: unknown;
}

type CollectibleInput =
  | OtlpMetricsDocument
  | OtlpTracesDocument
  | OtlpLogsDocument
  | OtlpEnvelope
  | TelemetryRecord
  | readonly CollectibleInput[];

function isEnvelope(value: unknown): value is EnvelopeLike {
  return Boolean(value && typeof value === "object" && "signal" in value && "data" in value);
}

function isMetricRecord(value: unknown): value is MetricPointRecord {
  return Boolean(
    value && typeof value === "object" && (value as MetricPointRecord).signal === "metrics"
  );
}

function isSpanRecord(value: unknown): value is SpanRecord {
  return Boolean(value && typeof value === "object" && (value as SpanRecord).signal === "traces");
}

function isLogRecord(value: unknown): value is LogRecord {
  return Boolean(value && typeof value === "object" && (value as LogRecord).signal === "logs");
}

export function recordTimestampNanos(record: TelemetryRecord): string | null {
  if (record.signal === "metrics") {
    return record.point.timeUnixNano ?? record.point.startTimeUnixNano;
  }
  if (record.signal === "traces") {
    return record.startTimeUnixNano ?? record.endTimeUnixNano;
  }
  return record.timeUnixNano ?? record.observedTimeUnixNano;
}

export function recordAttributes(record: TelemetryRecord): AttributeMap {
  return record.signal === "metrics" ? record.point.attributes : record.attributes;
}

export function recordName(record: TelemetryRecord): string | null {
  if (record.signal === "metrics") {
    return record.metric.name;
  }
  if (record.signal === "traces") {
    return record.name;
  }
  return null;
}

export function recordScope(record: TelemetryRecord): ScopeInfo {
  return record.scope;
}

export function recordNumericValue(record: TelemetryRecord): number | null {
  if (record.signal === "metrics") {
    switch (record.point.kind) {
      case "number":
        return record.point.value;
      case "histogram":
      case "summary": {
        const count = Number(record.point.count);
        const sum = Number(record.point.sum);
        return count > 0 ? sum / count : null;
      }
      case "exponentialHistogram": {
        const count = Number(record.point.count);
        const sum = Number(record.point.sum);
        return count > 0 ? sum / count : null;
      }
    }
  }
  if (record.signal === "traces") {
    const nanos = toUnixNanos(record.durationNanos);
    return nanos === null ? null : Number(nanos / 1_000_000n);
  }
  return null;
}

function stableObjectString(object: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(object)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = object[key];
        return accumulator;
      }, {})
  );
}

export function defaultSeriesKey(record: TelemetryRecord): string {
  const base = recordName(record) ?? record.signal;
  const attributes = recordAttributes(record);
  if (Object.keys(attributes).length === 0) {
    return base;
  }
  return `${base}:${stableObjectString(attributes)}`;
}

export function defaultSeriesLabel(record: TelemetryRecord): string {
  const base = recordName(record) ?? record.signal;
  const parts = Object.entries(recordAttributes(record)).map(
    ([key, value]) => `${key}=${String(value)}`
  );
  return parts.length === 0 ? base : `${base} (${parts.join(", ")})`;
}

export function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected == null) {
    return true;
  }
  if (expected instanceof RegExp) {
    return typeof actual === "string" && expected.test(actual);
  }
  if (typeof expected === "function") {
    return Boolean(expected(actual));
  }
  if (Array.isArray(expected)) {
    return expected.includes(actual);
  }
  return actual === expected;
}

export function matchesAttributes(
  actual: Record<string, unknown> = {},
  expected: Record<string, unknown> = {}
): boolean {
  return Object.entries(expected).every(([key, value]) => matchesValue(actual[key], value));
}

function materialize(
  input: CollectibleInput | null | undefined,
  signal: "metrics" | "traces" | "logs"
): TelemetryRecord[] {
  if (input == null) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((entry) => materialize(entry, signal));
  }
  if (isEnvelope(input)) {
    return input.signal === signal ? materialize(input.data as CollectibleInput, signal) : [];
  }
  if (signal === "metrics") {
    if (isMetricsDocument(input)) {
      return collectOtlpMetrics(input);
    }
    if (isMetricRecord(input)) {
      return [input];
    }
  }
  if (signal === "traces") {
    if (isTracesDocument(input)) {
      return collectOtlpSpans(input);
    }
    if (isSpanRecord(input)) {
      return [input];
    }
  }
  if (signal === "logs") {
    if (isLogsDocument(input)) {
      return collectOtlpLogs(input);
    }
    if (isLogRecord(input)) {
      return [input];
    }
  }
  return [];
}

export function collectMetrics(input: unknown): MetricPointRecord[] {
  return materialize(
    input as CollectibleInput | null | undefined,
    "metrics"
  ) as MetricPointRecord[];
}

export function collectTraces(input: unknown): SpanRecord[] {
  return materialize(input as CollectibleInput | null | undefined, "traces") as SpanRecord[];
}

export function collectLogs(input: unknown): LogRecord[] {
  return materialize(input as CollectibleInput | null | undefined, "logs") as LogRecord[];
}

export function filterRecords<TRecord extends TelemetryRecord>(
  records: readonly TRecord[],
  options: FilterOptions = {}
): TRecord[] {
  const from = toUnixNanos(options.from);
  const to = toUnixNanos(options.to);
  return records.filter((record) => {
    if (options.signal && record.signal !== options.signal) {
      return false;
    }
    if (options.scopeName != null && !matchesValue(record.scope.name, options.scopeName)) {
      return false;
    }
    if (options.scopeVersion != null && !matchesValue(record.scope.version, options.scopeVersion)) {
      return false;
    }
    if (options.name != null && !matchesValue(recordName(record), options.name)) {
      return false;
    }
    if (
      options.traceId != null &&
      !matchesValue("traceId" in record ? record.traceId : null, options.traceId)
    ) {
      return false;
    }
    if (
      options.spanId != null &&
      !matchesValue("spanId" in record ? record.spanId : null, options.spanId)
    ) {
      return false;
    }
    if (options.resource && !matchesAttributes(record.resource, options.resource)) {
      return false;
    }
    if (options.attributes && !matchesAttributes(recordAttributes(record), options.attributes)) {
      return false;
    }
    const timestamp = toUnixNanos(recordTimestampNanos(record));
    if (from !== null && timestamp !== null && timestamp < from) {
      return false;
    }
    if (to !== null && timestamp !== null && timestamp > to) {
      return false;
    }
    return true;
  });
}

export function groupBy<TRecord extends TelemetryRecord>(
  records: readonly TRecord[],
  keyFn: (record: TRecord) => string
): Map<string, TRecord[]> {
  const groups = new Map<string, TRecord[]>();
  for (const record of records) {
    const key = keyFn(record);
    const existing = groups.get(key);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return groups;
}

export function latestBy<TRecord extends TelemetryRecord>(
  records: readonly TRecord[],
  keyFn: (record: TRecord) => string
): Array<{ readonly key: string; readonly record: TRecord }> {
  const latest = new Map<string, TRecord>();
  for (const record of records) {
    const key = keyFn(record);
    const timestamp = toUnixNanos(recordTimestampNanos(record)) ?? 0n;
    const current = latest.get(key);
    const currentTimestamp = current ? (toUnixNanos(recordTimestampNanos(current)) ?? 0n) : null;
    if (!current || currentTimestamp === null || timestamp > currentTimestamp) {
      latest.set(key, record);
    }
  }
  return [...latest.entries()].map(([key, record]) => ({ key, record }));
}

function reduceBucket(
  values: readonly {
    readonly value: number;
  }[],
  reduce: "sum" | "avg" | "min" | "max" | "last" | "count"
): number {
  if (reduce === "count") {
    return values.length;
  }
  if (reduce === "last") {
    return (values[values.length - 1] as { readonly value: number }).value;
  }
  if (reduce === "min") {
    return values.reduce(
      (minimum, current) => Math.min(minimum, current.value),
      Number.POSITIVE_INFINITY
    );
  }
  if (reduce === "max") {
    return values.reduce(
      (maximum, current) => Math.max(maximum, current.value),
      Number.NEGATIVE_INFINITY
    );
  }
  const total = values.reduce((sum, current) => sum + current.value, 0);
  return reduce === "avg" ? total / values.length : total;
}

export function bucketTimeSeries<TRecord extends TelemetryRecord>(
  records: readonly TRecord[],
  options: {
    readonly intervalMs?: number;
    readonly keyFn?: (record: TRecord) => string;
    readonly labelFn?: (record: TRecord, key: string) => string;
    readonly valueFn?: (record: TRecord) => number | null;
    readonly reduce?: "sum" | "avg" | "min" | "max" | "last" | "count";
    readonly timeFn?: (record: TRecord) => string | null;
  } = {}
): BucketedSeries[] {
  const intervalMs = options.intervalMs ?? 60_000;
  const intervalNs = BigInt(intervalMs) * 1_000_000n;
  const keyFn = options.keyFn ?? defaultSeriesKey;
  const labelFn = options.labelFn ?? ((record) => defaultSeriesLabel(record));
  const valueFn = options.valueFn ?? recordNumericValue;
  const timeFn = options.timeFn ?? recordTimestampNanos;
  const reduce = options.reduce ?? "sum";
  const seriesMap = new Map<
    string,
    {
      readonly key: string;
      readonly label: string;
      readonly buckets: Map<string, { readonly value: number }[]>;
    }
  >();

  for (const record of records) {
    const value = valueFn(record);
    const timestamp = toUnixNanos(timeFn(record));
    if (value === null || !Number.isFinite(value) || timestamp === null) {
      continue;
    }
    const bucketStart = (timestamp / intervalNs) * intervalNs;
    const key = keyFn(record);
    const label = labelFn(record, key);
    const series =
      seriesMap.get(key) ??
      (() => {
        const created = {
          key,
          label,
          buckets: new Map<string, { readonly value: number }[]>(),
        };
        seriesMap.set(key, created);
        return created;
      })();

    const bucketKey = bucketStart.toString();
    const bucketValues = series.buckets.get(bucketKey) ?? [];
    bucketValues.push({ value });
    series.buckets.set(bucketKey, bucketValues);
  }

  return [...seriesMap.values()].map((series) => ({
    key: series.key,
    label: series.label,
    points: [...series.buckets.entries()]
      .sort(([left], [right]) => compareBigInts(BigInt(left), BigInt(right)))
      .map(([timeUnixNano, values]) => ({
        timeUnixNano,
        timeMs: nanosToMillis(timeUnixNano),
        isoTime: nanosToIso(timeUnixNano),
        value: reduceBucket(values, reduce),
        samples: values.length,
      })),
  }));
}
