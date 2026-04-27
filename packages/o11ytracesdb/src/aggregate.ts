/**
 * Aggregation pipeline for o11ytracesdb.
 *
 * Provides post-query aggregation functions inspired by TraceQL and Honeycomb:
 * count, avg, min, max, sum, percentile, and groupBy.
 *
 * Works on query results (Trace[] or SpanRecord[]) to compute
 * summary statistics without a second scan of the store.
 */

import type { KeyValue, SpanRecord, Trace } from "./types.js";

// ─── Aggregation result types ────────────────────────────────────────

/** Result of a numeric aggregation (avg, min, max, sum, percentile). */
export interface AggregationResult {
  /** The aggregation function applied. */
  fn: string;
  /** The field aggregated (e.g. "duration", "span.http.status_code"). */
  field: string;
  /**
   * Computed value.
   *
   * Units depend on the field:
   * - `duration` / `durationNanos`: value is in **nanoseconds** (bigint for duration fields, number otherwise).
   * - `startTime`: value is in **milliseconds** (Unix epoch ms) to avoid
   *   BigInt→Number precision loss for nanosecond timestamps.
   * - Attribute fields: value is the raw numeric attribute value.
   */
  value: number | bigint;
  /** Number of input values (some may have been skipped if field was missing). */
  count: number;
}

/** A single group in a grouped aggregation. */
export interface AggregationGroup {
  /** Group key → value pairs. */
  groupKey: Record<string, string>;
  /** Aggregation results for this group. */
  results: AggregationResult[];
  /** Number of traces/spans in this group. */
  count: number;
}

/** Full result of an aggregation pipeline. */
export interface AggregationPipelineResult {
  /** Ungrouped aggregation results (when no groupBy). */
  results: AggregationResult[];
  /** Grouped results (when groupBy is specified). */
  groups: AggregationGroup[];
  /** Total input count (traces or spans depending on mode). */
  totalCount: number;
}

// ─── Value extraction ────────────────────────────────────────────────

function isTrace(item: Trace | SpanRecord): item is Trace {
  return "spans" in item && Array.isArray((item as Trace).spans);
}

/** Extract a numeric value from a trace or span by field name. */
function extractNumber(item: Trace | SpanRecord, field: string): number | bigint | null {
  if (isTrace(item)) {
    switch (field) {
      case "duration":
        return item.durationNanos; // keep as bigint
      case "spanCount":
        return item.spans.length;
      default:
        return null;
    }
  }
  // SpanRecord
  const span = item as SpanRecord;
  switch (field) {
    case "duration":
      return span.durationNanos; // keep as bigint
    case "startTime":
      // Convert nanosecond BigInt to milliseconds before Number() to stay
      // within Number.MAX_SAFE_INTEGER (~9×10¹⁵). Nanosecond timestamps
      // (~1.7×10¹⁸) would lose precision as a Number.
      return Number(span.startTimeUnixNano / 1_000_000n);
    default: {
      // Try attribute lookup: "span.http.status_code" or just "http.status_code"
      const key = field.startsWith("span.") ? field.slice(5) : field;
      const attr = span.attributes.find((a: KeyValue) => a.key === key);
      if (attr !== undefined && typeof attr.value === "number") return attr.value;
      if (attr !== undefined && typeof attr.value === "bigint") return attr.value; // keep as bigint
      return null;
    }
  }
}

/** Extract a string group key from a trace or span. */
function extractGroupKey(item: Trace | SpanRecord, field: string): string {
  if (isTrace(item)) {
    switch (field) {
      case "rootService": {
        const svc =
          item.rootResource?.attributes.find((a: KeyValue) => a.key === "service.name") ??
          item.rootSpan?.attributes.find((a: KeyValue) => a.key === "service.name");
        return svc ? String(svc.value) : item.rootSpan ? "<unknown>" : "<no root>";
      }
      case "rootName":
        return item.rootSpan?.name ?? "<no root>";
      default:
        return "<unknown>";
    }
  }
  const span = item as SpanRecord;
  switch (field) {
    case "name":
      return span.name;
    case "status":
      return span.statusCode === 0 ? "UNSET" : span.statusCode === 1 ? "OK" : "ERROR";
    case "kind":
      return (
        ["UNSPECIFIED", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"][span.kind] ??
        "UNKNOWN"
      );
    default: {
      const key = field.startsWith("span.") ? field.slice(5) : field;
      const attr = span.attributes.find((a: KeyValue) => a.key === key);
      return attr !== undefined ? String(attr.value) : "<missing>";
    }
  }
}

// ─── Core aggregation functions ──────────────────────────────────────

function computeAvg(values: (number | bigint)[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += Number(v);
  return sum / values.length;
}

function computeMin(values: (number | bigint)[]): number | bigint {
  if (values.length === 0) return 0;
  const first = values[0] ?? 0;
  if (typeof first === "bigint") {
    let min = first;
    for (let i = 1; i < values.length; i++) {
      const v = values[i];
      if (typeof v === "bigint" && v < min) min = v;
    }
    return min;
  }
  let min = first as number;
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (typeof v === "number" && v < min) min = v;
  }
  return min;
}

function computeMax(values: (number | bigint)[]): number | bigint {
  if (values.length === 0) return 0;
  const first = values[0] ?? 0;
  if (typeof first === "bigint") {
    let max = first;
    for (let i = 1; i < values.length; i++) {
      const v = values[i];
      if (typeof v === "bigint" && v > max) max = v;
    }
    return max;
  }
  let max = first as number;
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (typeof v === "number" && v > max) max = v;
  }
  return max;
}

