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
  /** Timestamps in milliseconds (Number, not BigInt) for fast accumulation. */
  timestamps: number[];
  values: number[];
}

export interface ParsedOtlpResult {
  pending: Map<number, PendingSeriesSamples>;
  result: IngestResult;
}

const SCOPE_NAME_LABEL = "otel.scope.name";
const SCOPE_VERSION_LABEL = "otel.scope.version";
const ATTR_PREFIX_RESOURCE = "resource.";
const ATTR_PREFIX_SCOPE = "scope_attr.";
const ATTR_PREFIX_POINT = "attr.";

const SANITIZE_RE = /[^a-zA-Z0-9_]/gu;

function sanitizeLabelKey(key: string): string {
  // Fast path: skip regex if key is already clean (alphanumeric + underscore).
  let clean = true;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) {
      clean = false;
      break;
    }
  }
  if (clean) return key;
  return key.replace(SANITIZE_RE, "_");
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
  hash ^= 0xff;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  hash = fnvHashString(hash, value);
  hash ^= 0xfe;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  return hash;
}

// Module-level output slots to avoid tuple allocation in hot loop.
let _phHash = 0;
let _phCount = 0;

// Cache the last computePointAttrsHash result. Consecutive points
// in the same metric with the same attributes ref will hit this.
let _paBaseHash = 0;
let _paAttrsRef: Record<string, unknown> | undefined;

function computePointAttrsHash(baseHash: number, pointAttrs: Record<string, unknown>): void {
  if (pointAttrs === _paAttrsRef && baseHash === _paBaseHash) return;
  let hash = baseHash;
  let count = 0;
  for (const key of Object.keys(pointAttrs)) {
    hash = fnvHashEntry(
      hash,
      `${ATTR_PREFIX_POINT}${sanitizeLabelKey(key)}`,
      attributeValueToLabel(pointAttrs[key])
    );
    count++;
  }
  _phHash = hash;
  _phCount = count;
  _paBaseHash = baseHash;
  _paAttrsRef = pointAttrs;
}

function toFingerprint(hash: number, size: number): number {
  // Combine two independent 32-bit mixes into a single 53-bit safe integer.
  // Birthday collision bound for 53 bits: ~94M series before p=0.5.
  const h1 = Math.imul((hash ^ size) >>> 0, FNV_PRIME) >>> 0;
  const h2 = Math.imul((hash ^ Math.imul(size, 0x9e3779b9)) >>> 0, 0x517cc1b7) >>> 0;
  return (h1 & 0x1fffff) * 0x100000000 + h2;
}

function buildSnapshotLabels(
  baseEntries: ReadonlyArray<readonly [string, string]>,
  metricName: string,
  pointAttrs: Record<string, unknown>
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const e of baseEntries) {
    labels.set(e[0], e[1]);
  }
  labels.set("__name__", metricName);
  for (const key of Object.keys(pointAttrs)) {
    labels.set(
      `${ATTR_PREFIX_POINT}${sanitizeLabelKey(key)}`,
      attributeValueToLabel(pointAttrs[key])
    );
  }
  return labels;
}

// ── T5: flattenAttributes cache ─────────────────────────────────────
let cachedAttrRef: readonly OtlpKeyValue[] | undefined;
let cachedAttrResult: Record<string, unknown> = {};

function cachedFlattenAttributes(
  attrs: readonly OtlpKeyValue[] | undefined
): Record<string, unknown> {
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

  return ingestMetricsDocument(document, result);
}

/**
 * Ingest a typed OTLP metrics document directly, skipping JSON.parse,
 * detectSignal, and isMetricsDocument. Use when the caller has already
 * validated the payload type (e.g. worker protocol).
 *
 * @param msToNs - Optional converter from millisecond timestamps to nanosecond
 *   BigInt64Array. Receives a **Float64Array of milliseconds** (already
 *   truncated by normalizeTimestamp — sub-ms precision is lost). Must return a
 *   BigInt64Array of nanosecond epoch values. Pass `wc.msToNs` from
 *   {@link WasmCodecs} for a SIMD-accelerated (~12×) implementation.
 */
export function ingestOtlpObject(
  document: OtlpMetricsDocument,
  storage: StorageBackend,
  msToNs?: (ms: Float64Array) => BigInt64Array
): IngestResult {
  const result = emptyResult();
  const { pending } = ingestMetricsDocument(document, result);
  flushSamplesToStorage(pending, storage, result, msToNs);
  return result;
}

