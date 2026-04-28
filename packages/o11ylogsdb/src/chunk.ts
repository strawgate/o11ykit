/**
 * Chunk format v1 — minimal pluggable container.
 *
 * Wire layout (subject to evolution; bench measures the wire size):
 *
 *   bytes  [0..4)   magic "OLDB"
 *   bytes  [4..5)   schema version (currently 1)
 *   bytes  [5..9)   header length (u32 LE)
 *   bytes  [9..9+H) header (UTF-8 JSON)
 *   bytes  [9+H..)  payload (codec-encoded body bytes)
 *
 * The header carries metadata the reader needs *before* decompressing
 * the payload: codec choice, log count, time range, resource attrs
 * (hoisted), scope, schema version. Everything else lives inside the
 * payload.
 *
 * The `ChunkPolicy` interface is the plug-in point for future codec
 * experiments — different policies pick different codecs per
 * column/body, build different header shapes, etc. The default policy
 * here is naive: NDJSON-encode every record, run a single bytes codec
 * over the result. M3/M4 replace this with a proper per-column form.
 */

import type { CodecRegistry } from "stardb";
import { bytesToHex, hexToBytes } from "stardb";
import type { AnyValue, InstrumentationScope, LogRecord, Resource } from "./types.js";

const MAGIC_BYTES = new Uint8Array([0x4f, 0x4c, 0x44, 0x42]); // "OLDB"
export const CHUNK_VERSION = 1;

export interface ChunkHeader {
  schemaVersion: number;
  nLogs: number;
  timeRange: { minNano: string; maxNano: string };
  /**
   * Min/max OTLP severityNumber across the chunk's records. Used by
   * the query engine to prune chunks for `severityGte` queries
   * without decoding the payload (the "zone map" pattern shared with
   * most columnar stores). Computed by `ChunkBuilder.freeze`;
   * defaults to {1, 24} when no records (empty chunk).
   */
  severityRange: { min: number; max: number };
  resource: Resource;
  scope: InstrumentationScope;
  /** Codec used to encode the payload. Resolved via the registry on decode. */
  codecName: string;
  /** Encoded payload size in bytes. */
  payloadBytes: number;
  /** Optional opaque codec-specific metadata (e.g. template dictionary). */
  codecMeta?: unknown;
}

export interface Chunk {
  header: ChunkHeader;
  payload: Uint8Array;
}

/** Pluggable codec-choice strategy for a chunk. */
export interface ChunkPolicy {
  /** Codec for the body payload (the "everything else" of the chunk). */
  bodyCodec(): string;
  /**
   * Optional pre-encode pass: rewrite records before NDJSON
   * serialization. Use this to substitute template references for
   * body strings, etc. The returned meta blob is embedded in the
   * chunk header and round-tripped back to `postDecode`.
   *
   * Mutually exclusive with `encodePayload`: if `encodePayload` is
   * defined the policy owns the entire pre-codec pipeline and
   * `preEncode` is ignored.
   */
  preEncode?(records: readonly LogRecord[]): { records: readonly LogRecord[]; meta?: unknown };
  /**
   * Optional reverse pass: receives the meta blob from `preEncode`
   * and the freshly decoded records (still carrying any placeholders
   * `preEncode` introduced), reconstructs the original records.
   */
  postDecode?(records: LogRecord[], meta: unknown): LogRecord[];

  /**
   * Optional total-control hook: take a record batch, return the
   * pre-codec payload bytes and a meta blob. When set, the
   * `ChunkBuilder` skips NDJSON and feeds these bytes straight to the
   * configured `bodyCodec`. The `decodePayload` counterpart is then
   * required for read-back.
   *
   * This is the M4-style hook: a policy can serialize a record batch
   * to a binary columnar form (concatenated u64 timestamps, u8
   * severities, packed body columns, …) and let ZSTD see homogeneous
   * runs instead of an NDJSON envelope.
   */
  encodePayload?(records: readonly LogRecord[]): { payload: Uint8Array; meta?: unknown };
  /**
   * Reverse of `encodePayload`. Receives the decoded payload bytes,
   * the expected log count, and the meta blob from `encodePayload`,
   * and reconstructs the records.
   */
  decodePayload?(buf: Uint8Array, nLogs: number, meta: unknown): LogRecord[];

  /**
   * Partial decode: extract only body strings from the payload. Returns
   * an array of body values (string or structured) without materializing
   * full LogRecord objects — skips sidecar JSON parse, attribute
   * reconstruction, traceId/spanId decoding, etc.
   *
   * Used by the query engine for `bodyContains` predicates to avoid the
   * ~60% CPU cost of full-record materialization when only the body
   * column is needed. Falls back to full `decodePayload` when not
   * implemented.
   */
  decodeBodiesOnly?(buf: Uint8Array, nLogs: number, meta: unknown): AnyValue[];
}

/** Default policy: ZSTD-19 over the NDJSON form. Simple and decent. */
export class DefaultChunkPolicy implements ChunkPolicy {
  constructor(public readonly codec = "zstd-19") {}
  bodyCodec(): string {
    return this.codec;
  }
}

