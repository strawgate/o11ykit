export const SIGNALS = ["metrics", "traces", "logs"] as const;

export type Signal = (typeof SIGNALS)[number];
export type PrimitiveAttributeValue = string | number | boolean | null;

export interface AttributeObject {
  readonly [key: string]: AttributeValue;
}

export type AttributeValue = PrimitiveAttributeValue | AttributeValue[] | AttributeObject;
export type AttributeMap = Record<string, AttributeValue>;

export interface ScopeInfo {
  readonly name: string | null;
  readonly version: string | null;
  readonly attributes: AttributeMap;
}

export interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
  readonly bytesValue?: string;
  readonly arrayValue?: {
    readonly values?: readonly OtlpAnyValue[];
  };
  readonly kvlistValue?: {
    readonly values?: readonly OtlpKeyValue[];
  };
}

export interface OtlpKeyValue {
  readonly key: string;
  readonly value?: OtlpAnyValue;
}

export interface OtlpEnvelope<TDocument extends OtlpDocument = OtlpDocument> {
  readonly signal: Signal;
  readonly data: TDocument;
  readonly receivedAt: string;
  readonly source: string | null;
}

export interface MetricInfo {
  readonly name: string;
  readonly description: string | null;
  readonly unit: string | null;
  readonly kind: "gauge" | "sum" | "histogram" | "summary" | "exponentialHistogram";
  readonly aggregationTemporality: number | null;
  readonly isMonotonic: boolean | null;
}

export interface ExemplarRecord {
  readonly filteredAttributes: AttributeMap;
  readonly timeUnixNano: string | null;
  readonly spanId: string | null;
  readonly traceId: string | null;
  readonly value: number | null;
}

interface BasePointRecord {
  readonly startTimeUnixNano: string | null;
  readonly timeUnixNano: string | null;
  readonly attributes: AttributeMap;
  readonly exemplars: readonly ExemplarRecord[];
}

export interface NumberPointRecord extends BasePointRecord {
  readonly kind: "number";
  readonly value: number | null;
}

export interface HistogramPointRecord extends BasePointRecord {
  readonly kind: "histogram";
  readonly count: number | null;
  readonly sum: number | null;
  readonly bucketCounts: readonly number[];
  readonly explicitBounds: readonly number[];
  readonly min: number | null;
  readonly max: number | null;
}

export interface SummaryPointRecord extends BasePointRecord {
  readonly kind: "summary";
  readonly count: number | null;
  readonly sum: number | null;
  readonly quantileValues: readonly {
    readonly quantile: number | null;
    readonly value: number | null;
  }[];
}

export interface ExponentialHistogramPointRecord extends BasePointRecord {
  readonly kind: "exponentialHistogram";
  readonly count: number | null;
  readonly sum: number | null;
  readonly scale: number | null;
  readonly zeroCount: number | null;
  readonly positive: {
    readonly offset: number | null;
    readonly bucketCounts: readonly number[];
  };
  readonly negative: {
    readonly offset: number | null;
    readonly bucketCounts: readonly number[];
  };
}

export type MetricPoint =
  | NumberPointRecord
  | HistogramPointRecord
  | SummaryPointRecord
  | ExponentialHistogramPointRecord;

export interface MetricPointRecord {
  readonly signal: "metrics";
  readonly resource: AttributeMap;
  readonly scope: ScopeInfo;
  readonly metric: MetricInfo;
  readonly point: MetricPoint;
}

export interface MetricScopeVisitContext {
  readonly resource: AttributeMap;
  readonly scope: ScopeInfo;
}

export interface MetricPointVisitContext extends MetricScopeVisitContext {
  readonly metric: MetricInfo;
}

export interface MetricScopeRawVisitContext {
  readonly resourceAttributes: readonly OtlpKeyValue[] | undefined;
  readonly scopeName: string | null;
  readonly scopeVersion: string | null;
  readonly scopeAttributes: readonly OtlpKeyValue[] | undefined;
}

export interface MetricPointRawVisitContext extends MetricScopeRawVisitContext {
  readonly metric: MetricInfo;
}

