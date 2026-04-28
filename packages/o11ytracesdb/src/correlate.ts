/**
 * Cross-signal correlation utilities for o11ytracesdb.
 *
 * Enables the "holy grail" of browser-native observability: zero-latency
 * cross-signal correlation between traces, metrics, and logs without
 * server round-trips. When all three o11y*db engines are co-resident in
 * the browser, this module bridges them.
 *
 * Key patterns:
 * - Time window extraction from traces for querying sibling stores
 * - Trace ID propagation for log correlation
 * - RED metrics derivation (Rate, Error, Duration) from span data
 * - Service graph computation from inter-service spans
 */

import { bytesToHex, findAttribute } from "stardb";
import type { Resource, SpanRecord, Trace } from "./types.js";
import { StatusCode } from "./types.js";

// ─── Time Window Extraction ──────────────────────────────────────────

/**
 * A time window that can be passed to o11ytsdb or o11ylogsdb queries.
 * Uses bigint nanoseconds for consistency with OTLP timestamps.
 */
export interface TimeWindow {
  startNano: bigint;
  endNano: bigint;
}

/**
 * Extract a time window from a trace — useful for querying metrics/logs
 * that overlap with this trace's execution window.
 *
 * Optionally adds padding to capture context before/after the trace.
 */
export function traceTimeWindow(trace: Trace, paddingNanos = 0n): TimeWindow {
  if (trace.spans.length === 0) {
    return { startNano: 0n, endNano: 0n };
  }
  const first = trace.spans[0];
  if (!first) return { startNano: 0n, endNano: 0n };
  let min = first.startTimeUnixNano;
  let max = first.endTimeUnixNano;
  for (const span of trace.spans) {
    if (span.startTimeUnixNano < min) min = span.startTimeUnixNano;
    if (span.endTimeUnixNano > max) max = span.endTimeUnixNano;
  }
  return {
    startNano: min - paddingNanos,
    endNano: max + paddingNanos,
  };
}

/**
 * Extract a time window from a single span — for correlating logs/metrics
 * to a specific operation.
 */
export function spanTimeWindow(span: SpanRecord, paddingNanos = 0n): TimeWindow {
  return {
    startNano: span.startTimeUnixNano - paddingNanos,
    endNano: span.endTimeUnixNano + paddingNanos,
  };
}

// ─── RED Metrics Derivation ──────────────────────────────────────────

/**
 * RED (Rate, Error, Duration) metrics derived from span data.
 * These can be fed into o11ytsdb for metric-based alerting/visualization.
 */
export interface REDMetrics {
  /** Service name (from resource attributes or span attributes). */
  serviceName: string;
  /** Operation/span name. */
  operationName: string;
  /** Time bucket start (nanoseconds). */
  bucketStartNano: bigint;
  /** Number of requests (spans) in this bucket. */
  rate: number;
  /** Number of error spans in this bucket. */
  errors: number;
  /** Error rate (errors / rate). */
  errorRate: number;
  /** Duration statistics. */
  duration: {
    min: bigint;
    max: bigint;
    sum: bigint;
    count: number;
    /** p50 approximation (median of sorted durations). */
    p50: bigint;
    /** p95 approximation. */
    p95: bigint;
    /** p99 approximation. */
    p99: bigint;
  };
}

/**
 * Derive RED metrics from a set of spans, bucketed by time interval.
 *
 * @param spans - Spans to analyze (typically from a query result)
 * @param bucketSizeNanos - Time bucket size in nanoseconds (default: 1 minute)
 * @param serviceName - Service name to label metrics with
 * @returns Array of RED metrics, one per (operation, bucket) pair
 */
export function deriveREDMetrics(
  spans: readonly SpanRecord[],
  bucketSizeNanos = 60_000_000_000n, // 1 minute
  serviceName = "unknown"
): REDMetrics[] {
  if (bucketSizeNanos <= 0n) {
    throw new Error("bucketSizeNanos must be a positive bigint");
  }
  // Group by (operation, bucket) using a composite key with null separator
  // (safe against any characters in span names)
  const groups = new Map<
    string,
    { operationName: string; bucketStartNano: bigint; spans: SpanRecord[] }
  >();
  for (const span of spans) {
    const bucket = span.startTimeUnixNano - (span.startTimeUnixNano % bucketSizeNanos);
    const key = `${span.name}\0${bucket}`;
    let group = groups.get(key);
    if (!group) {
      group = { operationName: span.name, bucketStartNano: bucket, spans: [] };
      groups.set(key, group);
    }
    group.spans.push(span);
  }

  const results: REDMetrics[] = [];
  for (const [, group] of groups) {
    const { operationName, bucketStartNano } = group;

    const durations = group.spans
      .map((s) => s.durationNanos)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const errors = group.spans.filter((s) => s.statusCode === StatusCode.ERROR).length;
    const sum = durations.reduce((acc, d) => acc + d, 0n);
    const firstDur = durations[0] ?? 0n;
    const lastDur = durations[durations.length - 1] ?? 0n;

    results.push({
      serviceName,
      operationName,
      bucketStartNano,
      rate: group.spans.length,
      errors,
      errorRate: group.spans.length > 0 ? errors / group.spans.length : 0,
      duration: {
        min: firstDur,
        max: lastDur,
        sum,
        count: durations.length,
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
      },
    });
  }

  return results.sort((a, b) =>
    a.bucketStartNano < b.bucketStartNano ? -1 : a.bucketStartNano > b.bucketStartNano ? 1 : 0
  );
}