/**
 * Accumulates records and freezes them into a `Chunk`. Holds onto an
 * (resource, scope) pair so all records in this chunk share metadata
 * (the per-stream invariant).
 */
export class ChunkBuilder {
  private records: LogRecord[] = [];
  constructor(
    private readonly resource: Resource,
    private readonly scope: InstrumentationScope,
    private readonly policy: ChunkPolicy,
    private readonly registry: CodecRegistry
  ) {}

  append(r: LogRecord): void {
    this.records.push(r);
  }

  size(): number {
    return this.records.length;
  }

  /** Drop accumulated records without freezing. */
  reset(): void {
    this.records = [];
  }

  freeze(): Chunk {
    const codecName = this.policy.bodyCodec();
    const codec = this.registry.get(codecName);
    let raw: Uint8Array;
    let codecMeta: unknown;
    if (this.policy.encodePayload) {
      const enc = this.policy.encodePayload(this.records);
      raw = enc.payload;
      codecMeta = enc.meta;
    } else {
      const transformed = this.policy.preEncode?.(this.records);
      const recordsToEncode = transformed?.records ?? this.records;
      codecMeta = transformed?.meta;
      raw = encodeRecordsAsNdjson(recordsToEncode);
    }
    const payload = codec.encode(raw);
    // Time range: assumes records appended in chronological order
    // (the OTLP-batch invariant). Out-of-order callers will get
    // wrong min/max here; revisit if/when reorder buffer lands.
    const minNano = this.records[0]?.timeUnixNano ?? 0n;
    const maxNano = this.records[this.records.length - 1]?.timeUnixNano ?? 0n;
    // Severity range: scan all records.
    let sevMin = 24; // OTLP severity_number max
    let sevMax = 1; // OTLP severity_number min
    if (this.records.length === 0) {
      sevMin = 1;
      sevMax = 24;
    } else {
      for (const r of this.records) {
        if (r.severityNumber < sevMin) sevMin = r.severityNumber;
        if (r.severityNumber > sevMax) sevMax = r.severityNumber;
      }
    }
    const header: ChunkHeader = {
      schemaVersion: CHUNK_VERSION,
      nLogs: this.records.length,
      timeRange: { minNano: minNano.toString(), maxNano: maxNano.toString() },
      severityRange: { min: sevMin, max: sevMax },
      resource: this.resource,
      scope: this.scope,
      codecName,
      payloadBytes: payload.length,
      ...(codecMeta !== undefined ? { codecMeta } : {}),
    };
    return { header, payload };
  }
}

/**
 * Decodes a chunk's records. If the caller supplies a policy, its
 * `postDecode` hook (if any) runs on the decoded records using the
 * header's `codecMeta` blob.
 */
export function readRecords(
  chunk: Chunk,
  registry: CodecRegistry,
  policy?: ChunkPolicy
): LogRecord[] {
  const codec = registry.get(chunk.header.codecName);
  const raw = codec.decode(chunk.payload);
  return readRecordsFromRaw(raw, chunk.header, policy);
}

/**
 * Decode records from an already-decompressed payload buffer. Use this
 * when the caller has already decompressed (e.g. in the query engine's
 * raw-byte-scan path) to avoid double decompression.
 */
export function readRecordsFromRaw(
  raw: Uint8Array,
  header: ChunkHeader,
  policy?: ChunkPolicy
): LogRecord[] {
  if (policy?.decodePayload) {
    return policy.decodePayload(raw, header.nLogs, header.codecMeta);
  }
  const decoded = decodeNdjsonRecords(raw, header.nLogs);
  if (policy?.postDecode) {
    return policy.postDecode(decoded, header.codecMeta);
  }
  return decoded;
}

/**
 * Partial decode: extract only body values from a chunk. Skips sidecar
 * JSON parse, attribute reconstruction, traceId/spanId, etc. For string-
 * bodied logs this is dramatically cheaper than full `readRecords`.
 *
 * Falls back to full decode when the policy doesn't implement
 * `decodeBodiesOnly`.
 */
export function readBodiesOnly(
  chunk: Chunk,
  registry: CodecRegistry,
  policy?: ChunkPolicy
): AnyValue[] {
  const codec = registry.get(chunk.header.codecName);
  const raw = codec.decode(chunk.payload);
  if (policy?.decodeBodiesOnly) {
    return policy.decodeBodiesOnly(raw, chunk.header.nLogs, chunk.header.codecMeta);
  }
  // Fallback: full decode and extract bodies
  if (policy?.decodePayload) {
    return policy.decodePayload(raw, chunk.header.nLogs, chunk.header.codecMeta).map((r) => r.body);
  }
  return decodeNdjsonRecords(raw, chunk.header.nLogs).map((r) => r.body);
}

/**
 * Wire size of a chunk without materializing the full byte buffer —
 * the header JSON is encoded just to measure its length, but the
 * payload bytes (the dominant cost) are not copied. Used by `stats()`
 * to count storage cheaply.
 */
export function chunkWireSize(chunk: Chunk): number {
  const headerJson = new TextEncoder().encode(JSON.stringify(chunk.header));
  return MAGIC_BYTES.length + 1 + 4 + headerJson.length + chunk.payload.length;
}

