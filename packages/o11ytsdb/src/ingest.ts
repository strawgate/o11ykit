import type {
  OtlpExponentialHistogramDataPoint,
  OtlpHistogramDataPoint,
  OtlpKeyValue,
  OtlpMetricsDocument,
  OtlpSummaryDataPoint,
} from "@otlpkit/otlpjson";
import { detectSignal, flattenAttributes, isMetricsDocument, toNumber } from "@otlpkit/otlpjson";

import type { Labels, StorageBackend } from "./types.js";

export interface IngestResult {
  pointsSeen: number;
  pointsAccepted: number;
  samplesInserted: number;
  seriesCreated: number;
  errors: number;
  dropped: number;
  metricTypeCounts: {
    gauge: number;
    sum: number;
    histogram: number;
    summary: number;
    exponentialHistogram: number;
  };
}

export interface PendingSeriesSamples {
  labels: Labels;
  timestamps: bigint[];
  values: number[];
}

export interface ParsedOtlpResult {
  pending: Map<string, PendingSeriesSamples>;
  result: IngestResult;
}

const SCOPE_NAME_LABEL = "otel.scope.name";
const SCOPE_VERSION_LABEL = "otel.scope.version";
const ATTR_PREFIX_RESOURCE = "resource.";
const ATTR_PREFIX_SCOPE = "scope_attr.";
const ATTR_PREFIX_POINT = "attr.";

/**
 * Parse an OTLP metrics payload into pending samples without touching storage.
 * Use this when you need to inspect or transform parsed metrics before flushing.
 */
export function parseOtlpToSamples(payload: unknown): ParsedOtlpResult {
  const result: IngestResult = {
    pointsSeen: 0,
    pointsAccepted: 0,
    samplesInserted: 0,
    seriesCreated: 0,
    errors: 0,
    dropped: 0,
    metricTypeCounts: {
      gauge: 0,
      sum: 0,
      histogram: 0,
      summary: 0,
      exponentialHistogram: 0,
    },
  };

  let document: unknown = payload;
  if (typeof payload === "string") {
    try {
      document = JSON.parse(payload) as unknown;
    } catch {
      result.errors++;
      result.dropped++;
      return { pending: new Map(), result };
    }
  }

  if (detectSignal(document) !== "metrics" || !isMetricsDocument(document)) {
    result.errors++;
    result.dropped++;
    return { pending: new Map(), result };
  }

  const pending = new Map<string, PendingSeriesSamples>();

  for (const resourceMetrics of document.resourceMetrics) {
    const resourceAttrs = flattenAttributes(resourceMetrics.resource?.attributes);

    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      const scope = scopeMetrics.scope;
      const scopeAttrs = flattenAttributes(scope?.attributes);

      for (const metric of scopeMetrics.metrics ?? []) {
        const baseLabels = new Map<string, string>();
        baseLabels.set(SCOPE_NAME_LABEL, scope?.name ?? "");
        baseLabels.set(SCOPE_VERSION_LABEL, scope?.version ?? "");
        addAttributeLabels(baseLabels, resourceAttrs, ATTR_PREFIX_RESOURCE);
        addAttributeLabels(baseLabels, scopeAttrs, ATTR_PREFIX_SCOPE);

        if (metric.gauge?.dataPoints) {
          result.metricTypeCounts.gauge++;
          ingestNumberPoints(metric.name, metric.gauge.dataPoints, baseLabels, pending, result);
        }

        if (metric.sum?.dataPoints) {
          result.metricTypeCounts.sum++;
          ingestNumberPoints(metric.name, metric.sum.dataPoints, baseLabels, pending, result);
        }

        if (metric.histogram?.dataPoints) {
          result.metricTypeCounts.histogram++;
          ingestHistogramPoints(
            metric.name,
            metric.histogram.dataPoints,
            baseLabels,
            pending,
            result
          );
        }

        if (metric.summary?.dataPoints) {
          result.metricTypeCounts.summary++;
          ingestSummaryPoints(metric.name, metric.summary.dataPoints, baseLabels, pending, result);
        }

        if (metric.exponentialHistogram?.dataPoints) {
          result.metricTypeCounts.exponentialHistogram++;
          ingestExponentialHistogramPoints(
            metric.name,
            metric.exponentialHistogram.dataPoints,
            baseLabels,
            pending,
            result
          );
        }
      }
    }
  }

  return { pending, result };
}

/** Parse and ingest OTLP metrics in one step (convenience wrapper). */
export function ingestOtlpJson(payload: unknown, storage: StorageBackend): IngestResult {
  const { pending, result } = parseOtlpToSamples(payload);
  flushSamplesToStorage(pending, storage, result);
  return result;
}

