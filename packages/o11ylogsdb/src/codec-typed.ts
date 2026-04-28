/**
 * `TypedColumnarDrainPolicy` — M4 per-template variable typing.
 *
 * Extends `ColumnarDrainPolicy` with **per-(template, slot) value-
 * distribution-aware codec dispatch** for variable-position values.
 * measurement showed that on HDFS, slots whose values are all of
 * shape `blk_<int>` cost 9.80 B/log when stored as length-prefixed
 * UTF-8 + ZSTD-19, vs **8.13 B/log** stored as raw 8-byte LE i64
 * + ZSTD-19 (a 17 % saving, near the 60-bit entropy floor).
 *
 * Slot-type detectors are *generic* — they recognize byte shapes, not
 * corpus-specific literals. See the SLOT_* constants below for the
 * full set: SIGNED_INT, UUID, UUID_NODASH, PREFIXED_INT64,
 * PREFIXED_UUID, TIMESTAMP_DELTA. Anything that doesn't match a
 * detector stays length-prefixed UTF-8 (SLOT_STRING).
 *
 * Per-(template, slot) typing decisions are recorded in `codecMeta`,
 * keeping the chunk header small. The wire format adds a tiny per-
 * templated-record dispatch overhead but ZSTD-19 collapses the type
 * tags to nothing.
 *
 * Constraints:
 *
 *   - Must round-trip content-correctly under the same Drain
 *     whitespace rule as `ColumnarDrainPolicy` (multi-space →
 *     single space).
 *   - Skips typing on slots with < 50 records or with mixed value
 *     shapes — the dispatch overhead isn't worth it on small slots.
 *   - Same `ChunkPolicy` plug-in surface as the existing policies.
 */

import type { ChunkPolicy } from "./chunk.js";
import { Drain, PARAM_STR, tokenize } from "./drain.js";
import type { AnyValue, KeyValue, LogRecord, SeverityText } from "./types.js";

// Body kinds (same enum as ColumnarDrainPolicy).
const KIND_RAW_STRING = 0;
const KIND_TEMPLATED = 1;
const KIND_OTHER = 2;

// Slot type discriminants (1 byte each in the per-record dispatch).
//
// All detectors are *generic* — they recognize byte-shape patterns,
// not corpus-specific literals. A per-slot "prefix" string in the
// slot-types meta lets a single detector cover many literal prefixes:
// HDFS's `blk_<int>` and any other `<prefix><int>` shape both
// classify as PREFIXED_INT64 with the prefix detected from the data.
//
// The point: the engine doesn't know the log format ahead of time.
// The detectors must work on whatever byte shape the data has.
const SLOT_STRING = 0; // length-prefixed UTF-8 (default)
const SLOT_SIGNED_INT = 1; // ZigZag-varint (no prefix)
const SLOT_UUID = 2; // 16 raw bytes (canonical 8-4-4-4-12 UUID)
const SLOT_UUID_NODASH = 3; // 16 raw bytes (32 lowercase hex chars)
const SLOT_PREFIXED_INT64 = 4; // (prefix, raw 8-byte LE i64 residual)
const SLOT_PREFIXED_UUID = 5; // (prefix, 16 raw bytes UUID residual)
const SLOT_TIMESTAMP_DELTA = 6; // (format pattern, ZZ-varint delta of unix-micros)

// Canonical-integer regex: rejects leading zeros (e.g. `081109` keeps
// its zero pad) and `-0` so that BigInt(v).toString() round-trips
// verbatim.
const SIGNED_INT_REGEX = /^(0|-?[1-9]\d*)$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_NODASH_REGEX = /^[0-9a-f]{32}$/;

/**
 * Generic timestamp detectors. Each entry: { regex, parse(), format() }.
 * The regex captures the digit groups; `parse` returns BigInt micros;
 * `format` reconstitutes the original string from the bigint. Index
 * into this list is stored in slot meta as the format selector.
 */
interface TimestampShape {
  /** Stable identifier; persisted in slot meta. Don't reorder. */
  id: number;
  regex: RegExp;
  parse(s: string): bigint;
  format(micros: bigint): string;
}

const TIMESTAMP_SHAPES: TimestampShape[] = [
  // ISO 8601 with microseconds: `2005-06-03T15:42:50.675872Z`
  {
    id: 1,
    regex: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z?$/,
    parse(s) {
      const m = this.regex.exec(s);
      if (!m) throw new Error("ts iso8601-us mismatch");
      const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
      return BigInt(ms) * 1000n + BigInt(m[7]!);
    },
    format(micros) {
      return formatIsoLike(micros, "T", ":", ".", true);
    },
  },
  // BGL-style: `2005-06-03-15.42.50.675872`
  {
    id: 2,
    regex: /^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})\.(\d{6})$/,
    parse(s) {
      const m = this.regex.exec(s);
      if (!m) throw new Error("ts bgl mismatch");
      const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
      return BigInt(ms) * 1000n + BigInt(m[7]!);
    },
    format(micros) {
      return formatIsoLike(micros, "-", ".", ".", false);
    },
  },
  // ISO 8601 with milliseconds: `2017-05-16 00:00:00.008`
  {
    id: 3,
    regex: /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/,
    parse(s) {
      const m = this.regex.exec(s);
      if (!m) throw new Error("ts iso8601-ms mismatch");
      const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
      // milliseconds-precision; pad to micros.
      return BigInt(ms) * 1000n + BigInt(m[7]!) * 1000n;
    },
    format(micros) {
      const ms = Number(micros / 1000n);
      const d = new Date(ms);
      const yy = d.getUTCFullYear().toString().padStart(4, "0");
      const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
      const dd = d.getUTCDate().toString().padStart(2, "0");
      const hh = d.getUTCHours().toString().padStart(2, "0");
      const mm = d.getUTCMinutes().toString().padStart(2, "0");
      const ss = d.getUTCSeconds().toString().padStart(2, "0");
      const msStr = d.getUTCMilliseconds().toString().padStart(3, "0");
      return `${yy}-${mo}-${dd} ${hh}:${mm}:${ss}.${msStr}`;
    },
  },
];

