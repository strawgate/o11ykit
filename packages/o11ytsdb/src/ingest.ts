import type {
  OtlpExponentialHistogramDataPoint,
  OtlpHistogramDataPoint,
  OtlpKeyValue,
  OtlpMetricsDocument,
  OtlpSummaryDataPoint,
} from '@otlpkit/otlpjson';
import { detectSignal, flattenAttributes, isMetricsDocument, toNumber } from '@otlpkit/otlpjson';

import type { Labels, StorageBackend } from './types.js';

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

const SCOPE_NAME_LABEL = 'otel.scope.name';
const SCOPE_VERSION_LABEL = 'otel.scope.version';
const ATTR_PREFIX_RESOURCE = 'resource.';
const ATTR_PREFIX_SCOPE = 'scope_attr.';
const ATTR_PREFIX_POINT = 'attr.';

// ── T3: Sanitize cache ──────────────────────────────────────────────
const sanitizeCache = new Map<string, string>();

function sanitizeLabelKey(key: string): string {
  let cached = sanitizeCache.get(key);
  if (cached !== undefined) return cached;
  cached = key.replace(/[^a-zA-Z0-9_]/gu, '_');
  sanitizeCache.set(key, cached);
  return cached;
}

// ── T3: Prefixed-key cache ──────────────────────────────────────────
const prefixedKeyCache = new Map<string, string>();

function prefixedKey(prefix: string, key: string): string {
  const cacheKey = prefix + key;
  let cached = prefixedKeyCache.get(cacheKey);
  if (cached !== undefined) return cached;
  cached = `${prefix}${sanitizeLabelKey(key)}`;
  prefixedKeyCache.set(cacheKey, cached);
  return cached;
}