export interface MetricPointVisitor {
  onScope?(context: MetricScopeVisitContext): void;
  onNumberDataPoints?(
    context: MetricPointVisitContext,
    points: readonly OtlpNumberDataPoint[]
  ): void;
  onHistogramDataPoints?(
    context: MetricPointVisitContext,
    points: readonly OtlpHistogramDataPoint[]
  ): void;
  onSummaryDataPoints?(
    context: MetricPointVisitContext,
    points: readonly OtlpSummaryDataPoint[]
  ): void;
  onExponentialHistogramDataPoints?(
    context: MetricPointVisitContext,
    points: readonly OtlpExponentialHistogramDataPoint[]
  ): void;
}

export interface MetricPointRawVisitor {
  onScope?(context: MetricScopeRawVisitContext): void;
  onNumberDataPoints?(
    context: MetricPointRawVisitContext,
    points: readonly OtlpNumberDataPoint[]
  ): void;
  onHistogramDataPoints?(
    context: MetricPointRawVisitContext,
    points: readonly OtlpHistogramDataPoint[]
  ): void;
  onSummaryDataPoints?(
    context: MetricPointRawVisitContext,
    points: readonly OtlpSummaryDataPoint[]
  ): void;
  onExponentialHistogramDataPoints?(
    context: MetricPointRawVisitContext,
    points: readonly OtlpExponentialHistogramDataPoint[]
  ): void;
}

export interface SpanEventRecord {
  readonly timeUnixNano: string | null;
  readonly isoTime: string | null;
  readonly name: string | null;
  readonly attributes: AttributeMap;
  readonly droppedAttributesCount: number;
}

export interface SpanLinkRecord {
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly attributes: AttributeMap;
}

export interface SpanRecord {
  readonly signal: "traces";
  readonly resource: AttributeMap;
  readonly scope: ScopeInfo;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
  readonly name: string | null;
  readonly kind: number | null;
  readonly startTimeUnixNano: string | null;
  readonly endTimeUnixNano: string | null;
  readonly durationNanos: string | null;
  readonly status: {
    readonly code: number;
    readonly message: string | null;
  };
  readonly attributes: AttributeMap;
  readonly events: readonly SpanEventRecord[];
  readonly links: readonly SpanLinkRecord[];
}

export interface LogRecord {
  readonly signal: "logs";
  readonly resource: AttributeMap;
  readonly scope: ScopeInfo;
  readonly timeUnixNano: string | null;
  readonly observedTimeUnixNano: string | null;
  readonly severityNumber: number | null;
  readonly severityText: string | null;
  readonly body: AttributeValue;
  readonly attributes: AttributeMap;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly flags: number | null;
}

export type TelemetryRecord = MetricPointRecord | SpanRecord | LogRecord;

export interface OtlpScopeMetrics {
  readonly scope?: {
    readonly name?: string;
    readonly version?: string;
    readonly attributes?: readonly OtlpKeyValue[];
  };
  readonly metrics?: readonly OtlpMetric[];
}

export interface OtlpMetric {
  readonly name: string;
  readonly description?: string;
  readonly unit?: string;
  readonly gauge?: {
    readonly dataPoints?: readonly OtlpNumberDataPoint[];
  };
  readonly sum?: {
    readonly aggregationTemporality?: number;
    readonly isMonotonic?: boolean;
    readonly dataPoints?: readonly OtlpNumberDataPoint[];
  };
  readonly histogram?: {
    readonly aggregationTemporality?: number;
    readonly dataPoints?: readonly OtlpHistogramDataPoint[];
  };
  readonly summary?: {
    readonly dataPoints?: readonly OtlpSummaryDataPoint[];
  };
  readonly exponentialHistogram?: {
    readonly aggregationTemporality?: number;
    readonly dataPoints?: readonly OtlpExponentialHistogramDataPoint[];
  };
}

interface OtlpBasePoint {
  readonly startTimeUnixNano?: string | number;
  readonly timeUnixNano?: string | number;
  readonly attributes?: readonly OtlpKeyValue[];
  readonly exemplars?: readonly OtlpExemplar[];
}

export interface OtlpNumberDataPoint extends OtlpBasePoint {
  readonly asDouble?: number;
  readonly asInt?: string | number;
}

export interface OtlpHistogramDataPoint extends OtlpBasePoint {
  readonly count?: string | number;
  readonly sum?: number;
  readonly bucketCounts?: readonly (string | number)[];
  readonly explicitBounds?: readonly number[];
  readonly min?: number;
  readonly max?: number;
}

export interface OtlpSummaryDataPoint extends OtlpBasePoint {
  readonly count?: string | number;
  readonly sum?: number;
  readonly quantileValues?: readonly {
    readonly quantile?: number;
    readonly value?: number;
  }[];
}