function ingestMetricsDocument(
  document: OtlpMetricsDocument,
  result: IngestResult
): ParsedOtlpResult {
  const pending = new Map<number, PendingSeriesSamples>();

  for (const resourceMetrics of document.resourceMetrics) {
    const resourceAttrs = flattenAttributes(resourceMetrics.resource?.attributes);

    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      const scope = scopeMetrics.scope;
      const scopeAttrs = flattenAttributes(scope?.attributes);

      // Pre-compute base labels and base hash once per scope.
      const baseEntries: Array<[string, string]> = [];
      baseEntries.push([SCOPE_NAME_LABEL, scope?.name ?? ""]);
      baseEntries.push([SCOPE_VERSION_LABEL, scope?.version ?? ""]);
      for (const [key, value] of Object.entries(resourceAttrs)) {
        baseEntries.push([
          `${ATTR_PREFIX_RESOURCE}${sanitizeLabelKey(key)}`,
          attributeValueToLabel(value),
        ]);
      }
      for (const [key, value] of Object.entries(scopeAttrs)) {
        baseEntries.push([
          `${ATTR_PREFIX_SCOPE}${sanitizeLabelKey(key)}`,
          attributeValueToLabel(value),
        ]);
      }

      let baseHash = FNV_OFFSET >>> 0;
      for (const e of baseEntries) {
        baseHash = fnvHashEntry(baseHash, e[0], e[1]);
      }
      const baseSize = baseEntries.length;

      for (const metric of scopeMetrics.metrics ?? []) {
        if (metric.gauge?.dataPoints) {
          result.metricTypeCounts.gauge++;
          ingestNumberPoints(
            metric.name,
            metric.gauge.dataPoints,
            baseEntries,
            baseHash,
            baseSize,
            pending,
            result
          );
        }

        if (metric.sum?.dataPoints) {
          result.metricTypeCounts.sum++;
          ingestNumberPoints(
            metric.name,
            metric.sum.dataPoints,
            baseEntries,
            baseHash,
            baseSize,
            pending,
            result
          );
        }

        if (metric.histogram?.dataPoints) {
          result.metricTypeCounts.histogram++;
          ingestHistogramPoints(
            metric.name,
            metric.histogram.dataPoints,
            baseEntries,
            baseHash,
            baseSize,
            pending,
            result
          );
        }

        if (metric.summary?.dataPoints) {
          result.metricTypeCounts.summary++;
          ingestSummaryPoints(
            metric.name,
            metric.summary.dataPoints,
            baseEntries,
            baseHash,
            baseSize,
            pending,
            result
          );
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
            result
          );
        }
      }
    }
  }

  return { pending, result };
}

/**
 * Parse and ingest OTLP metrics in one step (convenience wrapper).
 *
 * @param msToNs - Optional converter from millisecond timestamps to nanosecond
 *   BigInt64Array. Receives a **Float64Array of milliseconds** (already
 *   truncated by normalizeTimestamp — sub-ms precision is lost). Must return a
 *   BigInt64Array of nanosecond epoch values. Pass `wc.msToNs` from
 *   {@link WasmCodecs} for a SIMD-accelerated (~12×) implementation.
 */
export function ingestOtlpJson(
  payload: unknown,
  storage: StorageBackend,
  msToNs?: (ms: Float64Array) => BigInt64Array
): IngestResult {
  const { pending, result } = parseOtlpToSamples(payload);
  flushSamplesToStorage(pending, storage, result, msToNs);
  return result;
}

/**
 * Flush parsed samples to a storage backend.
 *
 * @param msToNs — Optional WASM SIMD accelerator that converts millisecond
 *   timestamps (Float64Array) to nanoseconds (BigInt64Array). ~12× faster
 *   than the scalar BigInt fallback loop.
 */