function formatIsoLike(
  micros: bigint,
  dateSep: string,
  timeSep: string,
  fracSep: string,
  withZ: boolean
): string {
  const ms = Number(micros / 1000n);
  const us = Number(micros % 1000n);
  const d = new Date(ms);
  const yy = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  const fracMs = d.getUTCMilliseconds() * 1000 + us;
  const usStr = fracMs.toString().padStart(6, "0");
  const z = withZ ? "Z" : "";
  return `${yy}-${mo}-${dd}${dateSep}${hh}${timeSep}${mm}${timeSep}${ss}${fracSep}${usStr}${z}`;
}

const TYPED_SLOT_MIN_RECORDS = 50;

/**
 * Find the longest common prefix across `values`. Empty if values
 * differ from the first character. Cheap linear scan.
 */
function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  const first = values[0] as string;
  let prefixLen = first.length;
  for (let i = 1; i < values.length; i++) {
    const v = values[i] as string;
    const max = Math.min(prefixLen, v.length);
    let j = 0;
    while (j < max && v.charCodeAt(j) === first.charCodeAt(j)) j++;
    prefixLen = j;
    if (prefixLen === 0) return "";
  }
  return first.substring(0, prefixLen);
}

export interface TypedColumnarDrainPolicyConfig {
  /** Bytes codec for the binary payload. Default `"zstd-19"`. */
  bodyCodec?: string;
  /** Drain instance to share across chunks. Default: a fresh Drain. */
  drain?: Drain;
}

interface TypedColumnarChunkMeta {
  v: 3;
  drain: true;
  /**
   * Distinct literal tokens from all templates used in this chunk.
   * Stored uncompressed in the chunk header so the query engine can
   * prune chunks for bodyContains without ZSTD decompression.
   * Only non-PARAM_STR tokens are included.
   */
  toks?: string[];
}

// ── ByteBuf / ByteCursor ─────────────────────────────────────────────
//
// Growable single-buffer writer. The previous implementation pushed a
// fresh Uint8Array per call (pushByte → 1-byte alloc, pushVarint →
// up-to-5-byte alloc) into a chunks list, then concat'd them in
// finish(). On OpenStack-2k that pattern showed up as ~5% of total CPU
// (pushVarint 1.1%, finish 0.7%) plus GC pressure from tens of
// thousands of micro-allocs.
//
// This version writes into a single Uint8Array, growing 2× when full.
// Each push is one bounds check + one or a few byte writes. finish()
// is a single subarray.
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
  pushI64LE(n: bigint): void {
    this.ensureCapacity(8);
    this.view.setBigInt64(this.len, n, true);
    this.len += 8;
  }
  pushVarint(n: number): void {
    // Worst case 5 bytes for u32; ensure once.
    this.ensureCapacity(5);
    while (n >= 0x80) {
      this.buf[this.len++] = (n & 0x7f) | 0x80;
      n >>>= 7;
    }
    this.buf[this.len++] = n & 0x7f;
  }
  pushZZVarintBig(v: bigint): void {
    // ZigZag-encode then varint. Worst case 10 bytes for a u64.
    this.ensureCapacity(10);
    let zz = (v << 1n) ^ (v >> 63n);
    while (zz >= 0x80n) {
      this.buf[this.len++] = Number(zz & 0x7fn) | 0x80;
      zz >>= 7n;
    }
    this.buf[this.len++] = Number(zz);
  }
  finish(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

class ByteCursor {
  private cur: number = 0;
  constructor(private readonly buf: Uint8Array) {}
  remaining(): number {
    return this.buf.length - this.cur;
  }
  readByte(): number {
    if (this.cur >= this.buf.length) throw new Error("typed: read past end");
    return this.buf[this.cur++] as number;
  }
  readBytes(len: number): Uint8Array {
    const end = this.cur + len;
    if (end > this.buf.length) throw new Error("typed: read past end");
    const out = this.buf.subarray(this.cur, end);
    this.cur = end;
    return out;
  }
  readU64LE(): bigint {
    if (this.cur + 8 > this.buf.length) throw new Error("typed: read past end");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.cur, 8).getBigUint64(
      0,
      true
    );
    this.cur += 8;
    return v;
  }
  readI64LE(): bigint {
    if (this.cur + 8 > this.buf.length) throw new Error("typed: read past end");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.cur, 8).getBigInt64(0, true);
    this.cur += 8;
    return v;
  }
  readVarint(): number {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = this.readByte();
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7;
      if (shift > 28) throw new Error("typed: varint overflow");
    }
  }
  readZZVarintBig(): bigint {
    let v = 0n;
    let shift = 0n;
    while (true) {
      const b = BigInt(this.readByte());
      v |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) {
        return (v >> 1n) ^ -(v & 1n);
      }
      shift += 7n;
      if (shift > 70n) throw new Error("typed: zigzag varint overflow");
    }
  }
}

// ── Slot-type detection ──────────────────────────────────────────────

interface PerTemplateSlotInfo {
  /** Values per slot index (in record order within the template). */
  valuesBySlot: Map<number, string[]>;
}

interface ClassifiedSlot {
  type: number;
  /** For PREFIXED_INT64 / PREFIXED_UUID: the literal string prefix. */
  prefix?: string;
  /** For TIMESTAMP_DELTA: the `id` of the matched TimestampShape. */
  timestampShapeId?: number;
}

