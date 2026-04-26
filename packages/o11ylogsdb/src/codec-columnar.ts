/**
 * `ColumnarDrainPolicy` — M4 thesis prototype.
 *
 * Replaces the NDJSON record envelope with a binary columnar payload:
 * timestamps as a contiguous run of LE u64s, severity numbers as a
 * contiguous run of u8s, body data as a packed `(template_id, vars[])`
 * column for templated bodies plus a length-prefixed UTF-8 column for
 * raw-string bodies, and a small "sidecar" carrying anything we don't
 * model in the dedicated columns (severityText, attributes, traceId,
 * spanId, eventName, dropped count, flags, observedTimeUnixNano,
 * non-string bodies).
 *
 * The thesis measurement exposed:
 *
 *   ZSTD-19 over an NDJSON-shaped record stream can't beat ZSTD-19
 *   over plain text bodies. The repetitive `{"$tpl":N,"$v":[…]}`
 *   envelope tax neutralizes Drain's structural win.
 *
 *   The fix is to take the envelope away. ZSTD-19 over a long run of
 *   homogeneous u64 timestamps, then a long run of u8 severities,
 *   then a long run of varint template ids, then a long run of
 *   length-prefixed var bytes will compress *much* better than the
 *   same bytes scattered through JSON.
 *
 * This file implements the simplest version of that hypothesis. The
 * payload bytes are produced by `encodePayload`, then handed straight
 * to whatever bytes codec the policy chose (default `zstd-19`). The
 * codec's input window sees long, type-uniform runs, which is where
 * LZ77 + entropy coders thrive.
 *
 * Two flavors are exported so the experiment can isolate "columnar
 * layout wins" from "Drain wins":
 *
 *   - `ColumnarDrainPolicy` — runs Drain over each body string, emits
 *     a `(template_id, vars[])` for matched bodies. The chunk's
 *     template dictionary is stored once in `codecMeta`, not per row.
 *   - `ColumnarRawPolicy` — same columnar layout, but body strings go
 *     into a single length-prefixed bytes column with no templating.
 *     Isolates the layout effect from the Drain effect.
 *
 * Both are TS-only and additive — they implement `ChunkPolicy` via
 * the `encodePayload` / `decodePayload` hooks added in `chunk.ts`.
 *
 * Round-trip is content-correct under the same Drain whitespace rule
 * as `DrainChunkPolicy` (templated bodies normalize multi-space runs
 * to single spaces; everything else is bit-exact).
 */

import type { ChunkPolicy } from "./chunk.js";
import { Drain, PARAM_STR, tokenize } from "./drain.js";
import type { AnyValue, KeyValue, LogRecord, SeverityText } from "./types.js";

// ── Body-kind tags ───────────────────────────────────────────────────

const KIND_RAW_STRING = 0;
const KIND_TEMPLATED = 1;
const KIND_OTHER = 2; // anything non-string — falls back to NDJSON sidecar

// ── Public config ────────────────────────────────────────────────────

export interface ColumnarPolicyConfig {
  /** Bytes codec for the binary payload. Default `"zstd-19"`. */
  bodyCodec?: string;
}

export interface ColumnarDrainPolicyConfig extends ColumnarPolicyConfig {
  /** Drain instance to share across chunks. Default: a fresh Drain. */
  drain?: Drain;
}

// ── Wire-meta shape (JSON, lives in chunk header `codecMeta`) ────────
//
// We keep this small on purpose. The chunk header is uncompressed
// bytes-on-the-wire, and measurement showed ~0.5 B/log can be lost
// to the header alone when the per-chunk template dictionary lives
// here. So we move the dictionary *into* the compressed payload (see
// the schema below) and leave only a single byte of meta in the
// header: a flavor tag.

interface ColumnarChunkMeta {
  /** Schema tag for forward-compat. */
  v: 1;
  /** Whether bodies were templated (Drain) or kept raw. */
  drain: boolean;
}

