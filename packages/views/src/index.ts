import {
  type AttributeMap,
  durationNanos,
  nanosToIso,
  nanosToMillis,
  type ScopeInfo,
  type Signal,
  type SpanRecord,
  type TelemetryRecord,
  toUnixNanos,
} from "@otlpkit/otlpjson";
import {
  bucketTimeSeries,
  collectLogs,
  collectMetrics,
  collectTraces,
  defaultSeriesKey,
  defaultSeriesLabel,
  filterRecords,
  latestBy,
  recordAttributes,
  recordNumericValue,
  recordTimestampNanos,
} from "@otlpkit/query";

export interface TimeSeriesPoint {
  readonly timeUnixNano: string;
  readonly timeMs: number | null;
  readonly isoTime: string | null;
  readonly value: number;
  readonly samples: number;
}

export interface TimeSeriesSeries {
  readonly key: string;
  readonly label: string;
  readonly points: readonly TimeSeriesPoint[];
}

export interface TimeSeriesFrame {
  readonly kind: "time-series";
  readonly signal: Signal | null;
  readonly title: string;
  readonly unit: string | null;
  readonly intervalMs: number;
  readonly series: readonly TimeSeriesSeries[];
}

export interface TimeSeriesFrameOptions {
  readonly signal?: Signal;
  readonly title?: string;
  readonly metricName?: string;
  readonly name?: string;
  readonly intervalMs?: number;
  readonly splitBy?: string;
  readonly reduce?: "sum" | "avg" | "min" | "max" | "last" | "count";
  readonly filters?: Record<string, unknown>;
  readonly valueFn?: (record: TelemetryRecord) => number | null;
  readonly unit?: string;
}

export interface MergeTimeSeriesFramesOptions {
  /**
   * When two points share the same series key and timestamp:
   * - "replace" (default): use incoming point
   * - "keep-existing": keep existing point
   */
  readonly onConflict?: "replace" | "keep-existing";
}


export interface LatestValueRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly timeUnixNano: string | null;
  readonly timeMs: number | null;
  readonly isoTime: string | null;
  readonly attributes: AttributeMap;
  readonly resource: AttributeMap;
  readonly scope: ScopeInfo;
}

export interface LatestValuesFrame {
  readonly kind: "latest-values";
  readonly signal: Signal | null;
  readonly title: string;
  readonly unit: string | null;
  readonly rows: readonly LatestValueRow[];
}

export interface LatestValuesFrameOptions {
  readonly signal?: Signal;
  readonly title?: string;
  readonly metricName?: string;
  readonly name?: string;
  readonly splitBy?: string;
  readonly filters?: Record<string, unknown>;
  readonly valueFn?: (record: TelemetryRecord) => number | null;
  readonly unit?: string;
}

export interface HistogramBin {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly count: number;
}

export interface HistogramFrame {
  readonly kind: "histogram";
  readonly signal: Signal | null;
  readonly title: string;
  readonly unit: string | null;
  readonly bins: readonly HistogramBin[];
}

export interface HistogramFrameOptions {
  readonly signal?: Signal;
  readonly title?: string;
  readonly metricName?: string;
  readonly name?: string;
  readonly filters?: Record<string, unknown>;
  readonly valueFn?: (record: TelemetryRecord) => number | null;
  readonly unit?: string;
  readonly binCount?: number;
}

export interface TraceWaterfallSpan {
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
  readonly name: string | null;
  readonly status: SpanRecord["status"];
  readonly depth: number;
  readonly startOffsetNanos: string | null;
  readonly startOffsetMs: number | null;
  readonly durationNanos: string | null;
  readonly durationMs: number | null;
  readonly attributes: AttributeMap;
  readonly events: SpanRecord["events"];
}

export interface TraceWaterfallTrace {
  readonly traceId: string;
  readonly traceStartUnixNano: string | null;
  readonly traceEndUnixNano: string | null;
  readonly durationNanos: string | null;
  readonly spans: readonly TraceWaterfallSpan[];
}