function classifySlots(perTemplate: Map<number, PerTemplateSlotInfo>): Map<string, ClassifiedSlot> {
  // Returns a map from `${templateId}/${slotIdx}` to ClassifiedSlot.
  // Default (SLOT_STRING) entries are omitted.
  //
  // Detection order — most-specific first, with prefix-aware shapes
  // checked AFTER the no-prefix shapes (a value matching `<int>$`
  // wins over `<prefix><int>$` with empty prefix):
  //   1. SLOT_UUID         (canonical 8-4-4-4-12)
  //   2. SLOT_UUID_NODASH  (32 hex)
  //   3. SLOT_TIMESTAMP_DELTA  (try each TIMESTAMP_SHAPES entry)
  //   4. SLOT_SIGNED_INT   (no prefix, canonical int)
  //   5. SLOT_PREFIXED_INT64 (common prefix + canonical int residual)
  //   6. SLOT_PREFIXED_UUID  (common prefix + canonical UUID residual)
  const out = new Map<string, ClassifiedSlot>();
  for (const [tplId, info] of perTemplate) {
    for (const [slotIdx, values] of info.valuesBySlot) {
      if (values.length < TYPED_SLOT_MIN_RECORDS) continue;
      const key = `${tplId}/${slotIdx}`;

      // 1. Canonical UUID.
      if (values.every((v) => UUID_REGEX.test(v))) {
        out.set(key, { type: SLOT_UUID });
        continue;
      }
      // 2. UUID without dashes (32 hex).
      if (values.every((v) => UUID_NODASH_REGEX.test(v))) {
        out.set(key, { type: SLOT_UUID_NODASH });
        continue;
      }
      // 3. Timestamp shapes — first one whose regex matches all values.
      let tsHit: number | undefined;
      for (const ts of TIMESTAMP_SHAPES) {
        if (values.every((v) => ts.regex.test(v))) {
          tsHit = ts.id;
          break;
        }
      }
      if (tsHit !== undefined) {
        out.set(key, { type: SLOT_TIMESTAMP_DELTA, timestampShapeId: tsHit });
        continue;
      }
      // 4. Bare canonical int (no prefix).
      if (values.every((v) => SIGNED_INT_REGEX.test(v))) {
        out.set(key, { type: SLOT_SIGNED_INT });
        continue;
      }
      // 5/6. Prefix + (int | UUID) residual. Find longest common
      // prefix once, check residual shape.
      const prefix = commonPrefix(values);
      if (prefix.length === 0) continue;
      // Reject prefixes that would steal residual bits — if the prefix
      // ends in a digit or hex char, a numeric residual could be
      // ambiguous on round-trip (e.g. prefix "12" + residual "3" vs
      // prefix "1" + residual "23"). Require the prefix to end in a
      // non-alphanumeric byte (or the prefix to be a "safe" word
      // character followed by a separator). Simpler: just require the
      // last char of the prefix to be a non-alphanumeric.
      const last = prefix.charCodeAt(prefix.length - 1);
      const lastIsAlnum =
        (last >= 0x30 && last <= 0x39) ||
        (last >= 0x41 && last <= 0x5a) ||
        (last >= 0x61 && last <= 0x7a);
      if (lastIsAlnum) continue;
      // Try residual shapes.
      const plen = prefix.length;
      const allIntResidual = values.every((v) => SIGNED_INT_REGEX.test(v.substring(plen)));
      if (allIntResidual) {
        out.set(key, { type: SLOT_PREFIXED_INT64, prefix });
        continue;
      }
      const allUuidResidual = values.every((v) => UUID_REGEX.test(v.substring(plen)));
      if (allUuidResidual) {
        out.set(key, { type: SLOT_PREFIXED_UUID, prefix });
      }
    }
  }
  return out;
}

/** Find the TimestampShape with the given id, or throw. */
function tsShape(id: number): TimestampShape {
  const s = TIMESTAMP_SHAPES.find((t) => t.id === id);
  if (!s) throw new Error(`typed: unknown timestamp shape id ${id}`);
  return s;
}

/** Parse a canonical lowercase UUID string into 16 bytes. */
function uuidToBytes(s: string): Uint8Array {
  // Format: 8-4-4-4-12 hex chars = 36 chars. Strip dashes → 32 hex
  // chars → 16 bytes.
  const out = new Uint8Array(16);
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x2d) continue; // dash
    const hi = hexNibble(ch);
    i++;
    const lo = hexNibble(s.charCodeAt(i));
    out[cur++] = (hi << 4) | lo;
  }
  return out;
}

/** Parse a 32-hex-char UUID-no-dash string into 16 bytes. */
function uuidNodashToBytes(s: string): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = (hexNibble(s.charCodeAt(i * 2)) << 4) | hexNibble(s.charCodeAt(i * 2 + 1));
  }
  return out;
}

/** Format 16 bytes as 32 lowercase hex chars (no dashes). */
// Hex-byte lookup table: BYTE_TO_HEX[b] = "00".."ff". Avoids two
// per-byte string allocations + the array.join in the per-record
// hot path. Built once at module load.
const BYTE_TO_HEX: string[] = (() => {
  const out = new Array<string>(256);
  const hex = "0123456789abcdef";
  for (let b = 0; b < 256; b++) {
    out[b] = (hex[b >> 4] as string) + (hex[b & 0xf] as string);
  }
  return out;
})();

function bytesToUuidNodash(b: Uint8Array): string {
  // Direct concat with the precomputed byte-to-hex table.
  return (
    BYTE_TO_HEX[b[0] as number]! +
    BYTE_TO_HEX[b[1] as number]! +
    BYTE_TO_HEX[b[2] as number]! +
    BYTE_TO_HEX[b[3] as number]! +
    BYTE_TO_HEX[b[4] as number]! +
    BYTE_TO_HEX[b[5] as number]! +
    BYTE_TO_HEX[b[6] as number]! +
    BYTE_TO_HEX[b[7] as number]! +
    BYTE_TO_HEX[b[8] as number]! +
    BYTE_TO_HEX[b[9] as number]! +
    BYTE_TO_HEX[b[10] as number]! +
    BYTE_TO_HEX[b[11] as number]! +
    BYTE_TO_HEX[b[12] as number]! +
    BYTE_TO_HEX[b[13] as number]! +
    BYTE_TO_HEX[b[14] as number]! +
    BYTE_TO_HEX[b[15] as number]!
  );
}

function hexNibble(ch: number): number {
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
  if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10;
  if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10;
  return 0;
}

/** Format 16 bytes as canonical lowercase UUID — 8-4-4-4-12. */
function bytesToUuid(b: Uint8Array): string {
  // Direct concat. CPU profile : bytesToUuid was 11.4 %
  // of decode self-time on OpenStack 500K-record stores because
  // each call did 16 array.push pairs + 4 dash inserts + a join.
  return (
    BYTE_TO_HEX[b[0] as number]! +
    BYTE_TO_HEX[b[1] as number]! +
    BYTE_TO_HEX[b[2] as number]! +
    BYTE_TO_HEX[b[3] as number]! +
    "-" +
    BYTE_TO_HEX[b[4] as number]! +
    BYTE_TO_HEX[b[5] as number]! +
    "-" +
    BYTE_TO_HEX[b[6] as number]! +
    BYTE_TO_HEX[b[7] as number]! +
    "-" +
    BYTE_TO_HEX[b[8] as number]! +
    BYTE_TO_HEX[b[9] as number]! +
    "-" +
    BYTE_TO_HEX[b[10] as number]! +
    BYTE_TO_HEX[b[11] as number]! +
    BYTE_TO_HEX[b[12] as number]! +
    BYTE_TO_HEX[b[13] as number]! +
    BYTE_TO_HEX[b[14] as number]! +
    BYTE_TO_HEX[b[15] as number]!
  );
}