export interface OtlpExponentialHistogramDataPoint extends OtlpBasePoint {
  readonly count?: string | number;
  readonly sum?: number;
  readonly scale?: string | number;
  readonly zeroCount?: string | number;
  readonly positive?: {
    readonly offset?: string | number;
    readonly bucketCounts?: readonly (string | number)[];
  };
  readonly negative?: {
    readonly offset?: string | number;
    readonly bucketCounts?: readonly (string | number)[];
  };
}

export interface OtlpExemplar {
  readonly filteredAttributes?: readonly OtlpKeyValue[];
  readonly timeUnixNano?: string | number;
  readonly spanId?: string;
  readonly traceId?: string;
  readonly asDouble?: number;
  readonly asInt?: string | number;
}

export interface OtlpMetricsDocument {
  readonly resourceMetrics: readonly {
    readonly resource?: {
      readonly attributes?: readonly OtlpKeyValue[];
    };
    readonly scopeMetrics?: readonly OtlpScopeMetrics[];
  }[];
}

export interface OtlpTracesDocument {
  readonly resourceSpans: readonly {
    readonly resource?: {
      readonly attributes?: readonly OtlpKeyValue[];
    };
    readonly scopeSpans?: readonly {
      readonly scope?: {
        readonly name?: string;
        readonly version?: string;
        readonly attributes?: readonly OtlpKeyValue[];
      };
      readonly spans?: readonly {
        readonly traceId?: string;
        readonly spanId?: string;
        readonly parentSpanId?: string;
        readonly name?: string;
        readonly kind?: number;
        readonly startTimeUnixNano?: string | number;
        readonly endTimeUnixNano?: string | number;
        readonly attributes?: readonly OtlpKeyValue[];
        readonly status?: {
          readonly code?: number;
          readonly message?: string;
        };
        readonly events?: readonly {
          readonly timeUnixNano?: string | number;
          readonly name?: string;
          readonly attributes?: readonly OtlpKeyValue[];
          readonly droppedAttributesCount?: number;
        }[];
        readonly links?: readonly {
          readonly traceId?: string;
          readonly spanId?: string;
          readonly attributes?: readonly OtlpKeyValue[];
        }[];
      }[];
    }[];
  }[];
}

export interface OtlpLogsDocument {
  readonly resourceLogs: readonly {
    readonly resource?: {
      readonly attributes?: readonly OtlpKeyValue[];
    };
    readonly scopeLogs?: readonly {
      readonly scope?: {
        readonly name?: string;
        readonly version?: string;
        readonly attributes?: readonly OtlpKeyValue[];
      };
      readonly logRecords?: readonly {
        readonly timeUnixNano?: string | number;
        readonly observedTimeUnixNano?: string | number;
        readonly severityNumber?: number;
        readonly severityText?: string;
        readonly body?: OtlpAnyValue;
        readonly attributes?: readonly OtlpKeyValue[];
        readonly traceId?: string;
        readonly spanId?: string;
        readonly flags?: number;
      }[];
    }[];
  }[];
}

export type OtlpDocument = OtlpMetricsDocument | OtlpTracesDocument | OtlpLogsDocument;

const EMPTY_ATTRIBUTES: AttributeMap = {};
const EMPTY_SCOPE: ScopeInfo = {
  name: null,
  version: null,
  attributes: EMPTY_ATTRIBUTES,
};