// ── Helpers: varint ──────────────────────────────────────────────────
//
// Growable single-buffer writer. See codec-typed.ts ByteBuf for the
// rationale (CPU profile, 2026-04-26).
class ByteBuf {
  private buf: Uint8Array;
  private view: DataView;
  private len: number = 0;

  constructor(initialCapacity: number = 1024) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensureCapacity(extra: number): void {
    const required = this.len + extra;
    if (required <= this.buf.length) return;
    let newCap = this.buf.length * 2;
    while (newCap < required) newCap *= 2;
    const next = new Uint8Array(newCap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  pushByte(b: number): void {
    if (this.len >= this.buf.length) this.ensureCapacity(1);
    this.buf[this.len++] = b & 0xff;
  }
  pushBytes(b: Uint8Array): void {
    this.ensureCapacity(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  pushU64LE(n: bigint): void {
    this.ensureCapacity(8);
    this.view.setBigUint64(this.len, n, true);
    this.len += 8;
  }
  pushVarint(n: number): void {
    if (!Number.isFinite(n) || n < 0) throw new Error("varint must be non-negative");
    this.ensureCapacity(5);
    let x = n >>> 0;
    while (x >= 0x80) {
      this.buf[this.len++] = (x & 0x7f) | 0x80;
      x >>>= 7;
    }
    this.buf[this.len++] = x & 0x7f;
  }
  /** ZigZag-then-varint encode for signed BigInt (delta path). */
  pushZigZagVarintBig(n: bigint): void {
    this.ensureCapacity(10);
    const zz = (n << 1n) ^ (n >> 63n);
    let x = zz;
    while (x >= 0x80n) {
      this.buf[this.len++] = Number(x & 0x7fn) | 0x80;
      x >>= 7n;
    }
    this.buf[this.len++] = Number(x & 0x7fn);
  }
  finish(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
  get length(): number {
    return this.len;
  }
}

class ByteCursor {
  private cursor = 0;
  constructor(private readonly buf: Uint8Array) {}
  get pos(): number {
    return this.cursor;
  }
  remaining(): number {
    return this.buf.length - this.cursor;
  }
  readByte(): number {
    if (this.cursor >= this.buf.length) throw new Error("columnar: read past end");
    return this.buf[this.cursor++] as number;
  }
  readBytes(n: number): Uint8Array {
    const end = this.cursor + n;
    if (end > this.buf.length) throw new Error("columnar: read past end");
    const out = this.buf.subarray(this.cursor, end);
    this.cursor = end;
    return out;
  }
  readU64LE(): bigint {
    const end = this.cursor + 8;
    if (end > this.buf.length) throw new Error("columnar: read past end");
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.cursor, 8);
    const v = view.getBigUint64(0, true);
    this.cursor = end;
    return v;
  }
  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      const b = this.readByte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error("columnar: varint overflow");
    }
    return result >>> 0;
  }
  readZigZagVarintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    while (true) {
      const b = this.readByte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
      if (shift > 70n) throw new Error("columnar: varint overflow");
    }
    // Reverse zigzag: (n >>> 1) ^ -(n & 1)
    const lsb = result & 1n;
    return (result >> 1n) ^ -lsb;
  }
}

// ── Encode / decode ──────────────────────────────────────────────────

/**
 * Build the binary payload for a record batch.
 *
 * @param records   the batch
 * @param drain     if set, body strings are templated through Drain.
 *                  Otherwise body strings are stored raw.
 *
 * Layout (all little-endian):
 *
 *   varint     n
 *   zzvarint × n  delta(timeUnixNano)    (delta-of-prior, ZigZag → varint;
 *                                         monotonic timestamps fit in 1–4 B)
 *   u8  × n    severityNumber
 *   u8  × n    body_kind                (0=raw_string, 1=templated, 2=other)
 *
 *   varint     n_templates
 *   for each template:
 *     varint template_id
 *     varint template_byte_len
 *     template_byte_len bytes utf-8     (template tokens joined by space)
 *
 *   for each record where kind == raw_string, in original order:
 *     varint length, len bytes utf-8
 *
 *   for each record where kind == templated, in original order:
 *     varint template_id
 *     varint n_vars
 *     for each var: varint length, len bytes utf-8
 *
 *   varint     sidecar_byte_len
 *   sidecar_byte_len bytes: an NDJSON stream of "side fields" — one
 *     line per record, whose body kind is `other`, plus, for any
 *     record (any kind), any of the optional fields
 *     {severityText if not "INFO", observedTimeUnixNano, flags,
 *      traceId, spanId, eventName, droppedAttributesCount,
 *      attributes if non-empty}. If a record contributes nothing to
 *     the sidecar we emit a sidecar_byte_len of 0.
 *
 * The "sidecar" is plain NDJSON because (a) the bench corpora don't
 * exercise these fields so the column would be all empty objects
 * (which ZSTD reduces to nothing) and (b) it keeps this experiment
 * scoped to the body column where the wins live.
 *
 * The per-chunk template dictionary lives *inside* the payload, not
 * in the chunk's JSON header. That keeps the uncompressed-header tax
 * (the layout overhead #2) at zero.
 */
function encode(
  records: readonly LogRecord[],
  drain: Drain | undefined
): {
  payload: Uint8Array;
  meta: ColumnarChunkMeta;
} {
  const n = records.length;
  const buf = new ByteBuf();
  buf.pushVarint(n);

  // timestamps as delta-of-prior + ZigZag + varint. Monotonic
  // timestamps reduce to 1-byte varints (delta < 128 ns scaled-down,
  // or in our bench: 1 s gaps → 1_000_000_000 ns delta which fits in
  // 5 B; still beats raw 8 B and ZSTD finds the run easily).
  let prevTs = 0n;
  for (let i = 0; i < n; i++) {
    const ts = (records[i] as LogRecord).timeUnixNano;
    buf.pushZigZagVarintBig(ts - prevTs);
    prevTs = ts;
  }

  // severity numbers
  for (let i = 0; i < n; i++) {
    const s = (records[i] as LogRecord).severityNumber;
    buf.pushByte(s & 0xff);
  }

  // Classify each record's body.
  const kinds = new Uint8Array(n);
  // Pass 1 (Drain only): ingest every string body so the Drain state
  // is stable. Ignore the vars Drain returns; we re-extract in pass 2
  // against the snapshotted templates.
  const tplIdsByRecord = new Int32Array(n).fill(-1);
  if (drain) {
    for (let i = 0; i < n; i++) {
      const r = records[i] as LogRecord;
      if (typeof r.body === "string") {
        tplIdsByRecord[i] = drain.matchOrAdd(r.body).templateId;
      }
    }
  }

  // Snapshot templates used in this chunk. We embed them in the
  // *payload* (not the JSON header) so they ride through ZSTD-19.
  const templatesById = new Map<number, string[]>();
  const templatesInPayload: { id: number; template: string }[] = [];
  if (drain) {
    const used = new Set<number>();
    for (let i = 0; i < n; i++) {
      const id = tplIdsByRecord[i] as number;
      if (id >= 0) used.add(id);
    }
    for (const t of drain.templates()) {
      if (!used.has(t.id)) continue;
      templatesById.set(
        t.id,
        t.template.split(/\s+/).filter((s) => s.length > 0)
      );
      templatesInPayload.push({ id: t.id, template: t.template });
    }
  }

  // Decide kinds.
  for (let i = 0; i < n; i++) {
    const r = records[i] as LogRecord;
    if (typeof r.body !== "string") {
      kinds[i] = KIND_OTHER;
      continue;
    }
    if (
      drain &&
      (tplIdsByRecord[i] as number) >= 0 &&
      templatesById.has(tplIdsByRecord[i] as number)
    ) {
      kinds[i] = KIND_TEMPLATED;
    } else {
      kinds[i] = KIND_RAW_STRING;
    }
  }
  buf.pushBytes(kinds);

  // Embed the per-chunk template dictionary inside the payload.
  const enc = new TextEncoder();
  buf.pushVarint(templatesInPayload.length);
  for (const t of templatesInPayload) {
    buf.pushVarint(t.id);
    const tb = enc.encode(t.template);
    buf.pushVarint(tb.length);
    buf.pushBytes(tb);
  }

  // Raw-string bodies, in original record order.
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== KIND_RAW_STRING) continue;
    const r = records[i] as LogRecord;
    const bytes = enc.encode(r.body as string);
    buf.pushVarint(bytes.length);
    buf.pushBytes(bytes);
  }

  // Templated bodies. We emit (template_id, vars) per record.
  // For ZSTD-19 to see runs we lay out all template_ids first, then
  // all var-count varints, then all var bytes. (Per-record order is
  // implicit: i-th templated record reads i-th template_id, etc.)
  if (drain) {
    // Pass: gather per-templated-record info.
    const tplIds: number[] = [];
    const varsByRecord: string[][] = [];
    for (let i = 0; i < n; i++) {
      if (kinds[i] !== KIND_TEMPLATED) continue;
      const r = records[i] as LogRecord;
      const tplId = tplIdsByRecord[i] as number;
      tplIds.push(tplId);
      const finalTemplate = templatesById.get(tplId) as string[];
      const tokens = tokenize(r.body as string);
      const vars =
        finalTemplate.length === tokens.length
          ? extractVarsAgainstTemplate(finalTemplate, tokens)
          : [];
      varsByRecord.push(vars);
    }
    // template_ids column
    for (const id of tplIds) buf.pushVarint(id);
    // var-count column
    for (const v of varsByRecord) buf.pushVarint(v.length);
    // var bytes column: per-var varint length + utf-8.
    // Laid out record-major: r0.var0, r0.var1, r1.var0, ... ZSTD can
    // still find cross-row repetition because identical tokens recur
    // across records of the same template.
    for (const vs of varsByRecord) {
      for (const v of vs) {
        const bytes = enc.encode(v);
        buf.pushVarint(bytes.length);
        buf.pushBytes(bytes);
      }
    }
  }

  // Sidecar NDJSON for everything we don't model.
  const sidecarLines: string[] = [];
  let sidecarHasContent = false;
  for (let i = 0; i < n; i++) {
    const r = records[i] as LogRecord;
    const side: Record<string, unknown> = {};
    if (kinds[i] === KIND_OTHER) {
      side.b = anyValueToJson(r.body);
      sidecarHasContent = true;
    }
    if (r.severityText && r.severityText !== "INFO") {
      side.st = r.severityText;
      sidecarHasContent = true;
    }
    if (r.attributes && r.attributes.length > 0) {
      side.a = r.attributes.map((kv) => ({ k: kv.key, v: anyValueToJson(kv.value) }));
      sidecarHasContent = true;
    }
    if (r.observedTimeUnixNano !== undefined) {
      side.o = r.observedTimeUnixNano.toString();
      sidecarHasContent = true;
    }
    if (r.flags !== undefined) {
      side.f = r.flags;
      sidecarHasContent = true;
    }
    if (r.traceId) {
      side.ti = bytesToHex(r.traceId);
      sidecarHasContent = true;
    }
    if (r.spanId) {
      side.si = bytesToHex(r.spanId);
      sidecarHasContent = true;
    }
    if (r.eventName) {
      side.e = r.eventName;
      sidecarHasContent = true;
    }
    if (r.droppedAttributesCount) {
      side.d = r.droppedAttributesCount;
      sidecarHasContent = true;
    }
    sidecarLines.push(JSON.stringify(side));
  }
  // If absolutely nothing in the sidecar, emit a single zero-length
  // marker (varint 0). Otherwise, emit the whole NDJSON stream.
  if (!sidecarHasContent) {
    buf.pushVarint(0);
  } else {
    const sidecar = enc.encode(`${sidecarLines.join("\n")}\n`);
    buf.pushVarint(sidecar.length);
    buf.pushBytes(sidecar);
  }

  return {
    payload: buf.finish(),
    meta: { v: 1, drain: drain !== undefined },
  };
}