export interface TraceWaterfallFrame {
  readonly kind: "trace-waterfall";
  readonly signal: "traces";
  readonly title: string;
  readonly traces: readonly TraceWaterfallTrace[];
}

export interface TraceWaterfallFrameOptions {
  readonly title?: string;
  readonly filters?: Record<string, unknown>;
}

export interface EventTimelineEvent {
  readonly kind: "span-event" | "log";
  readonly timeUnixNano: string | null;
  readonly timeMs: number | null;
  readonly isoTime: string | null;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly name?: string | null;
  readonly severityText?: string | null;
  readonly body?: unknown;
  readonly attributes: AttributeMap;
  readonly resource: AttributeMap;
  readonly scope: ScopeInfo;
}

export interface EventTimelineFrame {
  readonly kind: "event-timeline";
  readonly signal: "traces" | "logs";
  readonly title: string;
  readonly events: readonly EventTimelineEvent[];
}

export interface EventTimelineFrameOptions {
  readonly signal?: "traces" | "logs";
  readonly title?: string;
  readonly filters?: Record<string, unknown>;
}

export interface TelemetryStoreOptions {
  readonly maxPoints?: number;
  readonly maxAgeMs?: number;
}

export interface TelemetryStoreIngestSummary {
  readonly metrics: number;
  readonly traces: number;
  readonly logs: number;
  readonly total: number;
}

export interface TelemetryStoreSize extends TelemetryStoreIngestSummary {}

export interface TelemetryStore {
  ingest(input: unknown): TelemetryStoreIngestSummary;
  size(): TelemetryStoreSize;
  clear(): void;
  selectTimeSeries(options?: TimeSeriesFrameOptions): TimeSeriesFrame;
  selectLatestValues(options?: LatestValuesFrameOptions): LatestValuesFrame;
  selectHistogram(options?: HistogramFrameOptions): HistogramFrame;
  selectTraceWaterfall(options?: TraceWaterfallFrameOptions): TraceWaterfallFrame;
  selectEventTimeline(options?: EventTimelineFrameOptions): EventTimelineFrame;
}

function materialize(
  input: unknown,
  signal?: Signal
): { readonly signal: Signal | null; readonly records: TelemetryRecord[] } {
  if (signal === "metrics") {
    return { signal, records: collectMetrics(input) };
  }
  if (signal === "traces") {
    return { signal, records: collectTraces(input) };
  }
  if (signal === "logs") {
    return { signal, records: collectLogs(input) };
  }
  const metrics = collectMetrics(input);
  if (metrics.length > 0) {
    return { signal: "metrics", records: metrics };
  }
  const traces = collectTraces(input);
  if (traces.length > 0) {
    return { signal: "traces", records: traces };
  }
  const logs = collectLogs(input);
  if (logs.length > 0) {
    return { signal: "logs", records: logs };
  }
  return { signal: null, records: [] };
}

function projectSeriesKey(record: TelemetryRecord, splitBy?: string): string {
  if (!splitBy) {
    return defaultSeriesKey(record);
  }
  if (splitBy.startsWith("resource.")) {
    return String(record.resource[splitBy.slice("resource.".length)] ?? "unknown");
  }
  if (splitBy.startsWith("scope.")) {
    return String(record.scope[splitBy.slice("scope.".length) as keyof ScopeInfo] ?? "unknown");
  }
  return String(recordAttributes(record)[splitBy] ?? "unknown");
}

function projectSeriesLabel(record: TelemetryRecord, splitBy?: string): string {
  return splitBy ? projectSeriesKey(record, splitBy) : defaultSeriesLabel(record);
}

function inferUnit(records: readonly TelemetryRecord[]): string | null {
  const first = records[0];
  if (!first) {
    return null;
  }
  if (first.signal === "traces") {
    return "ms";
  }
  if (first.signal === "metrics") {
    return first.metric.unit;
  }
  return null;
}