export function flushSamplesToStorage(
  pending: Map<number, PendingSeriesSamples>,
  storage: StorageBackend,
  result: IngestResult,
  msToNs?: (ms: Float64Array) => BigInt64Array
): void {
  const beforeSeries = storage.seriesCount;

  for (const batch of pending.values()) {
    const len = batch.timestamps.length;
    if (len === 0) continue;

    const id = storage.getOrCreateSeries(batch.labels);
    const msArr = batch.timestamps;

    let tsArr: BigInt64Array;
    if (msToNs) {
      // WASM SIMD ms→ns — ~12× faster than BigInt loop.
      tsArr = msToNs(Float64Array.from(msArr));
    } else {
      tsArr = new BigInt64Array(len);
      for (let i = 0; i < len; i++) {
        const millis = msArr[i];
        if (millis === undefined) {
          throw new RangeError(`missing timestamp at batch index ${i}`);
        }
        tsArr[i] = BigInt(millis) * 1_000_000n;
      }
    }
    storage.appendBatch(id, tsArr, Float64Array.from(batch.values));
    result.samplesInserted += len;
  }

  result.seriesCreated += Math.max(0, storage.seriesCount - beforeSeries);
}

// ── Ingest functions with incremental hashing + lazy snapshots ──────

function ingestNumberPoints(
  metricName: string,
  points: readonly {
    timeUnixNano?: string | number;
    attributes?: readonly OtlpKeyValue[];
    asDouble?: number;
    asInt?: string | number;
  }[],
  baseEntries: Array<[string, string]>,
  baseHash: number,
  baseSize: number,
  pending: Map<number, PendingSeriesSamples>,
  result: IngestResult
): void {
  const metricHash = fnvHashEntry(baseHash, "__name__", metricName);
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
      batch = {
        labels: buildSnapshotLabels(baseEntries, metricName, pointAttrs),
        timestamps: [],
        values: [],
      };
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
  pending: Map<number, PendingSeriesSamples>,
  result: IngestResult
): void {
  const bucketName = `${metricName}_bucket`;
  const countName = `${metricName}_count`;
  const sumName = `${metricName}_sum`;
  const bucketMetricHash = fnvHashEntry(baseHash, "__name__", bucketName);
  const countMetricHash = fnvHashEntry(baseHash, "__name__", countName);
  const sumMetricHash = fnvHashEntry(baseHash, "__name__", sumName);
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
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      const leValue = i < bounds.length ? numericLabel(bounds[i]!) : "+Inf";
      const hash = fnvHashEntry(bucketPointHash, "le", leValue);
      const fp = toFingerprint(hash, pointSize + 1);

      let batch = pending.get(fp);
      if (!batch) {
        const labels = buildSnapshotLabels(baseEntries, bucketName, pointAttrs);
        labels.set("le", leValue);
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
        batch = {
          labels: buildSnapshotLabels(baseEntries, countName, pointAttrs),
          timestamps: [],
          values: [],
        };
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
        batch = {
          labels: buildSnapshotLabels(baseEntries, sumName, pointAttrs),
          timestamps: [],
          values: [],
        };
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
  pending: Map<number, PendingSeriesSamples>,
  result: IngestResult
): void {
  const countName = `${metricName}_count`;
  const sumName = `${metricName}_sum`;
  const mainMetricHash = fnvHashEntry(baseHash, "__name__", metricName);
  const countMetricHash = fnvHashEntry(baseHash, "__name__", countName);
  const sumMetricHash = fnvHashEntry(baseHash, "__name__", sumName);
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
      const hash = fnvHashEntry(mainPointHash, "quantile", qLabel);
      const fp = toFingerprint(hash, pointSize + 1);

      let batch = pending.get(fp);
      if (!batch) {
        const labels = buildSnapshotLabels(baseEntries, metricName, pointAttrs);
        labels.set("quantile", qLabel);
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
        batch = {
          labels: buildSnapshotLabels(baseEntries, countName, pointAttrs),
          timestamps: [],
          values: [],
        };
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
        batch = {
          labels: buildSnapshotLabels(baseEntries, sumName, pointAttrs),
          timestamps: [],
          values: [],
        };
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
  pending: Map<number, PendingSeriesSamples>,
  result: IngestResult
): void {
  const bucketName = `${metricName}_bucket`;
  const countName = `${metricName}_count`;
  const sumName = `${metricName}_sum`;
  const bucketMetricHash = fnvHashEntry(baseHash, "__name__", bucketName);
  const countMetricHash = fnvHashEntry(baseHash, "__name__", countName);
  const sumMetricHash = fnvHashEntry(baseHash, "__name__", sumName);
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
      bucketName,
      bucketMetricHash,
      metricSize,
      pointAttrs,
      ts,
      scale,
      "positive",
      point.positive,
      baseEntries,
      pending
    );
    inserted += ingestExpBuckets(
      bucketName,
      bucketMetricHash,
      metricSize,
      pointAttrs,
      ts,
      scale,
      "negative",
      point.negative,
      baseEntries,
      pending
    );

    // Zero count.
    const zeroCount = toNumber(point.zeroCount ?? null);
    if (zeroCount !== null) {
      computePointAttrsHash(bucketMetricHash, pointAttrs);
      let hash = fnvHashEntry(_phHash, "exp_bucket", "zero");
      let size = metricSize + _phCount + 1;
      if (scale !== null) {
        hash = fnvHashEntry(hash, "exp_scale", numericLabel(scale));
        size++;
      }
      const fp = toFingerprint(hash, size);
      let batch = pending.get(fp);
      if (!batch) {
        const labels = buildSnapshotLabels(baseEntries, bucketName, pointAttrs);
        labels.set("exp_bucket", "zero");
        if (scale !== null) labels.set("exp_scale", numericLabel(scale));
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
        batch = {
          labels: buildSnapshotLabels(baseEntries, countName, pointAttrs),
          timestamps: [],
          values: [],
        };
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
        batch = {
          labels: buildSnapshotLabels(baseEntries, sumName, pointAttrs),
          timestamps: [],
          values: [],
        };
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
  ts: number,
  scale: number | null,
  side: "positive" | "negative",
  buckets: { offset?: string | number; bucketCounts?: readonly (string | number)[] } | undefined,
  baseEntries: ReadonlyArray<readonly [string, string]>,
  pending: Map<number, PendingSeriesSamples>
): number {
  const offset = toNumber(buckets?.offset ?? null) ?? 0;
  const counts = parseNumberArray(buckets?.bucketCounts);
  if (counts.length === 0) return 0;

  // Hash: bucketMetricHash + pointAttrs + exp_side + exp_scale + exp_bucket
  computePointAttrsHash(bucketMetricHash, pointAttrs);
  let sideHash = fnvHashEntry(_phHash, "exp_side", side);
  let sideSize = metricSize + _phCount + 1;
  if (scale !== null) {
    sideHash = fnvHashEntry(sideHash, "exp_scale", numericLabel(scale));
    sideSize++;
  }

  let inserted = 0;
  for (let i = 0; i < counts.length; i++) {
    const value = counts[i] ?? 0;
    const bucketLabel = numericLabel(offset + i);
    const hash = fnvHashEntry(sideHash, "exp_bucket", bucketLabel);
    const fp = toFingerprint(hash, sideSize + 1);

    let batch = pending.get(fp);
    if (!batch) {
      const labels = buildSnapshotLabels(baseEntries, bucketName, pointAttrs);
      labels.set("exp_side", side);
      if (scale !== null) labels.set("exp_scale", numericLabel(scale));
      labels.set("exp_bucket", bucketLabel);
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
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
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

// ── Timestamp normalization → milliseconds as Number ────────────────
// Returns ms-precision Number timestamps. Avoids BigInt allocation in
// the hot path; conversion to nanosecond BigInt64Array happens once at
// flush time. Sub-ms precision from nanosecond strings is truncated.

const MS_THRESHOLD = 10_000_000_000_000; // 10^13

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "string") {
    if (value.length === 0) return null;
    // Fast path: digit-scan + manual accumulate for first 13 chars.
    const len = value.length;
    const end = len > 13 ? 13 : len;
    let n = 0;
    for (let i = 0; i < end; i++) {
      const c = value.charCodeAt(i) - 48;
      if (c < 0 || c > 9) {
        // Not a pure digit string — fall back to Date.parse.
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : ms;
      }
      n = n * 10 + c;
    }
    // Verify remaining digits (sub-ms portion of nanosecond strings).
    for (let i = end; i < len; i++) {
      const c = value.charCodeAt(i) - 48;
      if (c < 0 || c > 9) {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : ms;
      }
    }
    // n is now the first min(13, len) digits.
    // ≤13 digits & ≤ threshold → treat as ms; otherwise n is already ms
    // (first 13 digits of a nanosecond value).
    return n;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > MS_THRESHOLD ? Math.trunc(value / 1_000_000) : Math.trunc(value);
  }
  if (typeof value === "bigint") {
    const abs = value < 0n ? -value : value;
    return Number(abs > 10_000_000_000_000n ? value / 1_000_000n : value);
  }
  return null;
}

export function isDeltaTemporality(aggregationTemporality: number | undefined): boolean {
  return aggregationTemporality === 1;
}

export type { OtlpMetricsDocument };