function decode(buf: Uint8Array, expectedN: number, meta: ColumnarChunkMeta): LogRecord[] {
  const cur = new ByteCursor(buf);
  const n = cur.readVarint();
  if (n !== expectedN) {
    throw new Error(`columnar: count mismatch payload=${n} header=${expectedN}`);
  }
  // timestamps (delta-zigzag-varint)
  const timestamps = new BigInt64Array(n);
  let prevTs = 0n;
  for (let i = 0; i < n; i++) {
    const delta = cur.readZigZagVarintBig();
    prevTs = prevTs + delta;
    timestamps[i] = prevTs;
  }
  // severity
  const severities = cur.readBytes(n);
  // kinds
  const kinds = cur.readBytes(n);

  // template dictionary (embedded in the payload now).
  const dec = new TextDecoder();
  const tplDict = new Map<number, string[]>();
  const nTemplates = cur.readVarint();
  for (let k = 0; k < nTemplates; k++) {
    const id = cur.readVarint();
    const len = cur.readVarint();
    const template = dec.decode(cur.readBytes(len));
    tplDict.set(
      id,
      template.split(/\s+/).filter((s) => s.length > 0)
    );
  }

  // raw bodies
  const rawBodyByRecord = new Map<number, string>();
  for (let i = 0; i < n; i++) {
    if ((kinds[i] as number) !== KIND_RAW_STRING) continue;
    const len = cur.readVarint();
    rawBodyByRecord.set(i, dec.decode(cur.readBytes(len)));
  }

  // templated bodies
  const templatedIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((kinds[i] as number) === KIND_TEMPLATED) templatedIndices.push(i);
  }
  const templatedBodyByRecord = new Map<number, string>();
  if (templatedIndices.length > 0) {
    if (!meta.drain) throw new Error("columnar: templated rows but meta.drain=false");
    const tplIds: number[] = [];
    for (let k = 0; k < templatedIndices.length; k++) tplIds.push(cur.readVarint());
    const varCounts: number[] = [];
    for (let k = 0; k < templatedIndices.length; k++) varCounts.push(cur.readVarint());
    for (let k = 0; k < templatedIndices.length; k++) {
      const recIdx = templatedIndices[k] as number;
      const tplId = tplIds[k] as number;
      const nv = varCounts[k] as number;
      const template = tplDict.get(tplId);
      if (!template) {
        throw new Error(`columnar: missing template id ${tplId} in meta`);
      }
      const vars: string[] = [];
      for (let v = 0; v < nv; v++) {
        const len = cur.readVarint();
        vars.push(dec.decode(cur.readBytes(len)));
      }
      templatedBodyByRecord.set(recIdx, Drain.reconstruct(template, vars));
    }
  }

  // Sidecar
  const sidecarLen = cur.readVarint();
  const sidecarBuf = cur.readBytes(sidecarLen);
  const sidecarLines: string[] =
    sidecarLen === 0
      ? new Array(n).fill("{}")
      : dec
          .decode(sidecarBuf)
          .split("\n")
          .filter((l) => l.length > 0);
  if (sidecarLines.length !== 0 && sidecarLines.length !== n) {
    throw new Error(`columnar: sidecar line count ${sidecarLines.length} != n ${n}`);
  }

  const out: LogRecord[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const sideStr = sidecarLines.length === 0 ? "{}" : (sidecarLines[i] as string);
    const side = JSON.parse(sideStr) as {
      b?: unknown;
      st?: string;
      a?: Array<{ k: string; v: unknown }>;
      o?: string;
      f?: number;
      ti?: string;
      si?: string;
      e?: string;
      d?: number;
    };
    let body: AnyValue;
    const k = kinds[i] as number;
    if (k === KIND_RAW_STRING) {
      body = rawBodyByRecord.get(i) as string;
    } else if (k === KIND_TEMPLATED) {
      body = templatedBodyByRecord.get(i) as string;
    } else {
      body = jsonToAnyValue(side.b ?? null);
    }
    const attributes: KeyValue[] = side.a
      ? side.a.map((kv) => ({ key: kv.k, value: jsonToAnyValue(kv.v) }))
      : [];
    const rec: LogRecord = {
      timeUnixNano: timestamps[i] as bigint,
      severityNumber: severities[i] as number,
      severityText: (side.st ?? "INFO") as SeverityText | string,
      body,
      attributes,
    };
    if (side.o !== undefined) rec.observedTimeUnixNano = BigInt(side.o);
    if (side.f !== undefined) rec.flags = side.f;
    if (side.ti) rec.traceId = hexToBytes(side.ti);
    if (side.si) rec.spanId = hexToBytes(side.si);
    if (side.e) rec.eventName = side.e;
    if (side.d) rec.droppedAttributesCount = side.d;
    out[i] = rec;
  }
  return out;
}