function compactNumbers(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

function mapScope(
  scope:
    | {
        readonly name?: string;
        readonly version?: string;
        readonly attributes?: readonly OtlpKeyValue[];
      }
    | undefined
): ScopeInfo {
  if (!scope) {
    return EMPTY_SCOPE;
  }
  return {
    name: scope.name ?? null,
    version: scope.version ?? null,
    attributes: flattenAttributes(scope.attributes),
  };
}

function mapCommonPoint(point: OtlpBasePoint): BasePointRecord {
  return {
    startTimeUnixNano: normalizeUnixNanos(point.startTimeUnixNano),
    timeUnixNano: normalizeUnixNanos(point.timeUnixNano),
    attributes: flattenAttributes(point.attributes),
    exemplars: mapExemplars(point.exemplars),
  };
}

function mapMetricInfo(
  metric: OtlpMetric,
  kind: MetricInfo["kind"],
  aggregationTemporality: number | null,
  isMonotonic: boolean | null
): MetricInfo {
  return {
    name: metric.name,
    description: metric.description ?? null,
    unit: metric.unit ?? null,
    kind,
    aggregationTemporality,
    isMonotonic,
  };
}

function mapExemplars(exemplars: readonly OtlpExemplar[] | undefined): readonly ExemplarRecord[] {
  return (exemplars ?? []).map((exemplar) => ({
    filteredAttributes: flattenAttributes(exemplar.filteredAttributes),
    timeUnixNano: normalizeUnixNanos(exemplar.timeUnixNano),
    spanId: exemplar.spanId ?? null,
    traceId: exemplar.traceId ?? null,
    value: toNumber(exemplar.asDouble ?? exemplar.asInt ?? null),
  }));
}

function mapBuckets(
  buckets:
    | {
        readonly offset?: string | number;
        readonly bucketCounts?: readonly (string | number)[];
      }
    | undefined
): { readonly offset: number | null; readonly bucketCounts: readonly number[] } {
  return {
    offset: toNumber(buckets?.offset ?? null),
    bucketCounts: compactNumbers((buckets?.bucketCounts ?? []).map((value) => toNumber(value))),
  };
}

export function isMetricsDocument(value: unknown): value is OtlpMetricsDocument {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as OtlpMetricsDocument).resourceMetrics)
  );
}

export function isTracesDocument(value: unknown): value is OtlpTracesDocument {
  return Boolean(
    value && typeof value === "object" && Array.isArray((value as OtlpTracesDocument).resourceSpans)
  );
}

export function isLogsDocument(value: unknown): value is OtlpLogsDocument {
  return Boolean(
    value && typeof value === "object" && Array.isArray((value as OtlpLogsDocument).resourceLogs)
  );
}

export function detectSignal(document: unknown): Signal | null {
  if (isMetricsDocument(document)) {
    return "metrics";
  }
  if (isTracesDocument(document)) {
    return "traces";
  }
  if (isLogsDocument(document)) {
    return "logs";
  }
  return null;
}

export function parseOtlpJson(input: unknown): OtlpDocument {
  const document = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  const signal = detectSignal(document);
  if (!signal) {
    throw new TypeError("Expected OTLP JSON metrics, traces, or logs document.");
  }
  return document as OtlpDocument;
}

export function parseOtlpJsonLine(line: string): OtlpDocument | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return parseOtlpJson(trimmed);
}

export function parseOtlpJsonLines(input: string): OtlpDocument[] {
  return input
    .split(/\r?\n/u)
    .map((line) => parseOtlpJsonLine(line))
    .filter((document): document is OtlpDocument => document !== null);
}

export function makeEnvelope<TDocument extends OtlpDocument>(
  document: TDocument,
  meta: {
    readonly receivedAt?: string;
    readonly source?: string | null;
  } = {}
): OtlpEnvelope<TDocument> {
  const signal = detectSignal(document);
  if (!signal) {
    throw new TypeError("Cannot envelope a value that is not OTLP JSON.");
  }
  return {
    signal,
    data: document,
    receivedAt: meta.receivedAt ?? new Date().toISOString(),
    source: meta.source ?? null,
  };
}

export function toUnixNanos(value: unknown): bigint | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
  }
  if (value instanceof Date) {
    return BigInt(value.getTime()) * 1_000_000n;
  }
  if (typeof value === "string") {
    if (/^\d+$/u.test(value)) {
      return BigInt(value);
    }
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds) ? null : BigInt(milliseconds) * 1_000_000n;
  }
  return null;
}

export function normalizeUnixNanos(value: unknown): string | null {
  return toUnixNanos(value)?.toString() ?? null;
}

export function nanosToMillis(value: unknown): number | null {
  const nanos = toUnixNanos(value);
  return nanos === null ? null : Number(nanos / 1_000_000n);
}