function latestRows(
  records: readonly TelemetryRecord[],
  splitBy?: string,
  valueFn?: (record: TelemetryRecord) => number | null
): LatestValueRow[] {
  return latestBy(records, (record) => projectSeriesKey(record, splitBy))
    .map(({ key, record }) => ({
      key,
      label: projectSeriesLabel(record, splitBy),
      value: valueFn ? valueFn(record) : recordNumericValue(record),
      timeUnixNano: recordTimestampNanos(record),
      timeMs: nanosToMillis(recordTimestampNanos(record)),
      isoTime: nanosToIso(recordTimestampNanos(record)),
      attributes: recordAttributes(record),
      resource: record.resource,
      scope: record.scope,
    }))
    .filter((row): row is LatestValueRow => Number.isFinite(row.value));
}

function computeDepths(spans: readonly SpanRecord[]): Map<string, number> {
  const byId = new Map(
    spans.flatMap((span) => (span.spanId ? [[span.spanId, span] as const] : []))
  );
  const depths = new Map<string, number>();

  const visit = (span: SpanRecord): number => {
    if (!span.spanId) {
      return 0;
    }
    const existing = depths.get(span.spanId);
    if (existing !== undefined) {
      return existing;
    }
    // Write a sentinel before recursing to break cycles.
    depths.set(span.spanId, 0);
    const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
    const depth = parent ? visit(parent) + 1 : 0;
    depths.set(span.spanId, depth);
    return depth;
  };

  for (const span of spans) {
    visit(span);
  }

  return depths;
}

export function buildTimeSeriesFrame(
  input: unknown,
  options: TimeSeriesFrameOptions = {}
): TimeSeriesFrame {
  const { signal, records } = materialize(input, options.signal);
  const filters = {
    ...(options.filters ?? {}),
    ...(options.metricName || options.name ? { name: options.metricName ?? options.name } : {}),
  };
  const filtered = filterRecords(records, filters);
  const intervalMs = options.intervalMs ?? 60_000;
  const series = bucketTimeSeries(filtered, {
    intervalMs,
    reduce: options.reduce ?? "sum",
    keyFn: (record) => projectSeriesKey(record, options.splitBy),
    labelFn: (record) => projectSeriesLabel(record, options.splitBy),
    ...(options.valueFn ? { valueFn: options.valueFn } : {}),
  });

  return {
    kind: "time-series",
    signal,
    title: options.title ?? options.metricName ?? options.name ?? "Telemetry",
    unit: options.unit ?? inferUnit(filtered),
    intervalMs,
    series,
  };
}

function mergeSeriesPoints(
  existing: readonly TimeSeriesPoint[],
  incoming: readonly TimeSeriesPoint[],
  onConflict: "replace" | "keep-existing"
): TimeSeriesPoint[] {
  const byTime = new Map<string, TimeSeriesPoint>();
  for (const point of existing) {
    byTime.set(point.timeUnixNano, point);
  }
  for (const point of incoming) {
    if (onConflict === "keep-existing" && byTime.has(point.timeUnixNano)) {
      continue;
    }
    byTime.set(point.timeUnixNano, point);
  }
  return [...byTime.values()].sort((left, right) => {
    const leftNanos = toUnixNanos(left.timeUnixNano) ?? 0n;
    const rightNanos = toUnixNanos(right.timeUnixNano) ?? 0n;
    return Number(leftNanos > rightNanos) - Number(leftNanos < rightNanos);
  });
}

/**
 * Merge two time-series frames (typically "existing history" + "new slice").
 * Inputs should be built with compatible frame options (same metric/split/reduce/interval).
 */
