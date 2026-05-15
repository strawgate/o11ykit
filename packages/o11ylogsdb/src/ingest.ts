/**
 * OTLP JSON ingest bridge (M5).
 *
 * Converts an `OtlpLogsDocument` (the OTLP/JSON wire format parsed by
 * `@otlpkit/otlpjson`) into `LogStore.append()` calls. This is the
 * primary adoption surface — callers who receive OTLP payloads from
 * OTel SDKs or collectors can feed them directly into the engine.
 *
 * Design choices:
 *   - Zero intermediate allocation beyond the `LogRecord` objects
 *     themselves. We walk the OTLP envelope in-place.
 *   - Resource/Scope are converted to `stardb` types and passed to
 *     `append()` which handles stream-key interning.
 *   - Timestamps: OTLP/JSON encodes nanos as strings (uint64 exceeds
 *     JSON's `Number.MAX_SAFE_INTEGER`). We parse to `bigint`.
 *   - Body: recursively converted from OTLP wire shape to `AnyValue`.
 *   - Attributes: `OtlpKeyValue[]` → `KeyValue[]`.
 *   - Hex trace_id / span_id → `Uint8Array`.
 */

import type { LogStore } from "./engine.js";
import type { AnyValue, InstrumentationScope, KeyValue, LogRecord, Resource } from "./types.js";

// ── OTLP wire types (subset needed for logs ingest) ─────────────────

/** OTLP/JSON `AnyValue` wire shape. */
interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
  readonly bytesValue?: string; // base64
  readonly arrayValue?: { readonly values?: readonly OtlpAnyValue[] };
  readonly kvlistValue?: { readonly values?: readonly OtlpKeyValue[] };
}

interface OtlpKeyValue {
  readonly key: string;
  readonly value?: OtlpAnyValue;
}

/**
 * Canonical OTLP/JSON `ExportLogsServiceRequest` shape — the document
 * that an OTLP exporter sends. Same as `OtlpLogsDocument` from
 * `@otlpkit/otlpjson`; redefined here to avoid a hard dependency.
 */
export interface OtlpLogsDocument {
  readonly resourceLogs: readonly {
    readonly resource?: {
      readonly attributes?: readonly OtlpKeyValue[];
      readonly droppedAttributesCount?: number;
    };
    readonly scopeLogs?: readonly {
      readonly scope?: {
        readonly name?: string;
        readonly version?: string;
        readonly attributes?: readonly OtlpKeyValue[];
      };
      readonly logRecords?: readonly {
        readonly timeUnixNano?: string | number;
        readonly observedTimeUnixNano?: string | number;
        readonly severityNumber?: number;
        readonly severityText?: string;
        readonly body?: OtlpAnyValue;
        readonly attributes?: readonly OtlpKeyValue[];
        readonly droppedAttributesCount?: number;
        readonly traceId?: string;
        readonly spanId?: string;
        readonly flags?: number;
      }[];
    }[];
  }[];
}

// ── Public API ───────────────────────────────────────────────────────

export interface IngestResult {
  recordsIngested: number;
  chunksClosed: number;
}

/**
 * Ingest a full OTLP/JSON logs document into a LogStore.
 *
 * Walks `resourceLogs[].scopeLogs[].logRecords[]`, converts each
 * record to the engine's `LogRecord` shape, and appends it. Returns
 * aggregate stats for the batch.
 *
 * @example
 * ```ts
 * import { LogStore, ingestOtlpLogs } from "o11ylogsdb";
 *
 * const store = new LogStore();
 * const payload = JSON.parse(otlpJsonBody);
 * const result = ingestOtlpLogs(store, payload);
 * console.log(`Ingested ${result.recordsIngested} records`);
 * ```
 */
export function ingestOtlpLogs(store: LogStore, doc: OtlpLogsDocument): IngestResult {
  let recordsIngested = 0;
  let chunksClosed = 0;

  for (const rl of doc.resourceLogs) {
    const resource = convertResource(rl.resource);
    for (const sl of rl.scopeLogs ?? []) {
      const scope = convertScope(sl.scope);
      for (const lr of sl.logRecords ?? []) {
        const record = convertLogRecord(lr);
        const stats = store.append(resource, scope, record);
        chunksClosed = stats.chunksClosed;
        recordsIngested++;
      }
    }
  }

  return { recordsIngested, chunksClosed };
}

