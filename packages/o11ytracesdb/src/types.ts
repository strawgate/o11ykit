/**
 * Engine-internal types for o11ytracesdb.
 *
 * OTLP primitives that every `*db` engine consumes (AnyValue, KeyValue,
 * Resource, InstrumentationScope, StreamId) live in `stardb` — re-exported
 * here so callers keep a single import path. The remaining types in this
 * file (SpanRecord, SpanEvent, SpanLink, SpanKind, StatusCode) are specific
 * to the traces engine.
 */

import type {
  AnyValue,
  InstrumentationScope,
  KeyValue,
  Resource,
  StreamId,
} from "stardb";

export type { AnyValue, InstrumentationScope, KeyValue, Resource, StreamId };

// ─── Span Kind (OTLP SpanKind enum) ─────────────────────────────────

/** OTLP SpanKind as numeric enum values. */
export const SpanKind = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

// ─── Status Code ─────────────────────────────────────────────────────

/** OTLP StatusCode as numeric enum values. */
export const StatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export type StatusCode = (typeof StatusCode)[keyof typeof StatusCode];

// ─── Span Event ──────────────────────────────────────────────────────

/** A timestamped event attached to a span. */
export interface SpanEvent {
  /** Event timestamp in nanoseconds since epoch. */
  timeUnixNano: bigint;
  /** Event name (e.g. "exception", "message"). */
  name: string;
  /** Event attributes. */
  attributes: KeyValue[];
  droppedAttributesCount?: number;
}

// ─── Span Link ───────────────────────────────────────────────────────

/** A causal link to another span (cross-trace or within-trace). */
export interface SpanLink {
  /** 16-byte W3C trace ID of the linked span. */
  traceId: Uint8Array;
  /** 8-byte span ID of the linked span. */
  spanId: Uint8Array;
  /** Link attributes. */
  attributes: KeyValue[];
  /** Optional trace state. */
  traceState?: string;
  droppedAttributesCount?: number;
}

// ─── Span Record ─────────────────────────────────────────────────────

/**
 * Internal SpanRecord shape — one row in a chunk.
 *
 * Binary IDs are stored as Uint8Array (16 bytes for trace_id, 8 bytes
 * for span_id/parent_span_id) for zero-overhead columnar storage.
 * Timestamps are bigint nanoseconds for consistency with OTLP and the
 * sibling engines.
 */
export interface SpanRecord {
  /** 16-byte W3C trace ID. */
  traceId: Uint8Array;
  /** 8-byte span ID. */
  spanId: Uint8Array;
  /** 8-byte parent span ID, or undefined for root spans. */
  parentSpanId?: Uint8Array;
  /** Trace state string (W3C tracestate header). */
  traceState?: string;
  /** Operation/span name (e.g. "HTTP GET /api/users"). */
  name: string;
  /** Span kind (SERVER, CLIENT, INTERNAL, PRODUCER, CONSUMER). */
  kind: SpanKind;
  /** Start time in nanoseconds since epoch. */
  startTimeUnixNano: bigint;
  /** End time in nanoseconds since epoch. */
  endTimeUnixNano: bigint;
  /** Duration in nanoseconds (derived: end - start). */
  durationNanos: bigint;
  /** Status code (UNSET, OK, ERROR). */
  statusCode: StatusCode;
  /** Status message (typically only set on ERROR). */
  statusMessage?: string;
  /** Span attributes. */
  attributes: KeyValue[];
  droppedAttributesCount?: number;
  /** Span events (timestamped annotations). */
  events: SpanEvent[];
  droppedEventsCount?: number;
  /** Span links (causal relationships to other spans). */
  links: SpanLink[];
  droppedLinksCount?: number;
  /**
   * Nested set left boundary (computed at flush time).
   * Used for O(1) ancestor/descendant checks:
   *   A is ancestor of B iff A.nestedSetLeft < B.nestedSetLeft && B.nestedSetRight < A.nestedSetRight
   */
  nestedSetLeft?: number;
  /** Nested set right boundary. */
  nestedSetRight?: number;
  /** Numeric parent ID (nestedSetLeft of parent span, 0 for roots). */
  nestedSetParent?: number;
}

// ─── Stream Key ──────────────────────────────────────────────────────

/** A grouping of (resource, scope) under which spans share metadata. */
export interface StreamKey {
  resource: Resource;
  scope: InstrumentationScope;
}

// ─── Query-related types ─────────────────────────────────────────────

/** A fully assembled trace — all spans belonging to one trace ID. */
export interface Trace {
  /** 16-byte trace ID. */
  traceId: Uint8Array;
  /** Root span (parentSpanId === undefined), if present. */
  rootSpan?: SpanRecord;
  /** All spans in this trace, ordered by startTimeUnixNano. */
  spans: SpanRecord[];
  /** Total trace duration (root end - root start, or max end - min start). */
  durationNanos: bigint;
}

/** A node in the span tree — used for tree assembly and critical path. */
export interface SpanNode {
  span: SpanRecord;
  children: SpanNode[];
  /** Self-time = duration - sum(overlapping children durations). */
  selfTimeNanos: bigint;
  /** Depth from root (root = 0). */
  depth: number;
}

/** Query options for trace search. */
export interface TraceQueryOpts {
  /** Find spans/traces within this time window. */
  startTimeNano?: bigint;
  endTimeNano?: bigint;
  /** Filter by trace ID (exact match). */
  traceId?: Uint8Array;
  /** Filter by service name (resource attribute). */
  serviceName?: string;
  /** Filter by span name (operation). */
  spanName?: string;
  /** Filter by minimum duration (nanoseconds). */
  minDurationNanos?: bigint;
  /** Filter by maximum duration (nanoseconds). */
  maxDurationNanos?: bigint;
  /** Filter by status code. */
  statusCode?: StatusCode;
  /** Filter by span kind. */
  kind?: SpanKind;
  /** Attribute key-value equality predicates. */
  attributes?: { key: string; value: AnyValue }[];
  /** Maximum number of traces to return. */
  limit?: number;
}

/** Result of a trace query. */
export interface TraceQueryResult {
  /** Matching traces, each assembled with all their spans. */
  traces: Trace[];
  /** Number of chunks scanned. */
  chunksScanned: number;
  /** Number of chunks pruned (skipped via filters). */
  chunksPruned: number;
  /** Total spans examined. */
  spansExamined: number;
}
