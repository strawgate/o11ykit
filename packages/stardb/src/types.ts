/**
 * OTLP-aligned types shared across the o11ykit `*db` engines.
 *
 * Mirrors the OpenTelemetry data model
 * (https://opentelemetry.io/docs/specs/otel/logs/data-model/) but uses
 * a JS-friendly shape: BigInt timestamps, plain objects for
 * AnyValue/KeyValueList. Conversion to/from OTLP/proto and OTLP/JSON
 * lives in `@otlpkit/otlpjson`-style adapters; this module is the
 * common ingest vocabulary every engine speaks.
 *
 * Engine-specific record shapes (LogRecord, MetricSample, SpanRecord)
 * stay in their own packages — only the OTLP primitives that every
 * engine consumes belong here.
 */

/** OTLP `severity_text` canonical values. */
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

/**
 * Stable identity for a (resource, scope) stream — hash-derived. Each
 * engine maintains its own registry; the integer namespace is local
 * to the engine instance.
 */
export type StreamId = number;

/** A grouping of (resource, scope) under which records share metadata. */
export interface StreamKey {
  resource: Resource;
  scope: InstrumentationScope;
}