// ── Sidecar helpers (small JSON for non-modeled fields) ──────────────

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) {
    out += (b[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.substring(i * 2, i * 2 + 2), 16);
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

// ── Encode ───────────────────────────────────────────────────────────

function encode(
  records: readonly LogRecord[],
  drain: Drain
): {
  payload: Uint8Array;
  meta: TypedColumnarChunkMeta;
} {
  const n = records.length;
  const buf = new ByteBuf();
  buf.pushVarint(n);

  // Timestamps: delta-of-prior + ZigZag + varint (same as columnar).
  let prevTs = 0n;
  for (let i = 0; i < n; i++) {
    const ts = (records[i] as LogRecord).timeUnixNano;
    buf.pushZZVarintBig(ts - prevTs);
    prevTs = ts;
  }

  // Severity numbers: u8 × n.
  for (let i = 0; i < n; i++) {
    const s = (records[i] as LogRecord).severityNumber;
    buf.pushByte(s & 0xff);
  }

  // Pass 1: ingest every string body so Drain templates stabilize.
  const tplIdsByRecord = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const r = records[i] as LogRecord;
    if (typeof r.body === "string") {
      tplIdsByRecord[i] = drain.matchOrAdd(r.body).templateId;
    }
  }

  // Templates used in this chunk.
  const templatesById = new Map<number, string[]>();
  const templatesInPayload: { id: number; template: string }[] = [];
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

  // Decide kinds.
  const kinds = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = records[i] as LogRecord;
    if (typeof r.body !== "string") {
      kinds[i] = KIND_OTHER;
      continue;
    }
    const tplId = tplIdsByRecord[i] as number;
    if (tplId >= 0 && templatesById.has(tplId)) {
      kinds[i] = KIND_TEMPLATED;
    } else {
      kinds[i] = KIND_RAW_STRING;
    }
  }
  buf.pushBytes(kinds);

  // Embed template dictionary inside the payload.
  const enc = new TextEncoder();
  buf.pushVarint(templatesInPayload.length);
  for (const t of templatesInPayload) {
    buf.pushVarint(t.id);
    const tb = enc.encode(t.template);
    buf.pushVarint(tb.length);
    buf.pushBytes(tb);
  }
  // Slot-type entries are emitted into the payload (post template
  // dict, pre raw-string bodies) so the chunk header stays tiny.
  // Format: varint count, then count × (varint tplId, varint slotIdx,
  // u8 type). Empty list = no typed slots in this chunk.
  // We need to compute the slot types BEFORE templated rows are
  // emitted because the decoder must know the typing to decode the
  // var bytes; do it here.

  // Raw-string bodies, in original record order.
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== KIND_RAW_STRING) continue;
    const r = records[i] as LogRecord;
    const bytes = enc.encode(r.body as string);
    buf.pushVarint(bytes.length);
    buf.pushBytes(bytes);
  }

  // ── Templated bodies — pass 2: gather (template_id, vars[]) per record ──
  interface TemplatedRow {
    templateId: number;
    vars: string[];
  }
  const templatedRows: TemplatedRow[] = [];
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== KIND_TEMPLATED) continue;
    const r = records[i] as LogRecord;
    const tplId = tplIdsByRecord[i] as number;
    const finalTemplate = templatesById.get(tplId) as string[];
    const tokens = tokenize(r.body as string);
    const vars =
      finalTemplate.length === tokens.length
        ? extractVarsAgainstTemplate(finalTemplate, tokens)
        : [];
    templatedRows.push({ templateId: tplId, vars });
  }

  // ── Slot-type classification (per template, per slot) ──
  const perTemplate = new Map<number, PerTemplateSlotInfo>();
  for (const row of templatedRows) {
    let info = perTemplate.get(row.templateId);
    if (!info) {
      info = { valuesBySlot: new Map() };
      perTemplate.set(row.templateId, info);
    }
    for (let s = 0; s < row.vars.length; s++) {
      let arr = info.valuesBySlot.get(s);
      if (!arr) {
        arr = [];
        info.valuesBySlot.set(s, arr);
      }
      arr.push(row.vars[s] as string);
    }
  }
  const slotTypeMap = classifySlots(perTemplate);

  // Helper: type code lookup with default to SLOT_STRING.
  const typeOf = (tplId: number, slotIdx: number): number =>
    slotTypeMap.get(`${tplId}/${slotIdx}`)?.type ?? SLOT_STRING;

  // Emit slot-type table inside the compressed payload. Format:
  //   varint count
  //   count × (varint tplId, varint slotIdx, u8 type, [type-specific])
  //
  // Type-specific payload:
  //   SLOT_PREFIXED_INT64 / SLOT_PREFIXED_UUID:
  //     varint prefix_len, prefix_len bytes utf-8
  //   SLOT_TIMESTAMP_DELTA:
  //     varint timestamp_shape_id
  //   (other types carry no payload)
  buf.pushVarint(slotTypeMap.size);
  for (const [key, slot] of slotTypeMap) {
    const [tplStr, slotStr] = key.split("/");
    buf.pushVarint(Number(tplStr));
    buf.pushVarint(Number(slotStr));
    buf.pushByte(slot.type);
    if (slot.type === SLOT_PREFIXED_INT64 || slot.type === SLOT_PREFIXED_UUID) {
      const pb = enc.encode(slot.prefix as string);
      buf.pushVarint(pb.length);
      buf.pushBytes(pb);
    } else if (slot.type === SLOT_TIMESTAMP_DELTA) {
      buf.pushVarint(slot.timestampShapeId as number);
    }
  }

  // ── Emit templated columns ──
  // template_ids column
  for (const row of templatedRows) buf.pushVarint(row.templateId);
  // var-count column
  for (const row of templatedRows) buf.pushVarint(row.vars.length);

  // var-bytes section, emitted homogeneously by slot type to give
  // ZSTD long contiguous runs of one byte-shape. Six back-to-back
  // sub-regions, in this order:
  //   1. SLOT_STRING               (length-prefixed UTF-8)
  //   2. SLOT_SIGNED_INT           (ZZ-varint)
  //   3. SLOT_PREFIXED_INT64       (raw 8-byte LE i64 residual)
  //   4. SLOT_UUID                 (16 raw bytes)
  //   5. SLOT_UUID_NODASH          (16 raw bytes)
  //   6. SLOT_PREFIXED_UUID        (16 raw bytes residual)
  //   7. SLOT_TIMESTAMP_DELTA      (ZZ-varint delta of unix-micros,
  //                                 per-(template, slot) delta chain)
  // Pass 1: SLOT_STRING
  for (const row of templatedRows) {
    for (let s = 0; s < row.vars.length; s++) {
      if (typeOf(row.templateId, s) !== SLOT_STRING) continue;
      const v = row.vars[s] as string;
      const bytes = enc.encode(v);
      buf.pushVarint(bytes.length);
      buf.pushBytes(bytes);
    }
  }
  // Pass 2: SLOT_SIGNED_INT
  for (const row of templatedRows) {
    for (let s = 0; s < row.vars.length; s++) {
      if (typeOf(row.templateId, s) !== SLOT_SIGNED_INT) continue;
      buf.pushZZVarintBig(BigInt(row.vars[s] as string));
    }
  }
  // Pass 3: SLOT_PREFIXED_INT64 (residual after stripping the per-slot prefix)
  for (const row of templatedRows) {
    for (let s = 0; s < row.vars.length; s++) {
      const slot = slotTypeMap.get(`${row.templateId}/${s}`);
      if (slot?.type !== SLOT_PREFIXED_INT64) continue;
      const v = row.vars[s] as string;
      const residual = v.substring((slot.prefix as string).length);
      buf.pushI64LE(BigInt(residual));
    }
  }
  // Pass 4: SLOT_UUID
  for (const row of templatedRows) {
    for (let s = 0; s < row.vars.length; s++) {
      if (typeOf(row.templateId, s) !== SLOT_UUID) continue;
      buf.pushBytes(uuidToBytes(row.vars[s] as string));
    }
  }
  // Pass 5: SLOT_UUID_NODASH
  for (const row of templatedRows) {
    for (let s = 0; s < row.vars.length; s++) {
      if (typeOf(row.templateId, s) !== SLOT_UUID_NODASH) continue;
      buf.pushBytes(uuidNodashToBytes(row.vars[s] as string));
    }
  }
  // Pass 6: SLOT_PREFIXED_UUID
  for (const row of templatedRows) {
    for (let s = 0; s < row.vars.length; s++) {
      const slot = slotTypeMap.get(`${row.templateId}/${s}`);
      if (slot?.type !== SLOT_PREFIXED_UUID) continue;
      const v = row.vars[s] as string;
      const residual = v.substring((slot.prefix as string).length);
      buf.pushBytes(uuidToBytes(residual));
    }
  }
  // Pass 7: SLOT_TIMESTAMP_DELTA. Per-(template, slot) delta chain.
  const tsPrev = new Map<string, bigint>();
  for (const row of templatedRows) {
    for (let s = 0; s < row.vars.length; s++) {
      const slot = slotTypeMap.get(`${row.templateId}/${s}`);
      if (slot?.type !== SLOT_TIMESTAMP_DELTA) continue;
      const v = row.vars[s] as string;
      const shape = tsShape(slot.timestampShapeId as number);
      const cur = shape.parse(v);
      const key = `${row.templateId}/${s}`;
      const prev = tsPrev.get(key) ?? 0n;
      buf.pushZZVarintBig(cur - prev);
      tsPrev.set(key, cur);
    }
  }

  // Sidecar (same shape as ColumnarDrainPolicy).
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
      side.a = r.attributes.map((kv: KeyValue) => ({
        k: kv.key,
        v: anyValueToJson(kv.value),
      }));
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
  if (!sidecarHasContent) {
    buf.pushVarint(0);
  } else {
    const sidecar = enc.encode(`${sidecarLines.join("\n")}\n`);
    buf.pushVarint(sidecar.length);
    buf.pushBytes(sidecar);
  }

  const meta: TypedColumnarChunkMeta = { v: 3, drain: true };
  // Collect distinct literal tokens from templates for bodyContains pruning.
  // Only include non-wildcard tokens (template literals, not PARAM_STR).
  const tokenSet = new Set<string>();
  for (const { template } of templatesInPayload) {
    for (const tok of template.split(/\s+/)) {
      if (tok.length > 0 && tok !== PARAM_STR) tokenSet.add(tok);
    }
  }
  if (tokenSet.size > 0) meta.toks = [...tokenSet];
  return { payload: buf.finish(), meta };
}