export function mergeTimeSeriesFrames(
  existing: TimeSeriesFrame,
  incoming: TimeSeriesFrame,
  options: MergeTimeSeriesFramesOptions = {}
): TimeSeriesFrame {
  const onConflict = options.onConflict ?? "replace";
  const mergedByKey = new Map<string, TimeSeriesSeries>();

  for (const series of existing.series) {
    mergedByKey.set(series.key, {
      key: series.key,
      label: series.label,
      points: [...series.points],
    });
  }

  for (const series of incoming.series) {
    const prior = mergedByKey.get(series.key);
    if (!prior) {
      mergedByKey.set(series.key, {
        key: series.key,
        label: series.label,
        points: [...series.points],
      });
      continue;
    }
    mergedByKey.set(series.key, {
      key: series.key,
      label: prior.label,
      points: mergeSeriesPoints(prior.points, series.points, onConflict),
    });
  }

  return {
    kind: "time-series",
    signal: existing.signal === null ? incoming.signal : existing.signal,
    title: existing.title,
    unit: existing.unit ?? incoming.unit,
    intervalMs: existing.intervalMs,
    series: [...mergedByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

/**
 * Build a frame from newly arrived data and merge it into an existing frame.
 */
export function appendTimeSeriesFrame(
  existing: TimeSeriesFrame,
  incomingInput: unknown,
  frameOptions: TimeSeriesFrameOptions = {},
  mergeOptions: MergeTimeSeriesFramesOptions = {}
): TimeSeriesFrame {
  const effectiveFrameOptions: TimeSeriesFrameOptions = {
    ...frameOptions,
    title: frameOptions.title ?? existing.title,
    intervalMs: frameOptions.intervalMs ?? existing.intervalMs,
    ...(frameOptions.signal !== undefined
      ? { signal: frameOptions.signal }
      : existing.signal !== null
        ? { signal: existing.signal }
        : {}),
    ...(frameOptions.unit !== undefined
      ? { unit: frameOptions.unit }
      : existing.unit !== null
        ? { unit: existing.unit }
        : {}),
  };
  const incoming = buildTimeSeriesFrame(incomingInput, effectiveFrameOptions);
  return mergeTimeSeriesFrames(existing, incoming, mergeOptions);
}

export function buildLatestValuesFrame(
  input: unknown,
  options: LatestValuesFrameOptions = {}
): LatestValuesFrame {
  const { signal, records } = materialize(input, options.signal);
  const filters = {
    ...(options.filters ?? {}),
    ...(options.metricName || options.name ? { name: options.metricName ?? options.name } : {}),
  };
  const filtered = filterRecords(records, filters);

  return {
    kind: "latest-values",
    signal,
    title: options.title ?? options.metricName ?? options.name ?? "Latest values",
    unit: options.unit ?? inferUnit(filtered),
    rows: latestRows(filtered, options.splitBy, options.valueFn),
  };
}

export function buildHistogramFrame(
  input: unknown,
  options: HistogramFrameOptions = {}
): HistogramFrame {
  const { signal, records } = materialize(input, options.signal);
  const filters = {
    ...(options.filters ?? {}),
    ...(options.metricName || options.name ? { name: options.metricName ?? options.name } : {}),
  };
  const filtered = filterRecords(records, filters);
  const values = filtered
    .map((record) => (options.valueFn ?? recordNumericValue)(record))
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (values.length === 0) {
    return {
      kind: "histogram",
      signal,
      title: options.title ?? options.metricName ?? options.name ?? "Histogram",
      unit: options.unit ?? inferUnit(filtered),
      bins: [],
    };
  }

  const minimum = values.reduce((a, b) => Math.min(a, b), Infinity);
  const maximum = values.reduce((a, b) => Math.max(a, b), -Infinity);
  const binCount = Math.max(1, options.binCount ?? 10);
  const width = minimum === maximum ? 1 : (maximum - minimum) / binCount;
  const counts = Array.from({ length: binCount }, () => 0);

  for (const value of values) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - minimum) / width)));
    counts[index] = (counts[index] as number) + 1;
  }

  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => {
    const start = minimum + width * index;
    const end = index === binCount - 1 ? maximum : start + width;
    return {
      start,
      end,
      label: `${start.toFixed(2)} - ${end.toFixed(2)}`,
      count: counts[index] as number,
    };
  });

  return {
    kind: "histogram",
    signal,
    title: options.title ?? options.metricName ?? options.name ?? "Histogram",
    unit: options.unit ?? inferUnit(filtered),
    bins,
  };
}