/** Percentile from a sorted array of bigints. */
function percentile(sorted: bigint[], p: number): bigint {
  if (sorted.length === 0) return 0n;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0n;
}

// ─── Service Graph ───────────────────────────────────────────────────

/**
 * An edge in the service graph — represents a call from one service to another.
 */
export interface ServiceGraphEdge {
  /** Calling service name. */
  source: string;
  /** Called service name. */
  target: string;
  /** Number of calls observed. */
  callCount: number;
  /** Number of error calls. */
  errorCount: number;
  /** Total duration of calls (for averaging). */
  totalDurationNanos: bigint;
}

/**
 * Compute a service graph from spans.
 * Identifies CLIENT→SERVER pairs that represent inter-service calls.
 *
 * @param spans - All spans (typically from multiple traces)
 * @param getServiceName - Custom function to extract service name from a span.
 *   The default implementation checks span attributes; for OTLP resource-level
 *   service.name, callers should provide a function that maps spans to their
 *   resource's service.name attribute.
 * @returns Array of service graph edges
 */
export function computeServiceGraph(
  spans: readonly SpanRecord[],
  getServiceName?: (span: SpanRecord) => string | undefined
): ServiceGraphEdge[] {
  const svcName = getServiceName ?? defaultServiceName;

  // Build reverse index: parentSpanId hex → child SERVER spans (O(n))
  const serverChildrenByParent = new Map<string, SpanRecord[]>();
  for (const span of spans) {
    if (span.kind !== 2) continue; // SERVER only
    if (!span.parentSpanId) continue;
    const parentHex = `${bytesToHex(span.traceId)}:${bytesToHex(span.parentSpanId)}`;
    let children = serverChildrenByParent.get(parentHex);
    if (!children) {
      children = [];
      serverChildrenByParent.set(parentHex, children);
    }
    children.push(span);
  }

  // Find CLIENT spans and look up their child SERVER spans via index (O(n))
  const edges = new Map<string, ServiceGraphEdge>();
  for (const span of spans) {
    if (span.kind !== 3) continue; // CLIENT spans only

    const source = svcName(span);
    if (!source) continue;

    const myId = `${bytesToHex(span.traceId)}:${bytesToHex(span.spanId)}`;
    const children = serverChildrenByParent.get(myId);
    if (!children) continue;

    for (const candidate of children) {
      const target = svcName(candidate);
      if (!target || target === source) continue;

      const edgeKey = `${source}→${target}`;
      let edge = edges.get(edgeKey);
      if (!edge) {
        edge = { source, target, callCount: 0, errorCount: 0, totalDurationNanos: 0n };
        edges.set(edgeKey, edge);
      }
      edge.callCount++;
      if (candidate.statusCode === StatusCode.ERROR) edge.errorCount++;
      edge.totalDurationNanos += candidate.durationNanos;
    }
  }

  return [...edges.values()];
}

export function defaultServiceName(span: SpanRecord, resource?: Resource): string | undefined {
  // In OTLP, service.name is a resource attribute — check resource first
  if (resource) {
    const svc = findAttribute(resource.attributes, "service.name");
    if (typeof svc === "string") return svc;
  }
  // Fall back to span attributes as a last resort
  const svc = findAttribute(span.attributes, "service.name");
  if (typeof svc === "string") return svc;
  return undefined;
}

// ─── Trace ID Correlation ────────────────────────────────────────────

/**
 * Extract all unique trace IDs from spans as hex strings.
 * Useful for querying o11ylogsdb by trace_id to find correlated logs.
 */
export function extractTraceIds(spans: readonly SpanRecord[]): string[] {
  const seen = new Set<string>();
  for (const span of spans) {
    seen.add(bytesToHex(span.traceId));
  }
  return [...seen];
}

/**
 * Extract all unique service names from spans.
 * Useful for scoping metrics queries to relevant services.
 */
export function extractServiceNames(spans: readonly SpanRecord[]): string[] {
  const seen = new Set<string>();
  for (const span of spans) {
    const name = defaultServiceName(span);
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * Creates a service name extractor that uses resource attributes first,
 * then falls back to span attributes. Use this with computeServiceGraph
 * and extractServiceNames when you have access to a resource-to-span mapping.
 *
 * @example
 * const spanResources = new Map(spans.map(s => [s, resource]));
 * computeServiceGraph(spans, makeResourceAwareExtractor(spanResources));
 */
export function makeResourceAwareExtractor(
  spanToResource: Map<SpanRecord, Resource>
): (span: SpanRecord) => string | undefined {
  return (span: SpanRecord) => {
    const resource = spanToResource.get(span);
    return defaultServiceName(span, resource);
  };
}