/**
 * Streaming variant: yields converted `LogRecord` objects without
 * appending them to a store. Useful when callers need to inspect
 * records before ingest or route them to multiple stores.
 */
export function* iterOtlpLogRecords(doc: OtlpLogsDocument): Generator<{
  resource: Resource;
  scope: InstrumentationScope;
  record: LogRecord;
}> {
  for (const rl of doc.resourceLogs) {
    const resource = convertResource(rl.resource);
    for (const sl of rl.scopeLogs ?? []) {
      const scope = convertScope(sl.scope);
      for (const lr of sl.logRecords ?? []) {
        yield { resource, scope, record: convertLogRecord(lr) };
      }
    }
  }
}

// ── Conversion helpers ───────────────────────────────────────────────

function convertResource(raw?: {
  readonly attributes?: readonly OtlpKeyValue[];
  readonly droppedAttributesCount?: number;
}): Resource {
  return {
    attributes: convertKeyValues(raw?.attributes),
    ...(raw?.droppedAttributesCount ? { droppedAttributesCount: raw.droppedAttributesCount } : {}),
  };
}

function convertScope(raw?: {
  readonly name?: string;
  readonly version?: string;
  readonly attributes?: readonly OtlpKeyValue[];
}): InstrumentationScope {
  return {
    name: raw?.name ?? "",
    ...(raw?.version ? { version: raw.version } : {}),
    ...(raw?.attributes?.length ? { attributes: convertKeyValues(raw.attributes) } : {}),
  };
}

function convertLogRecord(raw: {
  readonly timeUnixNano?: string | number;
  readonly observedTimeUnixNano?: string | number;
  readonly severityNumber?: number;
  readonly severityText?: string;
  readonly body?: OtlpAnyValue;
  readonly attributes?: readonly OtlpKeyValue[];
  readonly droppedAttributesCount?: number;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly flags?: number;
}): LogRecord {
  const record: LogRecord = {
    timeUnixNano: parseNanos(raw.timeUnixNano),
    severityNumber: raw.severityNumber ?? 9, // default INFO
    severityText: (raw.severityText ?? "INFO") as LogRecord["severityText"],
    body: convertAnyValue(raw.body),
    attributes: convertKeyValues(raw.attributes),
  };

  if (raw.observedTimeUnixNano !== undefined) {
    record.observedTimeUnixNano = parseNanos(raw.observedTimeUnixNano);
  }
  if (raw.droppedAttributesCount) {
    record.droppedAttributesCount = raw.droppedAttributesCount;
  }
  if (raw.flags !== undefined) {
    record.flags = raw.flags;
  }
  if (raw.traceId) {
    const bytes = hexToBytes(raw.traceId, 16);
    if (bytes) record.traceId = bytes;
  }
  if (raw.spanId) {
    const bytes = hexToBytes(raw.spanId, 8);
    if (bytes) record.spanId = bytes;
  }

  return record;
}

function convertKeyValues(raw?: readonly OtlpKeyValue[]): KeyValue[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((kv) => ({ key: kv.key, value: convertAnyValue(kv.value) }));
}

function convertAnyValue(v?: OtlpAnyValue): AnyValue {
  if (v === undefined || v === null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) {
    // OTLP/JSON encodes int64 as string to avoid precision loss
    if (typeof v.intValue === "string") return BigInt(v.intValue);
    return v.intValue;
  }
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.bytesValue !== undefined) return base64ToBytes(v.bytesValue);
  if (v.arrayValue !== undefined) {
    return (v.arrayValue.values ?? []).map((el) => convertAnyValue(el));
  }
  if (v.kvlistValue !== undefined) {
    const obj: { [key: string]: AnyValue } = {};
    for (const kv of v.kvlistValue.values ?? []) {
      obj[kv.key] = convertAnyValue(kv.value);
    }
    return obj;
  }
  return null;
}

/** Parse nanosecond timestamp (string or number) to bigint. */
function parseNanos(v?: string | number): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "string") return v === "" ? 0n : BigInt(v);
  return BigInt(v);
}

/** Hex string to Uint8Array with expected length validation. */
function hexToBytes(hex: string, expectedLen: number): Uint8Array | undefined {
  if (!hex || hex === "0".repeat(expectedLen * 2)) return undefined;
  const bytes = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Base64 string to Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node.js fallback
  return new Uint8Array(Buffer.from(b64, "base64"));
}