export function buildTraceWaterfallFrame(
  input: unknown,
  options: TraceWaterfallFrameOptions = {}
): TraceWaterfallFrame {
  const filtered = filterRecords(collectTraces(input), options.filters ?? {});
  const traces = new Map<string, SpanRecord[]>();

  for (const span of filtered) {
    const traceId = span.traceId ?? "unknown";
    const current = traces.get(traceId) ?? [];
    current.push(span);
    traces.set(traceId, current);
  }

  return {
    kind: "trace-waterfall",
    signal: "traces",
    title: options.title ?? "Trace waterfall",
    traces: [...traces.entries()].map(([traceId, spans]) => {
      const sorted = [...spans].sort((left, right) => {
        const a = toUnixNanos(left.startTimeUnixNano) ?? 0n;
        const b = toUnixNanos(right.startTimeUnixNano) ?? 0n;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const traceStart = sorted[0]?.startTimeUnixNano ?? null;
      const traceEnd =
        sorted.reduce<string | null>((latest, span) => {
          const end = toUnixNanos(span.endTimeUnixNano) ?? 0n;
          const latestEnd = toUnixNanos(latest) ?? 0n;
          return end > latestEnd ? span.endTimeUnixNano : latest;
        }, traceStart) ?? null;
      const depths = computeDepths(sorted);
      const traceStartNanos = toUnixNanos(traceStart);
      return {
        traceId,
        traceStartUnixNano: traceStart,
        traceEndUnixNano: traceEnd,
        durationNanos: durationNanos(traceStart, traceEnd),
        spans: sorted.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          status: span.status,
          depth: span.spanId ? (depths.get(span.spanId) as number) : 0,
          startOffsetNanos: (() => {
            const spanStart = toUnixNanos(span.startTimeUnixNano);
            if (traceStartNanos === null || spanStart === null) {
              return null;
            }
            return (spanStart - traceStartNanos).toString();
          })(),
          startOffsetMs: (() => {
            const spanStart = toUnixNanos(span.startTimeUnixNano);
            if (traceStartNanos === null || spanStart === null) {
              return null;
            }
            return Number((spanStart - traceStartNanos) / 1_000_000n);
          })(),
          durationNanos: span.durationNanos,
          durationMs: nanosToMillis(span.durationNanos),
          attributes: span.attributes,
          events: span.events,
        })),
      };
    }),
  };
}

