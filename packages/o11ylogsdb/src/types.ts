/**
 * Engine-internal types for o11ylogsdb.
 *
 * OTLP primitives that every `*db` engine consumes (AnyValue, KeyValue,
 * Resource, InstrumentationScope, SeverityText, StreamId) live in
 * `stardb` — re-exported here so callers keep their existing import
 * paths. The remaining types in this file (LogRecord, BodyKind,
 * StreamKey) are specific to the logs engine.
 */

import type {
  AnyValue,
  InstrumentationScope,
  KeyValue,
  Resource,
  SeverityText,
  StreamId,
  StreamKey,
} from "stardb";

export type {
  AnyValue,
  InstrumentationScope,
  KeyValue,
  Resource,
  SeverityText,
  StreamId,
  StreamKey,
};

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