export function nanosToIso(value: unknown): string | null {
  const milliseconds = nanosToMillis(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

export function durationNanos(start: unknown, end: unknown): string | null {
  const startNanos = toUnixNanos(start);
  const endNanos = toUnixNanos(end);
  if (startNanos === null || endNanos === null) {
    return null;
  }
  return (endNanos - startNanos).toString();
}

export function toNumber(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function attributeValueToJs(value: OtlpAnyValue | unknown): AttributeValue {
  if (value == null || typeof value !== "object") {
    return (value ?? null) as PrimitiveAttributeValue;
  }
  const anyValue = value as OtlpAnyValue;
  if ("stringValue" in anyValue) {
    return anyValue.stringValue ?? null;
  }
  if ("boolValue" in anyValue) {
    return anyValue.boolValue ?? false;
  }
  if ("intValue" in anyValue) {
    return toNumber(anyValue.intValue ?? null);
  }
  if ("doubleValue" in anyValue) {
    return toNumber(anyValue.doubleValue ?? null);
  }
  if ("bytesValue" in anyValue) {
    return anyValue.bytesValue ?? null;
  }
  if ("arrayValue" in anyValue) {
    return (anyValue.arrayValue?.values ?? []).map((entry) => attributeValueToJs(entry));
  }
  if ("kvlistValue" in anyValue) {
    return flattenAttributes(anyValue.kvlistValue?.values);
  }
  return null;
}

export function flattenAttributes(attributes: readonly OtlpKeyValue[] | undefined): AttributeMap {
  if (!attributes || attributes.length === 0) {
    return EMPTY_ATTRIBUTES;
  }
  const flattened: AttributeMap = {};
  for (const attribute of attributes) {
    flattened[attribute.key] = attributeValueToJs(attribute.value);
  }
  return flattened;
}

export function forEachAttribute(
  attributes: readonly OtlpKeyValue[] | undefined,
  fn: (key: string, value: AttributeValue) => void
): void {
  if (!attributes || attributes.length === 0) {
    return;
  }
  for (const attribute of attributes) {
    fn(attribute.key, attributeValueToJs(attribute.value));
  }
}

export function visitMetricPoints(
  document: OtlpMetricsDocument,
  visitor: MetricPointVisitor
): void {
  if (!isMetricsDocument(document)) {
    throw new TypeError("Expected OTLP metrics document.");
  }

  for (const resourceMetrics of document.resourceMetrics) {
    const resource = flattenAttributes(resourceMetrics.resource?.attributes);
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      const scope = mapScope(scopeMetrics.scope);
      visitor.onScope?.({ resource, scope });
      for (const metric of scopeMetrics.metrics ?? []) {
        const gaugePoints = metric.gauge?.dataPoints;
        if (gaugePoints) {
          visitor.onNumberDataPoints?.(
            {
              resource,
              scope,
              metric: mapMetricInfo(metric, "gauge", null, null),
            },
            gaugePoints
          );
        }

        const sum = metric.sum;
        const sumPoints = sum?.dataPoints;
        if (sumPoints) {
          visitor.onNumberDataPoints?.(
            {
              resource,
              scope,
              metric: mapMetricInfo(
                metric,
                "sum",
                sum?.aggregationTemporality ?? null,
                sum?.isMonotonic ?? null
              ),
            },
            sumPoints
          );
        }

        const histogram = metric.histogram;
        const histogramPoints = histogram?.dataPoints;
        if (histogramPoints) {
          visitor.onHistogramDataPoints?.(
            {
              resource,
              scope,
              metric: mapMetricInfo(
                metric,
                "histogram",
                histogram?.aggregationTemporality ?? null,
                null
              ),
            },
            histogramPoints
          );
        }

        const summaryPoints = metric.summary?.dataPoints;
        if (summaryPoints) {
          visitor.onSummaryDataPoints?.(
            {
              resource,
              scope,
              metric: mapMetricInfo(metric, "summary", null, null),
            },
            summaryPoints
          );
        }

        const exponentialHistogram = metric.exponentialHistogram;
        const exponentialHistogramPoints = exponentialHistogram?.dataPoints;
        if (exponentialHistogramPoints) {
          visitor.onExponentialHistogramDataPoints?.(
            {
              resource,
              scope,
              metric: mapMetricInfo(
                metric,
                "exponentialHistogram",
                exponentialHistogram?.aggregationTemporality ?? null,
                null
              ),
            },
            exponentialHistogramPoints
          );
        }
      }
    }
  }
}

export function visitMetricPointsRaw(
  document: OtlpMetricsDocument,
  visitor: MetricPointRawVisitor
): void {
  if (!isMetricsDocument(document)) {
    throw new TypeError("Expected OTLP metrics document.");
  }

  for (const resourceMetrics of document.resourceMetrics) {
    const resourceAttributes = resourceMetrics.resource?.attributes;
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      const rawContext = {
        resourceAttributes,
        scopeName: scopeMetrics.scope?.name ?? null,
        scopeVersion: scopeMetrics.scope?.version ?? null,
        scopeAttributes: scopeMetrics.scope?.attributes,
      };
      visitor.onScope?.(rawContext);
      for (const metric of scopeMetrics.metrics ?? []) {
        const gaugePoints = metric.gauge?.dataPoints;
        if (gaugePoints) {
          visitor.onNumberDataPoints?.(
            {
              ...rawContext,
              metric: mapMetricInfo(metric, "gauge", null, null),
            },
            gaugePoints
          );
        }

        const sum = metric.sum;
        const sumPoints = sum?.dataPoints;
        if (sumPoints) {
          visitor.onNumberDataPoints?.(
            {
              ...rawContext,
              metric: mapMetricInfo(
                metric,
                "sum",
                sum?.aggregationTemporality ?? null,
                sum?.isMonotonic ?? null
              ),
            },
            sumPoints
          );
        }

        const histogram = metric.histogram;
        const histogramPoints = histogram?.dataPoints;
        if (histogramPoints) {
          visitor.onHistogramDataPoints?.(
            {
              ...rawContext,
              metric: mapMetricInfo(
                metric,
                "histogram",
                histogram?.aggregationTemporality ?? null,
                null
              ),
            },
            histogramPoints
          );
        }

        const summaryPoints = metric.summary?.dataPoints;
        if (summaryPoints) {
          visitor.onSummaryDataPoints?.(
            {
              ...rawContext,
              metric: mapMetricInfo(metric, "summary", null, null),
            },
            summaryPoints
          );
        }

        const exponentialHistogram = metric.exponentialHistogram;
        const exponentialHistogramPoints = exponentialHistogram?.dataPoints;
        if (exponentialHistogramPoints) {
          visitor.onExponentialHistogramDataPoints?.(
            {
              ...rawContext,
              metric: mapMetricInfo(
                metric,
                "exponentialHistogram",
                exponentialHistogram?.aggregationTemporality ?? null,
                null
              ),
            },
            exponentialHistogramPoints
          );
        }
      }
    }
  }
}

export function* iterMetricPoints(document: OtlpMetricsDocument): Generator<MetricPointRecord> {
  if (!isMetricsDocument(document)) {
    throw new TypeError("Expected OTLP metrics document.");
  }

  for (const resourceMetrics of document.resourceMetrics) {
    const resource = flattenAttributes(resourceMetrics.resource?.attributes);
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      const scope = mapScope(scopeMetrics.scope);
      for (const metric of scopeMetrics.metrics ?? []) {
        for (const point of metric.gauge?.dataPoints ?? []) {
          yield {
            signal: "metrics",
            resource,
            scope,
            metric: mapMetricInfo(metric, "gauge", null, null),
            point: {
              ...mapCommonPoint(point),
              kind: "number",
              value: toNumber(point.asDouble ?? point.asInt ?? null),
            },
          };
        }
        const sum = metric.sum;
        for (const point of sum?.dataPoints ?? []) {
          yield {
            signal: "metrics",
            resource,
            scope,
            metric: mapMetricInfo(
              metric,
              "sum",
              sum?.aggregationTemporality ?? null,
              sum?.isMonotonic ?? null
            ),
            point: {
              ...mapCommonPoint(point),
              kind: "number",
              value: toNumber(point.asDouble ?? point.asInt ?? null),
            },
          };
        }
        const histogram = metric.histogram;
        for (const point of histogram?.dataPoints ?? []) {
          yield {
            signal: "metrics",
            resource,
            scope,
            metric: mapMetricInfo(
              metric,
              "histogram",
              histogram?.aggregationTemporality ?? null,
              null
            ),
            point: {
              ...mapCommonPoint(point),
              kind: "histogram",
              count: toNumber(point.count ?? null),
              sum: toNumber(point.sum ?? null),
              bucketCounts: compactNumbers(
                (point.bucketCounts ?? []).map((value) => toNumber(value))
              ),
              explicitBounds: compactNumbers(
                (point.explicitBounds ?? []).map((value) => toNumber(value))
              ),
              min: toNumber(point.min ?? null),
              max: toNumber(point.max ?? null),
            },
          };
        }
        for (const point of metric.summary?.dataPoints ?? []) {
          yield {
            signal: "metrics",
            resource,
            scope,
            metric: mapMetricInfo(metric, "summary", null, null),
            point: {
              ...mapCommonPoint(point),
              kind: "summary",
              count: toNumber(point.count ?? null),
              sum: toNumber(point.sum ?? null),
              quantileValues: (point.quantileValues ?? []).map((quantile) => ({
                quantile: toNumber(quantile.quantile ?? null),
                value: toNumber(quantile.value ?? null),
              })),
            },
          };
        }
        const exponentialHistogram = metric.exponentialHistogram;
        for (const point of exponentialHistogram?.dataPoints ?? []) {
          yield {
            signal: "metrics",
            resource,
            scope,
            metric: mapMetricInfo(
              metric,
              "exponentialHistogram",
              exponentialHistogram?.aggregationTemporality ?? null,
              null
            ),
            point: {
              ...mapCommonPoint(point),
              kind: "exponentialHistogram",
              count: toNumber(point.count ?? null),
              sum: toNumber(point.sum ?? null),
              scale: toNumber(point.scale ?? null),
              zeroCount: toNumber(point.zeroCount ?? null),
              positive: mapBuckets(point.positive),
              negative: mapBuckets(point.negative),
            },
          };
        }
      }
    }
  }
}