// ── Decode ───────────────────────────────────────────────────────────

function decode(buf: Uint8Array, expectedN: number, _meta: TypedColumnarChunkMeta): LogRecord[] {
  const cur = new ByteCursor(buf);
  const n = cur.readVarint();
  if (n !== expectedN) {
    throw new Error(`typed: count mismatch payload=${n} header=${expectedN}`);
  }
  // timestamps
  const timestamps = new BigInt64Array(n);
  let prevTs = 0n;
  for (let i = 0; i < n; i++) {
    const dt = cur.readZZVarintBig();
    prevTs = prevTs + dt;
    timestamps[i] = prevTs;
  }
  // severities
  const severities = new Uint8Array(n);
  for (let i = 0; i < n; i++) severities[i] = cur.readByte();
  // kinds
  const kinds = new Uint8Array(cur.readBytes(n));
  // template dictionary
  const nTemplates = cur.readVarint();
  const templateById = new Map<number, string[]>();
  const dec = new TextDecoder();
  for (let t = 0; t < nTemplates; t++) {
    const id = cur.readVarint();
    const len = cur.readVarint();
    const tplStr = dec.decode(cur.readBytes(len));
    templateById.set(
      id,
      tplStr.split(/\s+/).filter((s) => s.length > 0)
    );
  }
  // slot-type table. We read into a sparse Map<string, DecodedSlot>
  // first (the on-wire form) but then transpose into per-template
  // flat arrays so the per-record decode passes can do one array
  // load per slot instead of a Map.get with a string key.
  //
  // CPU profile evidence (2026-04-26 CPU profile): the previous
  // `typeOf(tplId, slot)` helper that did `slotTypes.get(`${tplId}/${slot}`)`
  // showed up at 12.6 %–17.1 % of decode CPU on Apache / OpenStack
  // 500K-record stores. Each call allocated a fresh template-literal
  // string + a Map.get; with 7 passes × 62500 templated records ×
  // ~3 vars each, that's ~1.3 M string allocs per query.
  interface DecodedSlot {
    type: number;
    prefix?: string;
    timestampShapeId?: number;
  }
  const slotTypeMap = new Map<string, DecodedSlot>();
  const nSlotTypes = cur.readVarint();
  for (let i = 0; i < nSlotTypes; i++) {
    const tplId = cur.readVarint();
    const slotIdx = cur.readVarint();
    const type = cur.readByte();
    const entry: DecodedSlot = { type };
    if (type === SLOT_PREFIXED_INT64 || type === SLOT_PREFIXED_UUID) {
      const plen = cur.readVarint();
      entry.prefix = dec.decode(cur.readBytes(plen));
    } else if (type === SLOT_TIMESTAMP_DELTA) {
      entry.timestampShapeId = cur.readVarint();
    }
    slotTypeMap.set(`${tplId}/${slotIdx}`, entry);
  }
  // Transpose to per-template flat arrays. `slotTypeArrays.get(tplId)`
  // → Int8Array indexed by slotIdx (default = SLOT_STRING for any
  // slot index that has no entry). `slotPrefixArrays.get(tplId)` →
  // (string|undefined)[] keyed by slotIdx for PREFIXED_*. Same for
  // timestamp shapes.
  const slotTypeArrays = new Map<number, Int8Array>();
  const slotPrefixArrays = new Map<number, (string | undefined)[]>();
  const slotTsShapeArrays = new Map<number, (number | undefined)[]>();
  for (const [tplId, template] of templateById) {
    // Count wildcards in the template = max slotIdx + 1.
    let nVars = 0;
    for (const t of template) if (t === PARAM_STR) nVars++;
    if (nVars === 0) continue;
    const types = new Int8Array(nVars); // default 0 = SLOT_STRING
    const prefixes = new Array<string | undefined>(nVars);
    const tsShapes = new Array<number | undefined>(nVars);
    for (let s = 0; s < nVars; s++) {
      const slot = slotTypeMap.get(`${tplId}/${s}`);
      if (!slot) continue;
      types[s] = slot.type;
      if (slot.prefix !== undefined) prefixes[s] = slot.prefix;
      if (slot.timestampShapeId !== undefined) tsShapes[s] = slot.timestampShapeId;
    }
    slotTypeArrays.set(tplId, types);
    slotPrefixArrays.set(tplId, prefixes);
    slotTsShapeArrays.set(tplId, tsShapes);
  }
  // raw-string bodies in record order
  const rawStringByRecord = new Map<number, string>();
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== KIND_RAW_STRING) continue;
    const len = cur.readVarint();
    rawStringByRecord.set(i, dec.decode(cur.readBytes(len)));
  }
  // templated columns
  const templatedIndices: number[] = [];
  for (let i = 0; i < n; i++) if (kinds[i] === KIND_TEMPLATED) templatedIndices.push(i);
  const tplIds: number[] = new Array(templatedIndices.length);
  for (let i = 0; i < templatedIndices.length; i++) tplIds[i] = cur.readVarint();
  const varCounts: number[] = new Array(templatedIndices.length);
  for (let i = 0; i < templatedIndices.length; i++) varCounts[i] = cur.readVarint();
  // Homogeneous var-bytes section: same 7-pass order encode used.
  const allVars: string[][] = templatedIndices.map(
    (_, i) => new Array<string>(varCounts[i] as number)
  );
  // Pass 1: SLOT_STRING
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_STRING) continue;
      const len = cur.readVarint();
      vars[s] = dec.decode(cur.readBytes(len));
    }
  }
  // Pass 2: SLOT_SIGNED_INT
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_SIGNED_INT) continue;
      vars[s] = cur.readZZVarintBig().toString();
    }
  }
  // Pass 3: SLOT_PREFIXED_INT64 (residual i64; prepend the slot prefix)
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const prefixes = slotPrefixArrays.get(tplId);
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_PREFIXED_INT64) continue;
      const big = cur.readI64LE();
      vars[s] = `${prefixes?.[s] ?? ""}${big.toString()}`;
    }
  }
  // Pass 4: SLOT_UUID
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_UUID) continue;
      vars[s] = bytesToUuid(cur.readBytes(16));
    }
  }
  // Pass 5: SLOT_UUID_NODASH
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_UUID_NODASH) continue;
      vars[s] = bytesToUuidNodash(cur.readBytes(16));
    }
  }
  // Pass 6: SLOT_PREFIXED_UUID
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const prefixes = slotPrefixArrays.get(tplId);
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_PREFIXED_UUID) continue;
      const bytes = cur.readBytes(16);
      vars[s] = `${prefixes?.[s] ?? ""}${bytesToUuid(bytes)}`;
    }
  }
  // Pass 7: SLOT_TIMESTAMP_DELTA — per-(template, slot) delta chain.
  // Use a flat number-keyed Map<encodedKey, bigint> to avoid string
  // allocation in the inner loop. encodedKey = (tplId << 16) | slotIdx
  // — we don't expect tplId or slotIdx to exceed 65535.
  const tsPrev = new Map<number, bigint>();
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const tsShapeIds = slotTsShapeArrays.get(tplId);
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_TIMESTAMP_DELTA) continue;
      const dt = cur.readZZVarintBig();
      const key = (tplId << 16) | s;
      const prev = tsPrev.get(key) ?? 0n;
      const cur2 = prev + dt;
      tsPrev.set(key, cur2);
      const shape = tsShape(tsShapeIds?.[s] as number);
      vars[s] = shape.format(cur2);
    }
  }
  // Now reconstruct templated bodies.
  const templatedBodies: string[] = new Array(templatedIndices.length);
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const template = templateById.get(tplId);
    if (!template) throw new Error(`typed: missing template id ${tplId}`);
    templatedBodies[i] = reconstruct(template, allVars[i] as string[]);
  }
  // sidecar
  const sidecarLen = cur.readVarint();
  const sidecarMap = new Map<number, Record<string, unknown>>();
  if (sidecarLen > 0) {
    const sidecarText = dec.decode(cur.readBytes(sidecarLen));
    const lines = sidecarText.split("\n").filter((l) => l.length > 0);
    if (lines.length !== n) {
      throw new Error(`typed: sidecar line count ${lines.length} != n ${n}`);
    }
    for (let i = 0; i < n; i++) {
      sidecarMap.set(i, JSON.parse(lines[i] as string) as Record<string, unknown>);
    }
  }

  // Stitch records.
  const out: LogRecord[] = new Array(n);
  let templatedCursor = 0;
  for (let i = 0; i < n; i++) {
    const side = sidecarMap.get(i) ?? {};
    let body: AnyValue;
    if (kinds[i] === KIND_RAW_STRING) {
      body = rawStringByRecord.get(i) ?? "";
    } else if (kinds[i] === KIND_TEMPLATED) {
      body = templatedBodies[templatedCursor++] as string;
    } else {
      body = jsonToAnyValue(side.b);
    }
    const rec: LogRecord = {
      timeUnixNano: timestamps[i] as bigint,
      severityNumber: severities[i] as number,
      severityText: ((side.st as SeverityText) ?? "INFO") as SeverityText,
      body,
      attributes: side.a
        ? (side.a as Array<{ k: string; v: unknown }>).map((kv) => ({
            key: kv.k,
            value: jsonToAnyValue(kv.v),
          }))
        : [],
    };
    if (side.o !== undefined) rec.observedTimeUnixNano = BigInt(side.o as string);
    if (side.f !== undefined) rec.flags = side.f as number;
    if (side.ti) rec.traceId = hexToBytes(side.ti as string);
    if (side.si) rec.spanId = hexToBytes(side.si as string);
    if (side.e) rec.eventName = side.e as string;
    if (side.d) rec.droppedAttributesCount = side.d as number;
    out[i] = rec;
  }
  return out;
}

