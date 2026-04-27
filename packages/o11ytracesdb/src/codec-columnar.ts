/**
 * Columnar codec for o11ytracesdb — encodes spans into a compact binary
 * columnar layout optimized for trace data characteristics.
 *
 * Layout (per chunk payload):
 *   Section 0: Timestamps (delta-of-delta + zigzag-varint)
 *   Section 1: Durations (zigzag-varint)
 *   Section 2: IDs (raw bytes: trace_id ×16, span_id ×8, parent_span_id ×8 + null bitmap)
 *   Section 3: Span names (per-chunk dictionary + u16 indices)
 *   Section 4: Kind (u8 per span)
 *   Section 5: Status (u8 code + optional message dict)
 *   Section 6: Attributes (key dict + per-span encoded attribute columns)
 *   Section 7: Events (count-prefixed sub-chunks)
 *   Section 8: Links (count-prefixed sub-chunks)
 *
 * Sections are length-prefixed so the decoder can seek to any section
 * for partial decode (e.g. decode only IDs for trace assembly).
 *
 * Compression strategy per column type:
 * - Timestamps: delta-of-delta (spans within a chunk arrive ~monotonically)
 * - Durations: zigzag-varint (cluster by operation → small deltas when sorted)
 * - IDs: raw bytes (incompressible random data; BF8 filter in header for lookup)
 * - Names: dictionary → u16 index (typically 10-100 distinct per chunk)
 * - Kind/Status: raw u8 (5 and 3 possible values respectively)
 * - Attributes: key dictionary + typed value columns
 */

import type { ChunkPolicy } from "./chunk.js";
import type { AnyValue, KeyValue, SpanEvent, SpanLink, SpanRecord, StatusCode } from "./types.js";

// ─── ByteBuf — growable write buffer ─────────────────────────────────

class ByteBuf {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  /** Ensure capacity for `needed` more bytes. */
  ensure(needed: number): void {
    if (this.pos + needed <= this.buf.length) return;
    let newCap = this.buf.length * 2;
    while (newCap < this.pos + needed) newCap *= 2;
    const next = new Uint8Array(newCap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeFloat64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  writeU8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v;
  }

  writeU16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  writeU32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  writeVarint(value: bigint): void {
    // ZigZag encode then unsigned varint
    const zigzag = value < 0n ? ((-value) * 2n - 1n) : (value * 2n);
    let v = zigzag;
    do {
      this.ensure(1);
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) byte |= 0x80;
      this.buf[this.pos++] = byte;
    } while (v > 0n);
  }

  writeUvarint(value: number): void {
    let v = value >>> 0;
    do {
      this.ensure(1);
      let byte = v & 0x7f;
      v >>>= 7;
      if (v > 0) byte |= 0x80;
      this.buf[this.pos++] = byte;
    } while (v > 0);
  }

  writeBytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
  }

  writeString(s: string): void {
    const encoded = new TextEncoder().encode(s);
    this.writeUvarint(encoded.length);
    this.writeBytes(encoded);
  }

  /** Write a section: u32 length prefix + content. Returns byte array of content. */
  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

// ─── ByteReader — sequential reader ──────────────────────────────────

class ByteReader {
  private view: DataView;
  pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  readU8(): number {
    return this.buf[this.pos++]!;
  }

  readU16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    let byte: number;
    do {
      byte = this.buf[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    // ZigZag decode
    return (result >> 1n) ^ -(result & 1n);
  }

  readUvarint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.buf[this.pos++]!;
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readString(): string {
    const len = this.readUvarint();
    const bytes = this.readBytes(len);
    return new TextDecoder().decode(bytes);
  }

  readSection(): Uint8Array {
    const len = this.readU32();
    return this.readBytes(len);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }
}

// ─── Columnar Codec Implementation ──────────────────────────────────

interface ColumnarMeta {
  /** String dictionary for span names. */
  nameDict: string[];
  /** String dictionary for attribute keys. */
  keyDict: string[];
  /** String dictionary for attribute string values (low-cardinality). */
  valDict: string[];
  /** String dictionary for status messages. */
  msgDict: string[];
}

export class ColumnarTracePolicy implements ChunkPolicy {
  codecName(): string {
    return "columnar-v1";
  }

