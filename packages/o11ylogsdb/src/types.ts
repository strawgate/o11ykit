/**
 * OTLP-logs-aligned types for the o11ylogsdb engine.
 *
 * Mirrors the OpenTelemetry log data model
 * (https://opentelemetry.io/docs/specs/otel/logs/data-model/) but
 * uses a JS-friendly shape: BigInt timestamps, plain objects for
 * AnyValue/KeyValueList. Conversion to/from OTLP/proto and OTLP/JSON
 * lives in `@otlpkit/otlpjson`-style adapters; this module is the
 * engine's internal vocabulary.
 */

/** OTLP severity_text canonical values. */
export type SeverityText = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/** OTLP `AnyValue` — recursive primitive / list / map. */
export type AnyValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | AnyValue[]
  | { [key: string]: AnyValue };

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface Resource {
  attributes: KeyValue[];
  droppedAttributesCount?: number;
}

export interface InstrumentationScope {
  name: string;
  version?: string;
  attributes?: KeyValue[];
}

/** Internal LogRecord shape — one row in a chunk. */
export interface LogRecord {
  timeUnixNano: bigint;
  observedTimeUnixNano?: bigint;
  /** SeverityNumber 1..24 per OTLP. */
  severityNumber: number;
  severityText: SeverityText | string;
  body: AnyValue;
  attributes: KeyValue[];
  droppedAttributesCount?: number;
  flags?: number;
  /** 16-byte W3C trace_id, or undefined if absent. */
  traceId?: Uint8Array;
  /** 8-byte W3C span_id, or undefined if absent. */
  spanId?: Uint8Array;
  /** OTLP 1.4+ event name. */
  eventName?: string;
}

/**
 * Body shape, classified at ingest. The classifier picks one and the
 * codec dispatch routes accordingly.
 */
export type BodyKind = "templated" | "freetext" | "kvlist" | "bytes" | "primitive";

/** A grouping of (resource, scope) under which logs share metadata. */
export interface StreamKey {
  resource: Resource;
  scope: InstrumentationScope;
}

/** Stable identity for a stream — hash-derived. */
export type StreamId = number;