export function collectMetricPoints(document: OtlpMetricsDocument): MetricPointRecord[] {
  return [...iterMetricPoints(document)];
}

export function* iterSpans(document: OtlpTracesDocument): Generator<SpanRecord> {
  if (!isTracesDocument(document)) {
    throw new TypeError("Expected OTLP traces document.");
  }

  for (const resourceSpans of document.resourceSpans) {
    const resource = flattenAttributes(resourceSpans.resource?.attributes);
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      const scope = mapScope(scopeSpans.scope);
      for (const span of scopeSpans.spans ?? []) {
        const startTimeUnixNano = normalizeUnixNanos(span.startTimeUnixNano);
        const endTimeUnixNano = normalizeUnixNanos(span.endTimeUnixNano);
        yield {
          signal: "traces",
          resource,
          scope,
          traceId: span.traceId ?? null,
          spanId: span.spanId ?? null,
          parentSpanId: span.parentSpanId || null,
          name: span.name ?? null,
          kind: span.kind ?? null,
          startTimeUnixNano,
          endTimeUnixNano,
          durationNanos: durationNanos(startTimeUnixNano, endTimeUnixNano),
          status: {
            code: span.status?.code ?? 0,
            message: span.status?.message ?? null,
          },
          attributes: flattenAttributes(span.attributes),
          events: (span.events ?? []).map((event) => ({
            timeUnixNano: normalizeUnixNanos(event.timeUnixNano),
            isoTime: nanosToIso(event.timeUnixNano),
            name: event.name ?? null,
            attributes: flattenAttributes(event.attributes),
            droppedAttributesCount: event.droppedAttributesCount ?? 0,
          })),
          links: (span.links ?? []).map((link) => ({
            traceId: link.traceId ?? null,
            spanId: link.spanId ?? null,
            attributes: flattenAttributes(link.attributes),
          })),
        };
      }
    }
  }
}