  encodePayload(spans: readonly SpanRecord[]): { payload: Uint8Array; meta?: unknown } {
    const n = spans.length;
    const out = new ByteBuf(n * 60); // estimate ~60 B/span

    // Build dictionaries
    const nameDict = buildDict(spans.map((s) => s.name));
    const keyDict = buildDict(spans.flatMap((s) => s.attributes.map((a) => a.key)));
    const valDict = buildDict(
      spans
        .flatMap((s) => s.attributes.filter((a) => typeof a.value === "string").map((a) => a.value as string))
        .filter((v) => v.length < 256), // only dict-encode short strings
    );
    const msgDict = buildDict(
      spans.map((s) => s.statusMessage).filter((m): m is string => m !== undefined),
    );

    // Section 0: Timestamps (delta-of-delta startTime + delta-of-delta endTime)
    const tsSection = new ByteBuf(n * 4);
    {
      let prevStart = 0n;
      let prevStartDelta = 0n;
      let prevEnd = 0n;
      let prevEndDelta = 0n;
      for (const s of spans) {
        const startDelta = s.startTimeUnixNano - prevStart;
        const startDoD = startDelta - prevStartDelta;
        tsSection.writeVarint(startDoD);
        prevStartDelta = startDelta;
        prevStart = s.startTimeUnixNano;

        const endDelta = s.endTimeUnixNano - prevEnd;
        const endDoD = endDelta - prevEndDelta;
        tsSection.writeVarint(endDoD);
        prevEndDelta = endDelta;
        prevEnd = s.endTimeUnixNano;
      }
    }
    const tsBytes = tsSection.finish();
    out.writeU32(tsBytes.length);
    out.writeBytes(tsBytes);

    // Section 1: Durations (zigzag-varint)
    const durSection = new ByteBuf(n * 3);
    for (const s of spans) {
      durSection.writeVarint(s.durationNanos);
    }
    const durBytes = durSection.finish();
    out.writeU32(durBytes.length);
    out.writeBytes(durBytes);

    // Section 2: IDs (raw: traceId×16, spanId×8, parentSpanId×8 + null bitmap)
    const idSection = new ByteBuf(n * 33);
    // Null bitmap for parentSpanId (1 bit per span, packed)
    const nullBitmapLen = Math.ceil(n / 8);
    const nullBitmap = new Uint8Array(nullBitmapLen);
    for (let i = 0; i < n; i++) {
      if (spans[i]!.parentSpanId !== undefined) {
        nullBitmap[i >>> 3]! |= 1 << (i & 7);
      }
    }
    idSection.writeBytes(nullBitmap);
    // trace_ids contiguous
    for (const s of spans) idSection.writeBytes(s.traceId);
    // span_ids contiguous
    for (const s of spans) idSection.writeBytes(s.spanId);
    // parent_span_ids (only for non-null entries)
    for (const s of spans) {
      if (s.parentSpanId !== undefined) {
        idSection.writeBytes(s.parentSpanId);
      }
    }
    const idBytes = idSection.finish();
    out.writeU32(idBytes.length);
    out.writeBytes(idBytes);

    // Section 3: Span names (dictionary indices as u16)
    const nameSection = new ByteBuf(n * 2 + 256);
    nameSection.writeUvarint(nameDict.length);
    for (const name of nameDict) nameSection.writeString(name);
    for (const s of spans) {
      nameSection.writeU16(nameDict.indexOf(s.name));
    }
    const nameBytes = nameSection.finish();
    out.writeU32(nameBytes.length);
    out.writeBytes(nameBytes);

    // Section 4: Kind (u8 per span)
    const kindSection = new ByteBuf(n);
    for (const s of spans) kindSection.writeU8(s.kind);
    const kindBytes = kindSection.finish();
    out.writeU32(kindBytes.length);
    out.writeBytes(kindBytes);

    // Section 5: Status (u8 code + optional message via dict index)
    const statusSection = new ByteBuf(n * 2 + 128);
    statusSection.writeUvarint(msgDict.length);
    for (const msg of msgDict) statusSection.writeString(msg);
    for (const s of spans) {
      statusSection.writeU8(s.statusCode);
      if (s.statusMessage !== undefined) {
        const idx = msgDict.indexOf(s.statusMessage);
        statusSection.writeU16(idx === -1 ? 0xffff : idx);
      } else {
        statusSection.writeU16(0xffff); // sentinel for no message
      }
    }
    const statusBytes = statusSection.finish();
    out.writeU32(statusBytes.length);
    out.writeBytes(statusBytes);

    // Section 6: Attributes (key dict + per-span attribute data)
    const attrSection = new ByteBuf(n * 20);
    attrSection.writeUvarint(keyDict.length);
    for (const key of keyDict) attrSection.writeString(key);
    attrSection.writeUvarint(valDict.length);
    for (const val of valDict) attrSection.writeString(val);
    for (const s of spans) {
      attrSection.writeUvarint(s.attributes.length);
      for (const attr of s.attributes) {
        attrSection.writeU16(keyDict.indexOf(attr.key));
        encodeAnyValue(attrSection, attr.value, valDict);
      }
    }
    const attrBytes = attrSection.finish();
    out.writeU32(attrBytes.length);
    out.writeBytes(attrBytes);

    // Section 7: Events (per-span event count + encoded events)
    const evtSection = new ByteBuf(256);
    for (const s of spans) {
      evtSection.writeUvarint(s.events.length);
      for (const evt of s.events) {
        evtSection.writeVarint(evt.timeUnixNano);
        evtSection.writeString(evt.name);
        evtSection.writeUvarint(evt.attributes.length);
        for (const attr of evt.attributes) {
          evtSection.writeString(attr.key);
          encodeAnyValue(evtSection, attr.value, valDict);
        }
      }
    }
    const evtBytes = evtSection.finish();
    out.writeU32(evtBytes.length);
    out.writeBytes(evtBytes);

    // Section 8: Links (per-span link count + encoded links)
    const linkSection = new ByteBuf(64);
    for (const s of spans) {
      linkSection.writeUvarint(s.links.length);
      for (const link of s.links) {
        linkSection.writeBytes(link.traceId);
        linkSection.writeBytes(link.spanId);
        linkSection.writeUvarint(link.attributes.length);
        for (const attr of link.attributes) {
          linkSection.writeString(attr.key);
          encodeAnyValue(linkSection, attr.value, valDict);
        }
      }
    }
    const linkBytes = linkSection.finish();
    out.writeU32(linkBytes.length);
    out.writeBytes(linkBytes);

    const meta: ColumnarMeta = { nameDict, keyDict, valDict, msgDict };
    return { payload: out.finish(), meta };
  }

