/**
 * Aggregation pipeline for o11ytracesdb.
 *
 * Provides post-query aggregation functions inspired by TraceQL and Honeycomb:
 * count, avg, min, max, sum, percentile, and groupBy.
 *
 * Works on query results (Trace[] or SpanRecord[]) to compute
 * summary statistics without a second scan of the store.
 */

import type { AnyValue, KeyValue, SpanRecord, Trace } from "./types.js";

// ─── Aggregation result types ────────────────────────────────────────

/** Result of a numeric aggregation (avg, min, max, sum, percentile). */
export interface AggregationResult {
  /** The aggregation function applied. */
  fn: string;
  /** The field aggregated (e.g. "duration", "span.http.status_code"). */
  field: string;
  /** Computed value. */
  value: number;
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

type NumberExtractor = (item: Trace | SpanRecord) => number | null;

function isTrace(item: Trace | SpanRecord): item is Trace {
  return "spans" in item && Array.isArray((item as Trace).spans);
}

/** Extract a numeric value from a trace or span by field name. */
function extractNumber(item: Trace | SpanRecord, field: string): number | null {
  if (isTrace(item)) {
    switch (field) {
      case "duration": return Number(item.durationNanos);
      case "spanCount": return item.spans.length;
      default: return null;
    }
  }
  // SpanRecord
  const span = item as SpanRecord;
  switch (field) {
    case "duration": return Number(span.durationNanos);
    case "startTime": return Number(span.startTimeUnixNano);
    default: {
      // Try attribute lookup: "span.http.status_code" or just "http.status_code"
      const key = field.startsWith("span.") ? field.slice(5) : field;
      const attr = span.attributes.find((a: KeyValue) => a.key === key);
      if (attr !== undefined && typeof attr.value === "number") return attr.value;
      if (attr !== undefined && typeof attr.value === "bigint") return Number(attr.value);
      return null;
    }
  }
}

/** Extract a string group key from a trace or span. */
function extractGroupKey(item: Trace | SpanRecord, field: string): string {
  if (isTrace(item)) {
    switch (field) {
      case "rootService": {
        const root = item.rootSpan;
        if (!root) return "<no root>";
        const svc = root.attributes.find((a: KeyValue) => a.key === "service.name");
        return svc ? String(svc.value) : "<unknown>";
      }
      case "rootName":
        return item.rootSpan?.name ?? "<no root>";
      default: return "<unknown>";
    }
  }
  const span = item as SpanRecord;
  switch (field) {
    case "name": return span.name;
    case "status":
      return span.statusCode === 0 ? "UNSET" : span.statusCode === 1 ? "OK" : "ERROR";
    case "kind":
      return ["UNSPECIFIED", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"][span.kind] ?? "UNKNOWN";
    default: {
      const key = field.startsWith("span.") ? field.slice(5) : field;
      const attr = span.attributes.find((a: KeyValue) => a.key === key);
      return attr !== undefined ? String(attr.value) : "<missing>";
    }
  }
}

// ─── Core aggregation functions ──────────────────────────────────────

function computeCount(values: number[]): number {
  return values.length;
}

function computeAvg(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function computeMin(values: number[]): number {
  if (values.length === 0) return 0;
  let min = values[0]!;
  for (let i = 1; i < values.length; i++) if (values[i]! < min) min = values[i]!;
  return min;
}

function computeMax(values: number[]): number {
  if (values.length === 0) return 0;
  let max = values[0]!;
  for (let i = 1; i < values.length; i++) if (values[i]! > max) max = values[i]!;
  return max;
}

function computeSum(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum;
}

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
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
  /** Field to aggregate. For traces: "duration", "spanCount".
   *  For spans: "duration", or attribute key like "http.status_code". */
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
  groupBy?: string[],
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
  groupBy?: string[],
): AggregationPipelineResult {
  if (groupBy !== undefined && groupBy.length > 0) {
    return aggregateGrouped(spans as readonly (Trace | SpanRecord)[], specs, groupBy);
  }
  return aggregateFlat(spans as readonly (Trace | SpanRecord)[], specs, spans.length);
}

function aggregateFlat(
  items: readonly (Trace | SpanRecord)[],
  specs: AggregationSpec[],
  totalCount: number,
): AggregationPipelineResult {
  const results: AggregationResult[] = [];

  for (const spec of specs) {
    if (spec.fn === "count") {
      results.push({ fn: "count", field: spec.field ?? "*", value: items.length, count: items.length });
      continue;
    }

    const field = spec.field ?? "duration";
    const values: number[] = [];
    for (const item of items) {
      const v = extractNumber(item, field);
      if (v !== null) values.push(v);
    }

    let value: number;
    switch (spec.fn) {
      case "avg": value = computeAvg(values); break;
      case "min": value = computeMin(values); break;
      case "max": value = computeMax(values); break;
      case "sum": value = computeSum(values); break;
      case "p50": value = computePercentile(values, 50); break;
      case "p90": value = computePercentile(values, 90); break;
      case "p95": value = computePercentile(values, 95); break;
      case "p99": value = computePercentile(values, 99); break;
    }

    results.push({ fn: spec.fn, field, value, count: values.length });
  }

  return { results, groups: [], totalCount };
}

function aggregateGrouped(
  items: readonly (Trace | SpanRecord)[],
  specs: AggregationSpec[],
  groupBy: string[],
): AggregationPipelineResult {
  // Build groups
  const groupMap = new Map<string, (Trace | SpanRecord)[]>();

  for (const item of items) {
    const keyParts: string[] = [];
    for (const field of groupBy) {
      keyParts.push(extractGroupKey(item, field));
    }
    const key = keyParts.join("\0");
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
    const keyParts = key.split("\0");
    const groupKey: Record<string, string> = {};
    for (let i = 0; i < groupBy.length; i++) {
      groupKey[groupBy[i]!] = keyParts[i]!;
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