/** Serialize a chunk to the wire format. */
export function serializeChunk(chunk: Chunk): Uint8Array {
  const headerJson = new TextEncoder().encode(JSON.stringify(chunk.header));
  const totalLen = MAGIC_BYTES.length + 1 + 4 + headerJson.length + chunk.payload.length;
  const out = new Uint8Array(totalLen);
  let cursor = 0;
  out.set(MAGIC_BYTES, cursor);
  cursor += MAGIC_BYTES.length;
  out[cursor++] = CHUNK_VERSION;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(cursor, headerJson.length, true);
  cursor += 4;
  out.set(headerJson, cursor);
  cursor += headerJson.length;
  out.set(chunk.payload, cursor);
  return out;
}

/** Parse the wire format back to a Chunk. */
export function deserializeChunk(buf: Uint8Array): Chunk {
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (buf[i] !== MAGIC_BYTES[i]) throw new Error("o11ylogsdb: bad chunk magic");
  }
  const version = buf[4];
  if (version !== CHUNK_VERSION) {
    throw new Error(`o11ylogsdb: unsupported chunk version ${version}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = view.getUint32(5, true);
  const headerJson = new TextDecoder().decode(buf.subarray(9, 9 + headerLen));
  const header: ChunkHeader = JSON.parse(headerJson);
  const payload = buf.subarray(9 + headerLen);
  if (payload.length !== header.payloadBytes) {
    throw new Error(
      `o11ylogsdb: payload length mismatch (${payload.length} vs ${header.payloadBytes})`
    );
  }
  return { header, payload };
}

// ── NDJSON encode/decode (default body representation) ────────────────

function encodeRecordsAsNdjson(records: readonly LogRecord[]): Uint8Array {
  const lines = records.map((r) => JSON.stringify(toJsonable(r)));
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

function decodeNdjsonRecords(buf: Uint8Array, expectedCount: number): LogRecord[] {
  const text = new TextDecoder().decode(buf);
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length !== expectedCount) {
    throw new Error(`o11ylogsdb: NDJSON line count mismatch (${lines.length} vs ${expectedCount})`);
  }
  return lines.map((l) => fromJsonable(JSON.parse(l)));
}

interface JsonableRecord {
  t: string; // bigint as string
  s: number;
  st: string;
  b: unknown;
  a: unknown;
  o?: string;
  f?: number;
  ti?: string; // hex
  si?: string; // hex
  e?: string;
  d?: number;
}

function toJsonable(r: LogRecord): JsonableRecord {
  const out: JsonableRecord = {
    t: r.timeUnixNano.toString(),
    s: r.severityNumber,
    st: r.severityText,
    b: anyValueToJson(r.body),
    a: r.attributes.map((kv) => ({ k: kv.key, v: anyValueToJson(kv.value) })),
  };
  if (r.observedTimeUnixNano !== undefined) out.o = r.observedTimeUnixNano.toString();
  if (r.flags !== undefined) out.f = r.flags;
  if (r.traceId) out.ti = bytesToHex(r.traceId);
  if (r.spanId) out.si = bytesToHex(r.spanId);
  if (r.eventName !== undefined) out.e = r.eventName;
  if (r.droppedAttributesCount !== undefined) out.d = r.droppedAttributesCount;
  return out;
}

function fromJsonable(j: JsonableRecord): LogRecord {
  const out: LogRecord = {
    timeUnixNano: BigInt(j.t),
    severityNumber: j.s,
    severityText: j.st,
    body: jsonToAnyValue(j.b),
    attributes: ((j.a ?? []) as Array<{ k: string; v: unknown }>).map((kv) => ({
      key: kv.k,
      value: jsonToAnyValue(kv.v),
    })),
  };
  if (j.o !== undefined) out.observedTimeUnixNano = BigInt(j.o);
  if (j.f !== undefined) out.flags = j.f;
  if (j.ti) out.traceId = hexToBytes(j.ti);
  if (j.si) out.spanId = hexToBytes(j.si);
  if (j.e !== undefined) out.eventName = j.e;
  if (j.d !== undefined) out.droppedAttributesCount = j.d;
  return out;
}

function anyValueToJson(v: import("./types.js").AnyValue): unknown {
  if (v === null) return null;
  if (typeof v === "bigint") return { $bi: v.toString() };
  if (v instanceof Uint8Array) return { $b: bytesToHex(v) };
  if (Array.isArray(v)) return v.map(anyValueToJson);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = anyValueToJson(val);
    return out;
  }
  return v;
}

function jsonToAnyValue(j: unknown): import("./types.js").AnyValue {
  if (j === null) return null;
  if (typeof j === "object" && j !== null) {
    const obj = j as Record<string, unknown>;
    if (typeof obj.$bi === "string") return BigInt(obj.$bi);
    if (typeof obj.$b === "string") return hexToBytes(obj.$b);
    if (Array.isArray(j)) return j.map(jsonToAnyValue);
    const out: Record<string, import("./types.js").AnyValue> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = jsonToAnyValue(v);
    return out;
  }
  // string | number | boolean
  return j as import("./types.js").AnyValue;
}