  decodePayload(buf: Uint8Array, nSpans: number, meta: unknown): SpanRecord[] {
    const { nameDict, keyDict, valDict, msgDict } = meta as ColumnarMeta;
    const reader = new ByteReader(buf);
    const n = nSpans;
    const spans: SpanRecord[] = new Array(n);

    // Section 0: Timestamps
    const tsSection = new ByteReader(reader.readSection());
    const startTimes = new Array<bigint>(n);
    const endTimes = new Array<bigint>(n);
    {
      let prevStart = 0n;
      let prevStartDelta = 0n;
      let prevEnd = 0n;
      let prevEndDelta = 0n;
      for (let i = 0; i < n; i++) {
        const startDoD = tsSection.readVarint();
        const startDelta = prevStartDelta + startDoD;
        startTimes[i] = prevStart + startDelta;
        prevStartDelta = startDelta;
        prevStart = startTimes[i]!;

        const endDoD = tsSection.readVarint();
        const endDelta = prevEndDelta + endDoD;
        endTimes[i] = prevEnd + endDelta;
        prevEndDelta = endDelta;
        prevEnd = endTimes[i]!;
      }
    }

    // Section 1: Durations
    const durSection = new ByteReader(reader.readSection());
    const durations = new Array<bigint>(n);
    for (let i = 0; i < n; i++) {
      durations[i] = durSection.readVarint();
    }

    // Section 2: IDs
    const idSection = new ByteReader(reader.readSection());
    const nullBitmapLen = Math.ceil(n / 8);
    const nullBitmap = idSection.readBytes(nullBitmapLen);
    const traceIds: Uint8Array[] = new Array(n);
    const spanIds: Uint8Array[] = new Array(n);
    const parentSpanIds: (Uint8Array | undefined)[] = new Array(n);
    for (let i = 0; i < n; i++) traceIds[i] = new Uint8Array(idSection.readBytes(16));
    for (let i = 0; i < n; i++) spanIds[i] = new Uint8Array(idSection.readBytes(8));
    for (let i = 0; i < n; i++) {
      if (nullBitmap[i >>> 3]! & (1 << (i & 7))) {
        parentSpanIds[i] = new Uint8Array(idSection.readBytes(8));
      }
    }

    // Section 3: Names
    const nameSection = new ByteReader(reader.readSection());
    const dictLen = nameSection.readUvarint();
    const localNameDict: string[] = new Array(dictLen);
    for (let i = 0; i < dictLen; i++) localNameDict[i] = nameSection.readString();
    const names: string[] = new Array(n);
    for (let i = 0; i < n; i++) names[i] = localNameDict[nameSection.readU16()]!;

    // Section 4: Kind
    const kindSection = new ByteReader(reader.readSection());
    const kinds: number[] = new Array(n);
    for (let i = 0; i < n; i++) kinds[i] = kindSection.readU8();

    // Section 5: Status
    const statusSection = new ByteReader(reader.readSection());
    const localMsgDictLen = statusSection.readUvarint();
    const localMsgDict: string[] = new Array(localMsgDictLen);
    for (let i = 0; i < localMsgDictLen; i++) localMsgDict[i] = statusSection.readString();
    const statusCodes: number[] = new Array(n);
    const statusMessages: (string | undefined)[] = new Array(n);
    for (let i = 0; i < n; i++) {
      statusCodes[i] = statusSection.readU8();
      const msgIdx = statusSection.readU16();
      statusMessages[i] = msgIdx === 0xffff ? undefined : localMsgDict[msgIdx];
    }

    // Section 6: Attributes
    const attrSection = new ByteReader(reader.readSection());
    const localKeyDictLen = attrSection.readUvarint();
    const localKeyDict: string[] = new Array(localKeyDictLen);
    for (let i = 0; i < localKeyDictLen; i++) localKeyDict[i] = attrSection.readString();
    const localValDictLen = attrSection.readUvarint();
    const localValDict: string[] = new Array(localValDictLen);
    for (let i = 0; i < localValDictLen; i++) localValDict[i] = attrSection.readString();
    const allAttrs: KeyValue[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const attrCount = attrSection.readUvarint();
      const attrs: KeyValue[] = new Array(attrCount);
      for (let j = 0; j < attrCount; j++) {
        const keyIdx = attrSection.readU16();
        const value = decodeAnyValue(attrSection, localValDict);
        attrs[j] = { key: localKeyDict[keyIdx]!, value };
      }
      allAttrs[i] = attrs;
    }

    // Section 7: Events
    const evtSection = new ByteReader(reader.readSection());
    const allEvents: SpanEvent[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const evtCount = evtSection.readUvarint();
      const events: SpanEvent[] = new Array(evtCount);
      for (let j = 0; j < evtCount; j++) {
        const timeUnixNano = evtSection.readVarint();
        const name = evtSection.readString();
        const attrCount = evtSection.readUvarint();
        const attributes: KeyValue[] = new Array(attrCount);
        for (let k = 0; k < attrCount; k++) {
          const key = evtSection.readString();
          const value = decodeAnyValue(evtSection, localValDict);
          attributes[k] = { key, value };
        }
        events[j] = { timeUnixNano, name, attributes };
      }
      allEvents[i] = events;
    }

    // Section 8: Links
    const linkSection = new ByteReader(reader.readSection());
    const allLinks: SpanLink[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const linkCount = linkSection.readUvarint();
      const links: SpanLink[] = new Array(linkCount);
      for (let j = 0; j < linkCount; j++) {
        const traceId = new Uint8Array(linkSection.readBytes(16));
        const spanId = new Uint8Array(linkSection.readBytes(8));
        const attrCount = linkSection.readUvarint();
        const attributes: KeyValue[] = new Array(attrCount);
        for (let k = 0; k < attrCount; k++) {
          const key = linkSection.readString();
          const value = decodeAnyValue(linkSection, localValDict);
          attributes[k] = { key, value };
        }
        links[j] = { traceId, spanId, attributes };
      }
      allLinks[i] = links;
    }

    // Assemble SpanRecords
    for (let i = 0; i < n; i++) {
      const parentId = parentSpanIds[i];
      const statusMsg = statusMessages[i];
      spans[i] = {
        traceId: traceIds[i]!,
        spanId: spanIds[i]!,
        ...(parentId !== undefined ? { parentSpanId: parentId } : {}),
        name: names[i]!,
        kind: kinds[i]! as SpanRecord["kind"],
        startTimeUnixNano: startTimes[i]!,
        endTimeUnixNano: endTimes[i]!,
        durationNanos: durations[i]!,
        statusCode: statusCodes[i]! as StatusCode,
        ...(statusMsg !== undefined ? { statusMessage: statusMsg } : {}),
        attributes: allAttrs[i]!,
        events: allEvents[i]!,
        links: allLinks[i]!,
      };
    }

    return spans;
  }
}

// ─── AnyValue encoding ───────────────────────────────────────────────

const enum ValueTag {
  NULL = 0,
  STRING_DICT = 1, // index into value dictionary
  STRING_RAW = 2,  // inline length-prefixed string
  INT = 3,
  DOUBLE = 4,
  BOOL_TRUE = 5,
  BOOL_FALSE = 6,
  BYTES = 7,
  ARRAY = 8,
  MAP = 9,
}

function encodeAnyValue(buf: ByteBuf, value: AnyValue, valDict: string[]): void {
  if (value === null) {
    buf.writeU8(ValueTag.NULL);
  } else if (typeof value === "string") {
    const dictIdx = valDict.indexOf(value);
    if (dictIdx !== -1) {
      buf.writeU8(ValueTag.STRING_DICT);
      buf.writeU16(dictIdx);
    } else {
      buf.writeU8(ValueTag.STRING_RAW);
      buf.writeString(value);
    }
  } else if (typeof value === "bigint") {
    buf.writeU8(ValueTag.INT);
    buf.writeVarint(value);
  } else if (typeof value === "number") {
    buf.writeU8(ValueTag.DOUBLE);
    buf.writeFloat64(value);
  } else if (typeof value === "boolean") {
    buf.writeU8(value ? ValueTag.BOOL_TRUE : ValueTag.BOOL_FALSE);
  } else if (value instanceof Uint8Array) {
    buf.writeU8(ValueTag.BYTES);
    buf.writeUvarint(value.length);
    buf.writeBytes(value);
  } else if (Array.isArray(value)) {
    buf.writeU8(ValueTag.ARRAY);
    buf.writeUvarint(value.length);
    for (const item of value) encodeAnyValue(buf, item, valDict);
  } else {
    buf.writeU8(ValueTag.MAP);
    const entries = Object.entries(value);
    buf.writeUvarint(entries.length);
    for (const [k, v] of entries) {
      buf.writeString(k);
      encodeAnyValue(buf, v as AnyValue, valDict);
    }
  }
}

function decodeAnyValue(reader: ByteReader, valDict: string[]): AnyValue {
  const tag = reader.readU8();
  switch (tag) {
    case ValueTag.NULL:
      return null;
    case ValueTag.STRING_DICT:
      return valDict[reader.readU16()]!;
    case ValueTag.STRING_RAW:
      return reader.readString();
    case ValueTag.INT:
      return reader.readVarint();
    case ValueTag.DOUBLE: {
      const view = new DataView(reader["buf"].buffer, reader["buf"].byteOffset, reader["buf"].byteLength);
      const v = view.getFloat64(reader.pos, true);
      reader.pos += 8;
      return v;
    }
    case ValueTag.BOOL_TRUE:
      return true;
    case ValueTag.BOOL_FALSE:
      return false;
    case ValueTag.BYTES: {
      const len = reader.readUvarint();
      return new Uint8Array(reader.readBytes(len));
    }
    case ValueTag.ARRAY: {
      const len = reader.readUvarint();
      const arr: AnyValue[] = new Array(len);
      for (let i = 0; i < len; i++) arr[i] = decodeAnyValue(reader, valDict);
      return arr;
    }
    case ValueTag.MAP: {
      const len = reader.readUvarint();
      const obj: { [key: string]: AnyValue } = {};
      for (let i = 0; i < len; i++) {
        const key = reader.readString();
        obj[key] = decodeAnyValue(reader, valDict);
      }
      return obj;
    }
    default:
      throw new Error(`o11ytracesdb: unknown value tag ${tag}`);
  }
}

// ─── Dictionary builder ──────────────────────────────────────────────

function buildDict(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Include all distinct values, sorted by frequency (most frequent first)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value);
}