/**
 * Partial decode: extract only body values from the payload. Skips the
 * sidecar JSON.parse() (which is ~40-60% of full decode CPU) and
 * attribute/traceId/spanId reconstruction. Returns AnyValue[] in record
 * order suitable for substring matching.
 *
 * For KIND_OTHER records (structured bodies stored in sidecar), we must
 * still parse those specific sidecar lines. But for templated and
 * raw-string bodies (the 95%+ case), zero JSON parsing occurs.
 */
function decodeBodies(buf: Uint8Array, expectedN: number): AnyValue[] {
  const cur = new ByteCursor(buf);
  const n = cur.readVarint();
  if (n !== expectedN) {
    throw new Error(`typed: count mismatch payload=${n} header=${expectedN}`);
  }
  // Skip timestamps (delta-encoded varints)
  for (let i = 0; i < n; i++) cur.readZZVarintBig();
  // Skip severities
  cur.readBytes(n);
  // kinds
  const kinds = new Uint8Array(cur.readBytes(n));
  // template dictionary
  const nTemplates = cur.readVarint();
  const templateById = new Map<number, string[]>();
  const dec = new TextDecoder();
  for (let t = 0; t < nTemplates; t++) {
    const id = cur.readVarint();
    const len = cur.readVarint();
    const tplStr = dec.decode(cur.readBytes(len));
    templateById.set(
      id,
      tplStr.split(/\s+/).filter((s) => s.length > 0)
    );
  }
  // slot-type table
  const slotTypeArrays = new Map<number, Int8Array>();
  const slotPrefixArrays = new Map<number, (string | undefined)[]>();
  const slotTsShapeArrays = new Map<number, (number | undefined)[]>();
  const nSlotTypes = cur.readVarint();
  const slotTypeMap = new Map<
    string,
    { type: number; prefix?: string; timestampShapeId?: number }
  >();
  for (let i = 0; i < nSlotTypes; i++) {
    const tplId = cur.readVarint();
    const slotIdx = cur.readVarint();
    const type = cur.readByte();
    const entry: { type: number; prefix?: string; timestampShapeId?: number } = { type };
    if (type === SLOT_PREFIXED_INT64 || type === SLOT_PREFIXED_UUID) {
      const plen = cur.readVarint();
      entry.prefix = dec.decode(cur.readBytes(plen));
    } else if (type === SLOT_TIMESTAMP_DELTA) {
      entry.timestampShapeId = cur.readVarint();
    }
    slotTypeMap.set(`${tplId}/${slotIdx}`, entry);
  }
  // Transpose to per-template arrays (same as full decode)
  for (const [tplId, template] of templateById) {
    let nVars = 0;
    for (const t of template) if (t === PARAM_STR) nVars++;
    if (nVars === 0) continue;
    const types = new Int8Array(nVars);
    const prefixes = new Array<string | undefined>(nVars);
    const tsShapes = new Array<number | undefined>(nVars);
    for (let s = 0; s < nVars; s++) {
      const slot = slotTypeMap.get(`${tplId}/${s}`);
      if (!slot) continue;
      types[s] = slot.type;
      if (slot.prefix !== undefined) prefixes[s] = slot.prefix;
      if (slot.timestampShapeId !== undefined) tsShapes[s] = slot.timestampShapeId;
    }
    slotTypeArrays.set(tplId, types);
    slotPrefixArrays.set(tplId, prefixes);
    slotTsShapeArrays.set(tplId, tsShapes);
  }
  // raw-string bodies
  const rawStringByRecord = new Map<number, string>();
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== KIND_RAW_STRING) continue;
    const len = cur.readVarint();
    rawStringByRecord.set(i, dec.decode(cur.readBytes(len)));
  }
  // templated columns
  const templatedIndices: number[] = [];
  for (let i = 0; i < n; i++) if (kinds[i] === KIND_TEMPLATED) templatedIndices.push(i);
  const tplIds: number[] = new Array(templatedIndices.length);
  for (let i = 0; i < templatedIndices.length; i++) tplIds[i] = cur.readVarint();
  const varCounts: number[] = new Array(templatedIndices.length);
  for (let i = 0; i < templatedIndices.length; i++) varCounts[i] = cur.readVarint();
  const allVars: string[][] = templatedIndices.map(
    (_, i) => new Array<string>(varCounts[i] as number)
  );
  // 7 passes (same as full decode — bodies depend on variable reconstruction)
  // Pass 1: SLOT_STRING
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_STRING) continue;
      const len = cur.readVarint();
      vars[s] = dec.decode(cur.readBytes(len));
    }
  }
  // Pass 2: SLOT_SIGNED_INT
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_SIGNED_INT) continue;
      vars[s] = cur.readZZVarintBig().toString();
    }
  }
  // Pass 3: SLOT_PREFIXED_INT64
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const prefixes = slotPrefixArrays.get(tplId);
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_PREFIXED_INT64) continue;
      const big = cur.readI64LE();
      vars[s] = `${prefixes?.[s] ?? ""}${big.toString()}`;
    }
  }
  // Pass 4: SLOT_UUID
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_UUID) continue;
      vars[s] = bytesToUuid(cur.readBytes(16));
    }
  }
  // Pass 5: SLOT_UUID_NODASH
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_UUID_NODASH) continue;
      vars[s] = bytesToUuidNodash(cur.readBytes(16));
    }
  }
  // Pass 6: SLOT_PREFIXED_UUID
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const prefixes = slotPrefixArrays.get(tplId);
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_PREFIXED_UUID) continue;
      vars[s] = `${prefixes?.[s] ?? ""}${bytesToUuid(cur.readBytes(16))}`;
    }
  }
  // Pass 7: SLOT_TIMESTAMP_DELTA
  const tsPrev = new Map<number, bigint>();
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const types = slotTypeArrays.get(tplId);
    if (!types) continue;
    const tsShapeIds = slotTsShapeArrays.get(tplId);
    const nVars = varCounts[i] as number;
    const vars = allVars[i] as string[];
    for (let s = 0; s < nVars; s++) {
      if (types[s] !== SLOT_TIMESTAMP_DELTA) continue;
      const dt = cur.readZZVarintBig();
      const key = (tplId << 16) | s;
      const prev = tsPrev.get(key) ?? 0n;
      const cur2 = prev + dt;
      tsPrev.set(key, cur2);
      const shape = tsShape(tsShapeIds?.[s] as number);
      vars[s] = shape.format(cur2);
    }
  }
  // Reconstruct templated bodies
  const templatedBodies: string[] = new Array(templatedIndices.length);
  for (let i = 0; i < templatedIndices.length; i++) {
    const tplId = tplIds[i] as number;
    const template = templateById.get(tplId);
    if (!template) throw new Error(`typed: missing template id ${tplId}`);
    templatedBodies[i] = reconstruct(template, allVars[i] as string[]);
  }

  // Read sidecar ONLY for KIND_OTHER records (structured bodies)
  const hasOther = kinds.some((k) => k === KIND_OTHER);
  let otherBodies: Map<number, AnyValue> | undefined;
  if (hasOther) {
    const sidecarLen = cur.readVarint();
    if (sidecarLen > 0) {
      const sidecarText = dec.decode(cur.readBytes(sidecarLen));
      const lines = sidecarText.split("\n").filter((l) => l.length > 0);
      otherBodies = new Map();
      for (let i = 0; i < n; i++) {
        if (kinds[i] !== KIND_OTHER) continue;
        const side = JSON.parse(lines[i] as string) as Record<string, unknown>;
        otherBodies.set(i, jsonToAnyValue(side.b));
      }
    }
  }

  // Assemble body-only output (no LogRecord construction, no attribute parse)
  const out: AnyValue[] = new Array(n);
  let templatedCursor = 0;
  for (let i = 0; i < n; i++) {
    if (kinds[i] === KIND_RAW_STRING) {
      out[i] = rawStringByRecord.get(i) ?? "";
    } else if (kinds[i] === KIND_TEMPLATED) {
      out[i] = templatedBodies[templatedCursor++] as string;
    } else {
      out[i] = otherBodies?.get(i) ?? "";
    }
  }
  return out;
}