function computeSum(values: (number | bigint)[]): number | bigint {
  if (values.length === 0) return 0;
  const first = values[0];
  if (typeof first === "bigint") {
    let sum = 0n;
    for (const v of values) {
      if (typeof v === "bigint") sum += v;
    }
    return sum;
  }
  let sum = 0;
  for (const v of values) sum += Number(v);
  return sum;
}

function computePercentile(values: (number | bigint)[], p: number): number | bigint {
  if (values.length === 0) return 0;
  const first = values[0];
  if (typeof first === "bigint") {
    const sorted = [...values].sort((a, b) => Number(a) - Number(b));
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return (sorted[Math.max(0, idx)] as bigint) ?? 0n;
  }
  const sorted = [...values].sort((a, b) => Number(a) - Number(b));
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return (sorted[Math.max(0, idx)] as number) ?? 0;
}

// ─── Aggregation specs ───────────────────────────────────────────────

/**
 * Specification for a single aggregation function.
 *
 * Supported functions:
 * - `count` — count of items (field ignored)
 * - `avg`, `min`, `max`, `sum` — numeric aggregation on field
 * - `p50`, `p90`, `p95`, `p99` — percentile on field
 */
export interface AggregationSpec {
  fn: "count" | "avg" | "min" | "max" | "sum" | "p50" | "p90" | "p95" | "p99";
  /**
   * Field to aggregate. For traces: "duration", "spanCount".
   * For spans: "duration", "startTime", or attribute key like "http.status_code".
   *
   * Result units:
   * - `"duration"` → nanoseconds
   * - `"startTime"` → milliseconds (Unix epoch ms, converted from BigInt nanos)
   */
  field?: string;
}

// ─── Pipeline execution ──────────────────────────────────────────────

/**
 * Run an aggregation pipeline on traces.
 *
 * @param traces — input traces from a query result
 * @param specs — aggregation functions to compute
 * @param groupBy — optional field(s) to group by (for traces: "rootService", "rootName")
 */
export function aggregateTraces(
  traces: readonly Trace[],
  specs: AggregationSpec[],
  groupBy?: string[]
): AggregationPipelineResult {
  if (groupBy !== undefined && groupBy.length > 0) {
    return aggregateGrouped(traces as readonly (Trace | SpanRecord)[], specs, groupBy);
  }
  return aggregateFlat(traces as readonly (Trace | SpanRecord)[], specs, traces.length);
}

/**
 * Run an aggregation pipeline on spans (flat, no trace assembly).
 *
 * @param spans — input spans
 * @param specs — aggregation functions to compute
 * @param groupBy — optional field(s) to group by (e.g. "name", "status", "kind", or attribute key)
 */
export function aggregateSpans(
  spans: readonly SpanRecord[],
  specs: AggregationSpec[],
  groupBy?: string[]
): AggregationPipelineResult {
  if (groupBy !== undefined && groupBy.length > 0) {
    return aggregateGrouped(spans as readonly (Trace | SpanRecord)[], specs, groupBy);
  }
  return aggregateFlat(spans as readonly (Trace | SpanRecord)[], specs, spans.length);
}

function aggregateFlat(
  items: readonly (Trace | SpanRecord)[],
  specs: AggregationSpec[],
  totalCount: number
): AggregationPipelineResult {
  const results: AggregationResult[] = [];

  for (const spec of specs) {
    if (spec.fn === "count") {
      results.push({
        fn: "count",
        field: spec.field ?? "*",
        value: items.length,
        count: items.length,
      });
      continue;
    }

    const field = spec.field ?? "duration";
    const values: (number | bigint)[] = [];
    for (const item of items) {
      const v = extractNumber(item, field);
      if (v !== null) values.push(v);
    }

    let value: number | bigint;
    switch (spec.fn) {
      case "avg":
        value = computeAvg(values);
        break;
      case "min":
        value = computeMin(values);
        break;
      case "max":
        value = computeMax(values);
        break;
      case "sum":
        value = computeSum(values);
        break;
      case "p50":
        value = computePercentile(values, 50);
        break;
      case "p90":
        value = computePercentile(values, 90);
        break;
      case "p95":
        value = computePercentile(values, 95);
        break;
      case "p99":
        value = computePercentile(values, 99);
        break;
    }

    results.push({ fn: spec.fn, field, value, count: values.length });
  }

  return { results, groups: [], totalCount };
}

function aggregateGrouped(
  items: readonly (Trace | SpanRecord)[],
  specs: AggregationSpec[],
  groupBy: string[]
): AggregationPipelineResult {
  // Build groups
  const groupMap = new Map<string, (Trace | SpanRecord)[]>();

  for (const item of items) {
    const keyParts: string[] = [];
    for (const field of groupBy) {
      keyParts.push(extractGroupKey(item, field));
    }
    const key = JSON.stringify(keyParts);
    let group = groupMap.get(key);
    if (!group) {
      group = [];
      groupMap.set(key, group);
    }
    group.push(item);
  }

  // Aggregate each group
  const groups: AggregationGroup[] = [];
  for (const [key, groupItems] of groupMap) {
    const keyParts = JSON.parse(key) as string[];
    const groupKey: Record<string, string> = {};
    for (let i = 0; i < groupBy.length; i++) {
      const gk = groupBy[i];
      const kp = keyParts[i];
      if (gk !== undefined && kp !== undefined) {
        groupKey[gk] = kp;
      }
    }

    const flatResult = aggregateFlat(groupItems, specs, groupItems.length);
    groups.push({
      groupKey,
      results: flatResult.results,
      count: groupItems.length,
    });
  }

  // Sort groups by count descending
  groups.sort((a, b) => b.count - a.count);

  return { results: [], groups, totalCount: items.length };
}