/** Flush parsed samples to a storage backend. */
export function flushSamplesToStorage(
  pending: Map<string, PendingSeriesSamples>,
  storage: StorageBackend,
  result: IngestResult
): void {
  const beforeSeries = storage.seriesCount;

  for (const batch of pending.values()) {
    if (batch.timestamps.length === 0) continue;

    const id = storage.getOrCreateSeries(batch.labels);
    storage.appendBatch(id, BigInt64Array.from(batch.timestamps), Float64Array.from(batch.values));
    result.samplesInserted += batch.timestamps.length;
  }

  result.seriesCreated += Math.max(0, storage.seriesCount - beforeSeries);
}

function ingestNumberPoints(
  metricName: string,
  points: readonly {
    timeUnixNano?: string | number;
    attributes?: readonly OtlpKeyValue[];
    asDouble?: number;
    asInt?: string | number;
  }[],
  baseLabels: Map<string, string>,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult
): void {
  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    const value = toNumber(point.asDouble ?? point.asInt ?? null);
    if (ts === null || value === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    const labels = withPointLabels(metricName, baseLabels, point.attributes);
    queueSample(pending, labels, ts, value);
    result.pointsAccepted++;
  }
}

function ingestHistogramPoints(
  metricName: string,
  points: readonly OtlpHistogramDataPoint[],
  baseLabels: Map<string, string>,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult
): void {
  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    if (ts === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    const pointLabels = withPointLabels(metricName, baseLabels, point.attributes);
    const bucketCounts = parseNumberArray(point.bucketCounts);
    const bounds = parseNumberArray(point.explicitBounds);

    let cumulative = 0;
    const bucketLabels = new Map(pointLabels);
    bucketLabels.set("__name__", `${metricName}_bucket`);

    const commonCount = Math.min(bucketCounts.length, bounds.length + 1);
    for (let i = 0; i < commonCount; i++) {
      cumulative += bucketCounts[i] ?? 0;
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      bucketLabels.set("le", i < bounds.length ? numericLabel(bounds[i]!) : "+Inf");
      queueSample(pending, bucketLabels, ts, cumulative);
      result.pointsAccepted++;
    }

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      const countLabels = new Map(pointLabels);
      countLabels.set("__name__", `${metricName}_count`);
      queueSample(pending, countLabels, ts, count);
      result.pointsAccepted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      const sumLabels = new Map(pointLabels);
      sumLabels.set("__name__", `${metricName}_sum`);
      queueSample(pending, sumLabels, ts, sum);
      result.pointsAccepted++;
    }

    if (commonCount === 0 && count === null && sum === null) {
      result.errors++;
      result.dropped++;
    }
  }
}

function ingestSummaryPoints(
  metricName: string,
  points: readonly OtlpSummaryDataPoint[],
  baseLabels: Map<string, string>,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult
): void {
  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    if (ts === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    const pointLabels = withPointLabels(metricName, baseLabels, point.attributes);
    let inserted = 0;

    for (const qv of point.quantileValues ?? []) {
      const quantile = toNumber(qv.quantile ?? null);
      const value = toNumber(qv.value ?? null);
      if (quantile === null || value === null) continue;
      const qLabels = new Map(pointLabels);
      qLabels.set("quantile", numericLabel(quantile));
      queueSample(pending, qLabels, ts, value);
      inserted++;
    }

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      const countLabels = new Map(pointLabels);
      countLabels.set("__name__", `${metricName}_count`);
      queueSample(pending, countLabels, ts, count);
      inserted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      const sumLabels = new Map(pointLabels);
      sumLabels.set("__name__", `${metricName}_sum`);
      queueSample(pending, sumLabels, ts, sum);
      inserted++;
    }

    if (inserted === 0) {
      result.errors++;
      result.dropped++;
      continue;
    }

    result.pointsAccepted += inserted;
  }
}