function reconstruct(template: readonly string[], vars: readonly string[]): string {
  // Hot-path: inline string concat with a single-pass loop. The
  // earlier version built `string[]` and called `join(" ")`, which
  // allocates an intermediate array per record (CPU profile
  // measurement showed reconstruct at ~20% of decode self-time on
  // OpenStack 500K-record stores).
  //
  // V8 can optimize repeated `+=` better than `out.push(...)`+`join`
  // for small token counts (typical templated-text bodies have 5–15
  // tokens). Manual benching shows ~2× speedup on this shape.
  let out = "";
  let varCursor = 0;
  const len = template.length;
  for (let i = 0; i < len; i++) {
    if (i > 0) out += " ";
    const t = template[i] as string;
    if (t === PARAM_STR) {
      out += vars[varCursor++] ?? "";
    } else {
      out += t;
    }
  }
  return out;
}

// ── Public policy ────────────────────────────────────────────────────

export class TypedColumnarDrainPolicy implements ChunkPolicy {
  readonly drain: Drain;
  private readonly bodyCodecName: string;

  constructor(config: TypedColumnarDrainPolicyConfig = {}) {
    this.drain = config.drain ?? new Drain();
    this.bodyCodecName = config.bodyCodec ?? "zstd-19";
  }

  bodyCodec(): string {
    return this.bodyCodecName;
  }

  encodePayload(records: readonly LogRecord[]): {
    payload: Uint8Array;
    meta: TypedColumnarChunkMeta;
  } {
    return encode(records, this.drain);
  }

  decodePayload(buf: Uint8Array, nLogs: number, meta: unknown): LogRecord[] {
    return decode(buf, nLogs, meta as TypedColumnarChunkMeta);
  }

  decodeBodiesOnly(buf: Uint8Array, nLogs: number, _meta: unknown): AnyValue[] {
    return decodeBodies(buf, nLogs);
  }
}