// ── T1: FNV-1a series fingerprint ───────────────────────────────────
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnvHashString(hash: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

function seriesFingerprint(labels: Map<string, string>): string {
  // Hash all key=value pairs in insertion order. Since labels are built
  // deterministically (scope, resource, __name__, attr.*), insertion
  // order is stable for identical label sets. We sort label entries to
  // guarantee consistency regardless of insertion order.
  let hash = FNV_OFFSET >>> 0;
  let size = 0;
  for (const [k, v] of labels) {
    hash = fnvHashString(hash, k);
    hash ^= 0xFF;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    hash = fnvHashString(hash, v);
    hash ^= 0xFE;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    size++;
  }
  // Encode hash + size to reduce collisions.
  return `${hash.toString(36)}:${size}`;
}

// ── T5: flattenAttributes cache ─────────────────────────────────────
let cachedAttrRef: readonly OtlpKeyValue[] | undefined;
let cachedAttrResult: Record<string, unknown> = {};

function cachedFlattenAttributes(attrs: readonly OtlpKeyValue[] | undefined): Record<string, unknown> {
  if (attrs === undefined || attrs === null || attrs.length === 0) return {};
  if (attrs === cachedAttrRef) return cachedAttrResult;
  cachedAttrRef = attrs;
  cachedAttrResult = flattenAttributes(attrs);
  return cachedAttrResult;
}

// ── Core ingest functions ───────────────────────────────────────────

function emptyResult(): IngestResult {
  return {
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
}

/**
 * Parse an OTLP metrics payload into pending samples without touching storage.
 * Use this when you need to inspect or transform parsed metrics before flushing.
 */
export function parseOtlpToSamples(payload: unknown): ParsedOtlpResult {
  const result = emptyResult();

  let document: unknown = payload;
  if (typeof payload === 'string') {
    try {
      document = JSON.parse(payload) as unknown;
    } catch {
      result.errors++;
      result.dropped++;
      return { pending: new Map(), result };
    }
  }

  if (detectSignal(document) !== 'metrics' || !isMetricsDocument(document)) {
    result.errors++;
    result.dropped++;
    return { pending: new Map(), result };
  }

  return ingestMetricsDocument(document, result);
}

/**
 * Ingest a typed OTLP metrics document directly, skipping JSON.parse,
 * detectSignal, and isMetricsDocument. Use when the caller has already
 * validated the payload type (e.g. worker protocol).
 */
export function ingestOtlpObject(document: OtlpMetricsDocument, storage: StorageBackend): IngestResult {
  const result = emptyResult();
  const { pending } = ingestMetricsDocument(document, result);
  flushSamplesToStorage(pending, storage, result);
  return result;
}

function ingestMetricsDocument(document: OtlpMetricsDocument, result: IngestResult): ParsedOtlpResult {
  const pending = new Map<string, PendingSeriesSamples>();
  // T2: Reusable mutable working map — avoids per-point Map cloning.
  const workLabels = new Map<string, string>();

  for (const resourceMetrics of document.resourceMetrics) {
    const resourceAttrs = flattenAttributes(resourceMetrics.resource?.attributes);

    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      const scope = scopeMetrics.scope;
      const scopeAttrs = flattenAttributes(scope?.attributes);

      // Pre-compute base labels once per scope (T3: cached prefixed keys).
      const baseEntries: Array<[string, string]> = [];
      baseEntries.push([SCOPE_NAME_LABEL, scope?.name ?? '']);
      baseEntries.push([SCOPE_VERSION_LABEL, scope?.version ?? '']);
      for (const [key, value] of Object.entries(resourceAttrs)) {
        baseEntries.push([prefixedKey(ATTR_PREFIX_RESOURCE, key), attributeValueToLabel(value)]);
      }
      for (const [key, value] of Object.entries(scopeAttrs)) {
        baseEntries.push([prefixedKey(ATTR_PREFIX_SCOPE, key), attributeValueToLabel(value)]);
      }

      for (const metric of scopeMetrics.metrics ?? []) {
        if (metric.gauge?.dataPoints) {
          result.metricTypeCounts.gauge++;
          ingestNumberPoints(metric.name, metric.gauge.dataPoints, baseEntries, workLabels, pending, result);
        }

        if (metric.sum?.dataPoints) {
          result.metricTypeCounts.sum++;
          ingestNumberPoints(metric.name, metric.sum.dataPoints, baseEntries, workLabels, pending, result);
        }

        if (metric.histogram?.dataPoints) {
          result.metricTypeCounts.histogram++;
          ingestHistogramPoints(metric.name, metric.histogram.dataPoints, baseEntries, workLabels, pending, result);
        }

        if (metric.summary?.dataPoints) {
          result.metricTypeCounts.summary++;
          ingestSummaryPoints(metric.name, metric.summary.dataPoints, baseEntries, workLabels, pending, result);
        }

        if (metric.exponentialHistogram?.dataPoints) {
          result.metricTypeCounts.exponentialHistogram++;
          ingestExponentialHistogramPoints(
            metric.name,
            metric.exponentialHistogram.dataPoints,
            baseEntries,
            workLabels,
            pending,
            result,
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
export function flushSamplesToStorage(pending: Map<string, PendingSeriesSamples>, storage: StorageBackend, result: IngestResult): void {
  const beforeSeries = storage.seriesCount;

  for (const batch of pending.values()) {
    if (batch.timestamps.length === 0) continue;

    const id = storage.getOrCreateSeries(batch.labels);
    storage.appendBatch(id, BigInt64Array.from(batch.timestamps), Float64Array.from(batch.values));
    result.samplesInserted += batch.timestamps.length;
  }

  result.seriesCreated += Math.max(0, storage.seriesCount - beforeSeries);
}

// ── T2: Reset working labels to base + metric name + point attrs ────

function resetWorkLabels(
  workLabels: Map<string, string>,
  baseEntries: Array<[string, string]>,
  metricName: string,
  pointAttributes: readonly OtlpKeyValue[] | undefined,
): void {
  workLabels.clear();
  for (let i = 0; i < baseEntries.length; i++) {
    const [k, v] = baseEntries[i]!;
    workLabels.set(k, v);
  }
  workLabels.set('__name__', metricName);
  const pointAttrs = cachedFlattenAttributes(pointAttributes);
  for (const key of Object.keys(pointAttrs)) {
    workLabels.set(prefixedKey(ATTR_PREFIX_POINT, key), attributeValueToLabel(pointAttrs[key]));
  }
}

function ingestNumberPoints(
  metricName: string,
  points: readonly { timeUnixNano?: string | number; attributes?: readonly OtlpKeyValue[]; asDouble?: number; asInt?: string | number }[],
  baseEntries: Array<[string, string]>,
  workLabels: Map<string, string>,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult,
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

    resetWorkLabels(workLabels, baseEntries, metricName, point.attributes);
    queueSample(pending, workLabels, ts, value);
    result.pointsAccepted++;
  }
}

function ingestHistogramPoints(
  metricName: string,
  points: readonly OtlpHistogramDataPoint[],
  baseEntries: Array<[string, string]>,
  workLabels: Map<string, string>,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult,
): void {
  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    if (ts === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    resetWorkLabels(workLabels, baseEntries, metricName, point.attributes);

    const bucketCounts = parseNumberArray(point.bucketCounts);
    const bounds = parseNumberArray(point.explicitBounds);

    let cumulative = 0;
    const bucketName = `${metricName}_bucket`;
    workLabels.set('__name__', bucketName);

    const commonCount = Math.min(bucketCounts.length, bounds.length + 1);
    for (let i = 0; i < commonCount; i++) {
      cumulative += bucketCounts[i] ?? 0;
      workLabels.set('le', i < bounds.length ? numericLabel(bounds[i]!) : '+Inf');
      queueSample(pending, workLabels, ts, cumulative);
      result.pointsAccepted++;
    }

    // Remove histogram-specific labels before count/sum.
    workLabels.delete('le');

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      workLabels.set('__name__', `${metricName}_count`);
      queueSample(pending, workLabels, ts, count);
      result.pointsAccepted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      workLabels.set('__name__', `${metricName}_sum`);
      queueSample(pending, workLabels, ts, sum);
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
  baseEntries: Array<[string, string]>,
  workLabels: Map<string, string>,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult,
): void {
  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    if (ts === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    resetWorkLabels(workLabels, baseEntries, metricName, point.attributes);
    let inserted = 0;

    for (const qv of point.quantileValues ?? []) {
      const quantile = toNumber(qv.quantile ?? null);
      const value = toNumber(qv.value ?? null);
      if (quantile === null || value === null) continue;
      workLabels.set('quantile', numericLabel(quantile));
      queueSample(pending, workLabels, ts, value);
      inserted++;
    }
    workLabels.delete('quantile');

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      workLabels.set('__name__', `${metricName}_count`);
      queueSample(pending, workLabels, ts, count);
      inserted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      workLabels.set('__name__', `${metricName}_sum`);
      queueSample(pending, workLabels, ts, sum);
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
  baseEntries: Array<[string, string]>,
  workLabels: Map<string, string>,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult,
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
    resetWorkLabels(workLabels, baseEntries, metricName, point.attributes);
    let inserted = 0;

    inserted += ingestExpBuckets(metricName, workLabels, ts, scale, 'positive', point.positive, pending);
    inserted += ingestExpBuckets(metricName, workLabels, ts, scale, 'negative', point.negative, pending);

    // Clean up exp-specific labels from ingestExpBuckets before zero/count/sum.
    workLabels.delete('exp_side');
    workLabels.delete('exp_bucket');
    workLabels.delete('exp_scale');

    const zeroCount = toNumber(point.zeroCount ?? null);
    if (zeroCount !== null) {
      workLabels.set('__name__', `${metricName}_bucket`);
      workLabels.set('exp_bucket', 'zero');
      if (scale !== null) workLabels.set('exp_scale', numericLabel(scale));
      queueSample(pending, workLabels, ts, zeroCount);
      workLabels.delete('exp_bucket');
      workLabels.delete('exp_scale');
      inserted++;
    }

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      workLabels.set('__name__', `${metricName}_count`);
      queueSample(pending, workLabels, ts, count);
      inserted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      workLabels.set('__name__', `${metricName}_sum`);
      queueSample(pending, workLabels, ts, sum);
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
  workLabels: Map<string, string>,
  ts: bigint,
  scale: number | null,
  side: 'positive' | 'negative',
  buckets: { offset?: string | number; bucketCounts?: readonly (string | number)[] } | undefined,
  pending: Map<string, PendingSeriesSamples>,
): number {
  const offset = toNumber(buckets?.offset ?? null) ?? 0;
  const counts = parseNumberArray(buckets?.bucketCounts);
  if (counts.length === 0) return 0;

  workLabels.set('__name__', `${metricName}_bucket`);
  workLabels.set('exp_side', side);
  if (scale !== null) workLabels.set('exp_scale', numericLabel(scale));

  let inserted = 0;
  for (let i = 0; i < counts.length; i++) {
    const value = counts[i] ?? 0;
    workLabels.set('exp_bucket', numericLabel(offset + i));
    queueSample(pending, workLabels, ts, value);
    inserted++;
  }
  return inserted;
}

// ── T1: queueSample with fingerprint key ────────────────────────────

function queueSample(
  pending: Map<string, PendingSeriesSamples>,
  labels: Map<string, string>,
  timestamp: bigint,
  value: number,
): void {
  const key = seriesFingerprint(labels);
  let batch = pending.get(key);
  if (!batch) {
    // Snapshot the label map (it's mutated after this call).
    batch = { labels: new Map(labels), timestamps: [], values: [] };
    pending.set(key, batch);
  }

  batch.timestamps.push(timestamp);
  batch.values.push(value);
}

function attributeValueToLabel(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function numericLabel(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(12).replace(/\.0+$/u, '');
}

function parseNumberArray(values: readonly (string | number)[] | readonly number[] | undefined): number[] {
  if (!values || values.length === 0) return [];
  const out: number[] = [];
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// ── T6: Fast-path timestamp normalization ───────────────────────────

function isAllDigits(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function normalizeTimestamp(value: unknown): bigint | null {
  if (typeof value === 'bigint') return normalizeMagnitude(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return normalizeMagnitude(BigInt(Math.trunc(value)));
  }
  if (typeof value === 'string') {
    if (!value) return null;
    if (isAllDigits(value)) return normalizeMagnitude(BigInt(value));
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