export function collectSpans(document: OtlpTracesDocument): SpanRecord[] {
  return [...iterSpans(document)];
}

export function* iterLogRecords(document: OtlpLogsDocument): Generator<LogRecord> {
  if (!isLogsDocument(document)) {
    throw new TypeError("Expected OTLP logs document.");
  }

  for (const resourceLogs of document.resourceLogs) {
    const resource = flattenAttributes(resourceLogs.resource?.attributes);
    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      const scope = mapScope(scopeLogs.scope);
      for (const logRecord of scopeLogs.logRecords ?? []) {
        yield {
          signal: "logs",
          resource,
          scope,
          timeUnixNano: normalizeUnixNanos(logRecord.timeUnixNano),
          observedTimeUnixNano: normalizeUnixNanos(logRecord.observedTimeUnixNano),
          severityNumber: logRecord.severityNumber ?? null,
          severityText: logRecord.severityText ?? null,
          body: attributeValueToJs(logRecord.body),
          attributes: flattenAttributes(logRecord.attributes),
          traceId: logRecord.traceId ?? null,
          spanId: logRecord.spanId ?? null,
          flags: logRecord.flags ?? null,
        };
      }
    }
  }
}

export function collectLogRecords(document: OtlpLogsDocument): LogRecord[] {
  return [...iterLogRecords(document)];
}