export function buildEventTimelineFrame(
  input: unknown,
  options: EventTimelineFrameOptions = {}
): EventTimelineFrame {
  if (options.signal === "logs") {
    const logs = filterRecords(collectLogs(input), options.filters ?? {});
    return {
      kind: "event-timeline",
      signal: "logs",
      title: options.title ?? "Log events",
      events: logs
        .map(
          (log): EventTimelineEvent => ({
            kind: "log",
            timeUnixNano: log.timeUnixNano,
            timeMs: nanosToMillis(log.timeUnixNano),
            isoTime: nanosToIso(log.timeUnixNano),
            severityText: log.severityText,
            traceId: log.traceId,
            spanId: log.spanId,
            body: log.body,
            attributes: log.attributes,
            resource: log.resource,
            scope: log.scope,
          })
        )
        .sort((left, right) => {
          const a = toUnixNanos(left.timeUnixNano) ?? 0n;
          const b = toUnixNanos(right.timeUnixNano) ?? 0n;
          return a < b ? -1 : a > b ? 1 : 0;
        }),
    };
  }

  const spans = filterRecords(collectTraces(input), options.filters ?? {});
  const events = spans.flatMap((span) =>
    span.events.map(
      (event): EventTimelineEvent => ({
        kind: "span-event",
        timeUnixNano: event.timeUnixNano,
        timeMs: nanosToMillis(event.timeUnixNano),
        isoTime: nanosToIso(event.timeUnixNano),
        traceId: span.traceId,
        spanId: span.spanId,
        name: event.name,
        attributes: event.attributes,
        resource: span.resource,
        scope: span.scope,
      })
    )
  );

  return {
    kind: "event-timeline",
    signal: "traces",
    title: options.title ?? "Trace events",
    events: events.sort((left, right) => {
      const a = toUnixNanos(left.timeUnixNano) ?? 0n;
      const b = toUnixNanos(right.timeUnixNano) ?? 0n;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  };
}

function validateStoreOptions(options: TelemetryStoreOptions): void {
  if (options.maxPoints !== undefined) {
    if (!Number.isInteger(options.maxPoints) || options.maxPoints < 1) {
      throw new Error("maxPoints must be a positive integer when provided.");
    }
  }
  if (options.maxAgeMs !== undefined) {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs <= 0) {
      throw new Error("maxAgeMs must be a positive number when provided.");
    }
  }
}

function pruneByMaxAge(
  records: TelemetryRecord[],
  maxAgeMs: number | undefined
): TelemetryRecord[] {
  if (maxAgeMs === undefined || records.length === 0) {
    return records;
  }
  let newest: bigint | null = null;
  for (const record of records) {
    const timestamp = toUnixNanos(recordTimestampNanos(record));
    if (timestamp === null) {
      continue;
    }
    if (newest === null || timestamp > newest) {
      newest = timestamp;
    }
  }
  if (newest === null) {
    return records;
  }
  const maxAgeNanos = BigInt(Math.floor(maxAgeMs * 1_000_000));
  const cutoff = newest - maxAgeNanos;
  return records.filter((record) => {
    const timestamp = toUnixNanos(recordTimestampNanos(record));
    return timestamp === null || timestamp >= cutoff;
  });
}

function pruneByMaxPoints(
  records: TelemetryRecord[],
  maxPoints: number | undefined
): TelemetryRecord[] {
  if (maxPoints === undefined || records.length <= maxPoints) {
    return records;
  }
  return records.slice(records.length - maxPoints);
}

function applyRetention(
  records: TelemetryRecord[],
  options: TelemetryStoreOptions
): TelemetryRecord[] {
  return pruneByMaxPoints(pruneByMaxAge(records, options.maxAgeMs), options.maxPoints);
}

export function createTelemetryStore(options: TelemetryStoreOptions = {}): TelemetryStore {
  validateStoreOptions(options);

  let metricRecords: TelemetryRecord[] = [];
  let traceRecords: TelemetryRecord[] = [];
  let logRecords: TelemetryRecord[] = [];

  const snapshot = (): readonly [
    readonly TelemetryRecord[],
    readonly TelemetryRecord[],
    readonly TelemetryRecord[],
  ] => [metricRecords, traceRecords, logRecords];

  return {
    ingest(input: unknown): TelemetryStoreIngestSummary {
      const nextMetrics = collectMetrics(input);
      const nextTraces = collectTraces(input);
      const nextLogs = collectLogs(input);

      metricRecords = applyRetention([...metricRecords, ...nextMetrics], options);
      traceRecords = applyRetention([...traceRecords, ...nextTraces], options);
      logRecords = applyRetention([...logRecords, ...nextLogs], options);

      return {
        metrics: nextMetrics.length,
        traces: nextTraces.length,
        logs: nextLogs.length,
        total: nextMetrics.length + nextTraces.length + nextLogs.length,
      };
    },

    size(): TelemetryStoreSize {
      return {
        metrics: metricRecords.length,
        traces: traceRecords.length,
        logs: logRecords.length,
        total: metricRecords.length + traceRecords.length + logRecords.length,
      };
    },

    clear(): void {
      metricRecords = [];
      traceRecords = [];
      logRecords = [];
    },

    selectTimeSeries(frameOptions: TimeSeriesFrameOptions = {}): TimeSeriesFrame {
      return buildTimeSeriesFrame(snapshot(), frameOptions);
    },

    selectLatestValues(frameOptions: LatestValuesFrameOptions = {}): LatestValuesFrame {
      return buildLatestValuesFrame(snapshot(), frameOptions);
    },

    selectHistogram(frameOptions: HistogramFrameOptions = {}): HistogramFrame {
      return buildHistogramFrame(snapshot(), frameOptions);
    },

    selectTraceWaterfall(frameOptions: TraceWaterfallFrameOptions = {}): TraceWaterfallFrame {
      return buildTraceWaterfallFrame(snapshot(), frameOptions);
    },

    selectEventTimeline(frameOptions: EventTimelineFrameOptions = {}): EventTimelineFrame {
      return buildEventTimelineFrame(snapshot(), frameOptions);
    },
  };
}