// ── Public policies ──────────────────────────────────────────────────

export class ColumnarDrainPolicy implements ChunkPolicy {
  readonly drain: Drain;
  private readonly bodyCodecName: string;

  constructor(config: ColumnarDrainPolicyConfig = {}) {
    this.drain = config.drain ?? new Drain();
    this.bodyCodecName = config.bodyCodec ?? "zstd-19";
  }

  bodyCodec(): string {
    return this.bodyCodecName;
  }

  encodePayload(records: readonly LogRecord[]): { payload: Uint8Array; meta: ColumnarChunkMeta } {
    return encode(records, this.drain);
  }

  decodePayload(buf: Uint8Array, nLogs: number, meta: unknown): LogRecord[] {
    return decode(buf, nLogs, meta as ColumnarChunkMeta);
  }
}

/**
 * Same columnar layout but no template extraction. Body strings go
 * into a single `[varint length + utf-8 bytes]` column. Useful as a
 * third comparison row to isolate "columnar layout wins" from "Drain
 * wins".
 */
export class ColumnarRawPolicy implements ChunkPolicy {
  private readonly bodyCodecName: string;
  constructor(config: ColumnarPolicyConfig = {}) {
    this.bodyCodecName = config.bodyCodec ?? "zstd-19";
  }
  bodyCodec(): string {
    return this.bodyCodecName;
  }
  encodePayload(records: readonly LogRecord[]): { payload: Uint8Array; meta: ColumnarChunkMeta } {
    return encode(records, undefined);
  }
  decodePayload(buf: Uint8Array, nLogs: number, meta: unknown): LogRecord[] {
    return decode(buf, nLogs, meta as ColumnarChunkMeta);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractVarsAgainstTemplate(
  template: readonly string[],
  tokens: readonly string[]
): string[] {
  const out: string[] = [];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === PARAM_STR) out.push(tokens[i] ?? "");
  }
  return out;
}

function anyValueToJson(v: AnyValue): unknown {
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

function jsonToAnyValue(j: unknown): AnyValue {
  if (j === null) return null;
  if (typeof j === "object" && j !== null) {
    const obj = j as Record<string, unknown>;
    if (typeof obj.$bi === "string") return BigInt(obj.$bi);
    if (typeof obj.$b === "string") return hexToBytes(obj.$b);
    if (Array.isArray(j)) return j.map(jsonToAnyValue);
    const out: Record<string, AnyValue> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = jsonToAnyValue(v);
    return out;
  }
  return j as AnyValue;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += (b[i] as number).toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
