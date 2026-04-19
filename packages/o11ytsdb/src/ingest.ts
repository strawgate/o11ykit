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

// ── Per-prefix key caches (avoids string concat on cache hits) ──────
const resourceKeyCache = new Map<string, string>();
const scopeKeyCache = new Map<string, string>();
const pointKeyCache = new Map<string, string>();

function prefixedKey(prefix: string, key: string): string {
  const cache = prefix === ATTR_PREFIX_POINT ? pointKeyCache
    : prefix === ATTR_PREFIX_RESOURCE ? resourceKeyCache
    : scopeKeyCache;
  let cached = cache.get(key);
  if (cached !== undefined) return cached;
  cached = `${prefix}${sanitizeLabelKey(key)}`;
  cache.set(key, cached);
  return cached;
}

// ── FNV-1a incremental hashing ──────────────────────────────────────
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnvHashString(hash: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

function fnvHashEntry(hash: number, key: string, value: string): number {
  hash = fnvHashString(hash, key);
  hash ^= 0xFF;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  hash = fnvHashString(hash, value);
  hash ^= 0xFE;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  return hash;
}

// Module-level output slots to avoid tuple allocation in hot loop.
let _phHash = 0;
let _phCount = 0;

function computePointAttrsHash(baseHash: number, pointAttrs: Record<string, unknown>): void {
  let hash = baseHash;
  let count = 0;
  for (const key of Object.keys(pointAttrs)) {
    hash = fnvHashEntry(hash, prefixedKey(ATTR_PREFIX_POINT, key), attributeValueToLabel(pointAttrs[key]));
    count++;
  }
  _phHash = hash;
  _phCount = count;
}

const fpCache = new Map<number, string>();

function toFingerprint(hash: number, size: number): string {
  // Mix size into hash to avoid separate encoding, then cache the string.
  hash = (hash ^ size) >>> 0;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  let s = fpCache.get(hash);
  if (s === undefined) {
    s = hash.toString(36);
    fpCache.set(hash, s);
  }
  return s;
}

function buildSnapshotLabels(
  baseEntries: ReadonlyArray<readonly [string, string]>,
  metricName: string,
  pointAttrs: Record<string, unknown>,
): Map<string, string> {
  const labels = new Map<string, string>();
  for (let i = 0; i < baseEntries.length; i++) {
    const e = baseEntries[i]!;
    labels.set(e[0], e[1]);
  }
  labels.set('__name__', metricName);
  for (const key of Object.keys(pointAttrs)) {
    labels.set(prefixedKey(ATTR_PREFIX_POINT, key), attributeValueToLabel(pointAttrs[key]));
  }
  return labels;
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

  for (const resourceMetrics of document.resourceMetrics) {
    const resourceAttrs = flattenAttributes(resourceMetrics.resource?.attributes);

    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      const scope = scopeMetrics.scope;
      const scopeAttrs = flattenAttributes(scope?.attributes);

      // Pre-compute base labels and base hash once per scope.
      const baseEntries: Array<[string, string]> = [];
      baseEntries.push([SCOPE_NAME_LABEL, scope?.name ?? '']);
      baseEntries.push([SCOPE_VERSION_LABEL, scope?.version ?? '']);
      for (const [key, value] of Object.entries(resourceAttrs)) {
        baseEntries.push([prefixedKey(ATTR_PREFIX_RESOURCE, key), attributeValueToLabel(value)]);
      }
      for (const [key, value] of Object.entries(scopeAttrs)) {
        baseEntries.push([prefixedKey(ATTR_PREFIX_SCOPE, key), attributeValueToLabel(value)]);
      }

      let baseHash = FNV_OFFSET >>> 0;
      for (let i = 0; i < baseEntries.length; i++) {
        const e = baseEntries[i]!;
        baseHash = fnvHashEntry(baseHash, e[0], e[1]);
      }
      const baseSize = baseEntries.length;

      for (const metric of scopeMetrics.metrics ?? []) {
        if (metric.gauge?.dataPoints) {
          result.metricTypeCounts.gauge++;
          ingestNumberPoints(metric.name, metric.gauge.dataPoints, baseEntries, baseHash, baseSize, pending, result);
        }

        if (metric.sum?.dataPoints) {
          result.metricTypeCounts.sum++;
          ingestNumberPoints(metric.name, metric.sum.dataPoints, baseEntries, baseHash, baseSize, pending, result);
        }

        if (metric.histogram?.dataPoints) {
          result.metricTypeCounts.histogram++;
          ingestHistogramPoints(metric.name, metric.histogram.dataPoints, baseEntries, baseHash, baseSize, pending, result);
        }

        if (metric.summary?.dataPoints) {
          result.metricTypeCounts.summary++;
          ingestSummaryPoints(metric.name, metric.summary.dataPoints, baseEntries, baseHash, baseSize, pending, result);
        }

        if (metric.exponentialHistogram?.dataPoints) {
          result.metricTypeCounts.exponentialHistogram++;
          ingestExponentialHistogramPoints(
            metric.name,
            metric.exponentialHistogram.dataPoints,
            baseEntries,
            baseHash,
            baseSize,
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

// ── Ingest functions with incremental hashing + lazy snapshots ──────

function ingestNumberPoints(
  metricName: string,
  points: readonly { timeUnixNano?: string | number; attributes?: readonly OtlpKeyValue[]; asDouble?: number; asInt?: string | number }[],
  baseEntries: Array<[string, string]>,
  baseHash: number,
  baseSize: number,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult,
): void {
  const metricHash = fnvHashEntry(baseHash, '__name__', metricName);
  const metricSize = baseSize + 1;

  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    const value = toNumber(point.asDouble ?? point.asInt ?? null);
    if (ts === null || value === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    const pointAttrs = cachedFlattenAttributes(point.attributes);
    computePointAttrsHash(metricHash, pointAttrs);
    const fp = toFingerprint(_phHash, metricSize + _phCount);

    let batch = pending.get(fp);
    if (!batch) {
      batch = { labels: buildSnapshotLabels(baseEntries, metricName, pointAttrs), timestamps: [], values: [] };
      pending.set(fp, batch);
    }
    batch.timestamps.push(ts);
    batch.values.push(value);
    result.pointsAccepted++;
  }
}

function ingestHistogramPoints(
  metricName: string,
  points: readonly OtlpHistogramDataPoint[],
  baseEntries: Array<[string, string]>,
  baseHash: number,
  baseSize: number,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult,
): void {
  const bucketName = `${metricName}_bucket`;
  const countName = `${metricName}_count`;
  const sumName = `${metricName}_sum`;
  const bucketMetricHash = fnvHashEntry(baseHash, '__name__', bucketName);
  const countMetricHash = fnvHashEntry(baseHash, '__name__', countName);
  const sumMetricHash = fnvHashEntry(baseHash, '__name__', sumName);
  const metricSize = baseSize + 1;

  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    if (ts === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    const pointAttrs = cachedFlattenAttributes(point.attributes);
    const bucketCounts = parseNumberArray(point.bucketCounts);
    const bounds = parseNumberArray(point.explicitBounds);

    // Compute bucket base hash (metricHash + pointAttrs) once for all buckets.
    computePointAttrsHash(bucketMetricHash, pointAttrs);
    const bucketPointHash = _phHash;
    const pointSize = metricSize + _phCount;

    let cumulative = 0;
    const commonCount = Math.min(bucketCounts.length, bounds.length + 1);
    for (let i = 0; i < commonCount; i++) {
      cumulative += bucketCounts[i] ?? 0;
      const leValue = i < bounds.length ? numericLabel(bounds[i]!) : '+Inf';
      const hash = fnvHashEntry(bucketPointHash, 'le', leValue);
      const fp = toFingerprint(hash, pointSize + 1);

      let batch = pending.get(fp);
      if (!batch) {
        const labels = buildSnapshotLabels(baseEntries, bucketName, pointAttrs);
        labels.set('le', leValue);
        batch = { labels, timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(cumulative);
      result.pointsAccepted++;
    }

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      computePointAttrsHash(countMetricHash, pointAttrs);
      const fp = toFingerprint(_phHash, metricSize + _phCount);
      let batch = pending.get(fp);
      if (!batch) {
        batch = { labels: buildSnapshotLabels(baseEntries, countName, pointAttrs), timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(count);
      result.pointsAccepted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      computePointAttrsHash(sumMetricHash, pointAttrs);
      const fp = toFingerprint(_phHash, metricSize + _phCount);
      let batch = pending.get(fp);
      if (!batch) {
        batch = { labels: buildSnapshotLabels(baseEntries, sumName, pointAttrs), timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(sum);
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
  baseHash: number,
  baseSize: number,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult,
): void {
  const countName = `${metricName}_count`;
  const sumName = `${metricName}_sum`;
  const mainMetricHash = fnvHashEntry(baseHash, '__name__', metricName);
  const countMetricHash = fnvHashEntry(baseHash, '__name__', countName);
  const sumMetricHash = fnvHashEntry(baseHash, '__name__', sumName);
  const metricSize = baseSize + 1;

  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    if (ts === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    const pointAttrs = cachedFlattenAttributes(point.attributes);
    let inserted = 0;

    // Quantile sub-series.
    computePointAttrsHash(mainMetricHash, pointAttrs);
    const mainPointHash = _phHash;
    const pointSize = metricSize + _phCount;

    for (const qv of point.quantileValues ?? []) {
      const quantile = toNumber(qv.quantile ?? null);
      const value = toNumber(qv.value ?? null);
      if (quantile === null || value === null) continue;
      const qLabel = numericLabel(quantile);
      const hash = fnvHashEntry(mainPointHash, 'quantile', qLabel);
      const fp = toFingerprint(hash, pointSize + 1);

      let batch = pending.get(fp);
      if (!batch) {
        const labels = buildSnapshotLabels(baseEntries, metricName, pointAttrs);
        labels.set('quantile', qLabel);
        batch = { labels, timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(value);
      inserted++;
    }

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      computePointAttrsHash(countMetricHash, pointAttrs);
      const fp = toFingerprint(_phHash, metricSize + _phCount);
      let batch = pending.get(fp);
      if (!batch) {
        batch = { labels: buildSnapshotLabels(baseEntries, countName, pointAttrs), timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(count);
      inserted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      computePointAttrsHash(sumMetricHash, pointAttrs);
      const fp = toFingerprint(_phHash, metricSize + _phCount);
      let batch = pending.get(fp);
      if (!batch) {
        batch = { labels: buildSnapshotLabels(baseEntries, sumName, pointAttrs), timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(sum);
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
  baseHash: number,
  baseSize: number,
  pending: Map<string, PendingSeriesSamples>,
  result: IngestResult,
): void {
  const bucketName = `${metricName}_bucket`;
  const countName = `${metricName}_count`;
  const sumName = `${metricName}_sum`;
  const bucketMetricHash = fnvHashEntry(baseHash, '__name__', bucketName);
  const countMetricHash = fnvHashEntry(baseHash, '__name__', countName);
  const sumMetricHash = fnvHashEntry(baseHash, '__name__', sumName);
  const metricSize = baseSize + 1;

  for (const point of points) {
    result.pointsSeen++;
    const ts = normalizeTimestamp(point.timeUnixNano);
    if (ts === null) {
      result.errors++;
      result.dropped++;
      continue;
    }

    const scale = toNumber(point.scale ?? null);
    const pointAttrs = cachedFlattenAttributes(point.attributes);
    let inserted = 0;

    inserted += ingestExpBuckets(
      bucketName, bucketMetricHash, metricSize, pointAttrs, ts, scale,
      'positive', point.positive, baseEntries, pending,
    );
    inserted += ingestExpBuckets(
      bucketName, bucketMetricHash, metricSize, pointAttrs, ts, scale,
      'negative', point.negative, baseEntries, pending,
    );

    // Zero count.
    const zeroCount = toNumber(point.zeroCount ?? null);
    if (zeroCount !== null) {
      computePointAttrsHash(bucketMetricHash, pointAttrs);
      let hash = fnvHashEntry(_phHash, 'exp_bucket', 'zero');
      let size = metricSize + _phCount + 1;
      if (scale !== null) {
        hash = fnvHashEntry(hash, 'exp_scale', numericLabel(scale));
        size++;
      }
      const fp = toFingerprint(hash, size);
      let batch = pending.get(fp);
      if (!batch) {
        const labels = buildSnapshotLabels(baseEntries, bucketName, pointAttrs);
        labels.set('exp_bucket', 'zero');
        if (scale !== null) labels.set('exp_scale', numericLabel(scale));
        batch = { labels, timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(zeroCount);
      inserted++;
    }

    const count = toNumber(point.count ?? null);
    if (count !== null) {
      computePointAttrsHash(countMetricHash, pointAttrs);
      const fp = toFingerprint(_phHash, metricSize + _phCount);
      let batch = pending.get(fp);
      if (!batch) {
        batch = { labels: buildSnapshotLabels(baseEntries, countName, pointAttrs), timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(count);
      inserted++;
    }

    const sum = toNumber(point.sum ?? null);
    if (sum !== null) {
      computePointAttrsHash(sumMetricHash, pointAttrs);
      const fp = toFingerprint(_phHash, metricSize + _phCount);
      let batch = pending.get(fp);
      if (!batch) {
        batch = { labels: buildSnapshotLabels(baseEntries, sumName, pointAttrs), timestamps: [], values: [] };
        pending.set(fp, batch);
      }
      batch.timestamps.push(ts);
      batch.values.push(sum);
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
  bucketName: string,
  bucketMetricHash: number,
  metricSize: number,
  pointAttrs: Record<string, unknown>,
  ts: bigint,
  scale: number | null,
  side: 'positive' | 'negative',
  buckets: { offset?: string | number; bucketCounts?: readonly (string | number)[] } | undefined,
  baseEntries: ReadonlyArray<readonly [string, string]>,
  pending: Map<string, PendingSeriesSamples>,
): number {
  const offset = toNumber(buckets?.offset ?? null) ?? 0;
  const counts = parseNumberArray(buckets?.bucketCounts);
  if (counts.length === 0) return 0;

  // Hash: bucketMetricHash + pointAttrs + exp_side + exp_scale + exp_bucket
  computePointAttrsHash(bucketMetricHash, pointAttrs);
  let sideHash = fnvHashEntry(_phHash, 'exp_side', side);
  let sideSize = metricSize + _phCount + 1;
  if (scale !== null) {
    sideHash = fnvHashEntry(sideHash, 'exp_scale', numericLabel(scale));
    sideSize++;
  }

  let inserted = 0;
  for (let i = 0; i < counts.length; i++) {
    const value = counts[i] ?? 0;
    const bucketLabel = numericLabel(offset + i);
    const hash = fnvHashEntry(sideHash, 'exp_bucket', bucketLabel);
    const fp = toFingerprint(hash, sideSize + 1);

    let batch = pending.get(fp);
    if (!batch) {
      const labels = buildSnapshotLabels(baseEntries, bucketName, pointAttrs);
      labels.set('exp_side', side);
      if (scale !== null) labels.set('exp_scale', numericLabel(scale));
      labels.set('exp_bucket', bucketLabel);
      batch = { labels, timestamps: [], values: [] };
      pending.set(fp, batch);
    }
    batch.timestamps.push(ts);
    batch.values.push(value);
    inserted++;
  }
  return inserted;
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