function ingestExponentialHistogramPoints(
  metricName: string,
  points: readonly OtlpExponentialHistogramDataPoint[],
  baseLabels: Map<string, string>,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult
): void {
  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    if (ts === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    const scale = toNumber(point.scale ?? null);
    const pointLabels = withPointLabels(metricName, baseLabels, point.attributes);
    let inserted = 0;

    inserted += ingestExpBuckets(
      metricName,
      pointLabels,
      ts,
      scale,
      "positive",
      point.positive,
      pending
    );
    inserted += ingestExpBuckets(
      metricName,
      pointLabels,
      ts,
      scale,
      "negative",
      point.negative,
      pending
    );

    const zeroCount = toNumber(point.zeroCount ?? null);
    if (zeroCount !== null) {
      const zeroLabels = new Map(pointLabels);
      zeroLabels.set("__name__", `${metricName}_bucket`);
      zeroLabels.set("exp_bucket", "zero");
      queueSample(pending, zeroLabels, ts, zeroCount);
      inserted++;
    }

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      const countLabels = new Map(pointLabels);
      countLabels.set("__name__", `${metricName}_count`);
      queueSample(pending, countLabels, ts, count);
      inserted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      const sumLabels = new Map(pointLabels);
      sumLabels.set("__name__", `${metricName}_sum`);
      queueSample(pending, sumLabels, ts, sum);
      inserted++;
    }

    if (inserted === 0) {
      result.errors++;
      result.dropped++;
      continue;
    }

    result.pointsAccepted += inserted;
  }
}

function ingestExpBuckets(
  metricName: string,
  labels: Map<string, string>,
  ts: bigint,
  scale: number | null,
  side: "positive" | "negative",
  buckets: { offset?: string | number; bucketCounts?: readonly (string | number)[] } | undefined,
  pending: Map<string, PendingSeriesSamples>
): number {
  const offset = toNumber(buckets?.offset ?? null) ?? 0;
  const counts = parseNumberArray(buckets?.bucketCounts);
  if (counts.length === 0) return 0;

  let inserted = 0;
  for (let i = 0; i < counts.length; i++) {
    const value = counts[i] ?? 0;
    const bucketIndex = offset + i;
    const bucketLabels = new Map(labels);
    bucketLabels.set("__name__", `${metricName}_bucket`);
    bucketLabels.set("exp_side", side);
    bucketLabels.set("exp_bucket", numericLabel(bucketIndex));
    if (scale !== null) bucketLabels.set("exp_scale", numericLabel(scale));
    queueSample(pending, bucketLabels, ts, value);
    inserted++;
  }
  return inserted;
}

function withPointLabels(
  metricName: string,
  baseLabels: Map<string, string>,
  pointAttributes: readonly OtlpKeyValue[] | undefined
): Map<string, string> {
  const labels = new Map(baseLabels);
  labels.set("__name__", metricName);
  const point = flattenAttributes(pointAttributes);
  addAttributeLabels(labels, point, ATTR_PREFIX_POINT);
  return labels;
}

function addAttributeLabels(
  labels: Map<string, string>,
  attrs: Record<string, unknown>,
  prefix: string
): void {
  for (const [key, value] of Object.entries(attrs)) {
    labels.set(`${prefix}${sanitizeLabelKey(key)}`, attributeValueToLabel(value));
  }
}

function attributeValueToLabel(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function queueSample(
  pending: Map<string, PendingSeriesSamples>,
  labels: Labels,
  timestamp: bigint,
  value: number
): void {
  const key = seriesKey(labels);
  let batch = pending.get(key);
  if (!batch) {
    batch = { labels, timestamps: [], values: [] };
    pending.set(key, batch);
  }

  batch.timestamps.push(timestamp);
  batch.values.push(value);
}

function seriesKey(labels: Labels): string {
  const entries = [...labels.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return entries.map(([k, v]) => `${k}=${v}`).join(",");
}

function numericLabel(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(12).replace(/\.0+$/u, "");
}

function parseNumberArray(
  values: readonly (string | number)[] | readonly number[] | undefined
): number[] {
  if (!values || values.length === 0) return [];
  const out: number[] = [];
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function sanitizeLabelKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/gu, "_");
}

function normalizeTimestamp(value: unknown): bigint | null {
  if (typeof value === "bigint") return normalizeMagnitude(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return normalizeMagnitude(BigInt(Math.trunc(value)));
  }
  if (typeof value === "string") {
    if (!value) return null;
    if (/^\d+$/u.test(value)) return normalizeMagnitude(BigInt(value));
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return null;
    return BigInt(ms) * 1_000_000n;
  }
  return null;
}

function normalizeMagnitude(ts: bigint): bigint {
  const abs = ts < 0n ? -ts : ts;
  // Heuristic: values <= 10^13 are probably milliseconds.
  if (abs <= 10_000_000_000_000n) {
    return ts * 1_000_000n;
  }
  return ts;
}

export function isDeltaTemporality(aggregationTemporality: number | undefined): boolean {
  return aggregationTemporality === 1;
}

export type { OtlpMetricsDocument };
