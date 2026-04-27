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
 *   Section 9: Nested sets (delta-encoded i32: left, right, parent per span)
 *
 * Sections are length-prefixed so the decoder can seek to any section
 * for partial decode (e.g. decode only IDs for trace assembly).
 */

import type { ChunkPolicy } from "./chunk.js";
import type { AnyValue, KeyValue, SpanEvent, SpanLink, SpanRecord, StatusCode } from "./types.js";

// ─── Shared text codec singletons (avoid per-call allocation) ────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ─── ByteBuf — growable write buffer ─────────────────────────────────

export class ByteBuf {
  buf: Uint8Array;
  view: DataView;
  pos = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  ensure(needed: number): void {
    if (this.pos + needed <= this.buf.length) return;
    let newCap = this.buf.length * 2;
    while (newCap < this.pos + needed) newCap *= 2;
    const next = new Uint8Array(newCap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
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

  writeFloat64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  writeVarint(value: bigint): void {
    // ZigZag encode then unsigned varint
    const zigzag = value < 0n ? -value * 2n - 1n : value * 2n;
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
    const encoded = textEncoder.encode(s);
    this.writeUvarint(encoded.length);
    this.writeBytes(encoded);
  }

  /** Reserve space for a u32 section length, return the offset to backpatch. */
  reserveSectionLength(): number {
    const offset = this.pos;
    this.writeU32(0); // placeholder
    return offset;
  }

  /** Backpatch a section length at the given offset. */
  patchSectionLength(offset: number): void {
    const len = this.pos - offset - 4;
    this.view.setUint32(offset, len, true);
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

// ─── ByteReader — sequential reader ──────────────────────────────────

export class ByteReader {
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

  readFloat64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
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
    return textDecoder.decode(bytes);
  }

  /** Read a length-prefixed section, return a sub-reader over it. */
  readSection(): Uint8Array {
    const len = this.readU32();
    return this.readBytes(len);
  }
}

// ─── Dictionary builder ──────────────────────────────────────────────

interface DictWithIndex {
  dict: string[];
  index: Map<string, number>;
}

function buildDictWithIndex(values: Iterable<string>): DictWithIndex {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const dict = [...counts.entries()]
    .sort((a, b) => b[1] - a[1]) // most frequent first
    .map(([value]) => value);
  const index = new Map<string, number>();
  for (let i = 0; i < dict.length; i++) index.set(dict[i]!, i);
  return { dict, index };
}

// Collect attribute keys/values without intermediate array allocations
function collectAttrKeys(spans: readonly SpanRecord[]): Iterable<string> {
  return {
    *[Symbol.iterator]() {
      for (const s of spans) for (const a of s.attributes) yield a.key;
    },
  };
}

function collectAttrStringVals(spans: readonly SpanRecord[]): Iterable<string> {
  return {
    *[Symbol.iterator]() {
      for (const s of spans)
        for (const a of s.attributes)
          if (typeof a.value === "string" && a.value.length < 256) yield a.value;
    },
  };
}

function collectStatusMsgs(spans: readonly SpanRecord[]): Iterable<string> {
  return {
    *[Symbol.iterator]() {
      for (const s of spans) if (s.statusMessage !== undefined) yield s.statusMessage;
    },
  };
}

// ─── Columnar Codec Implementation ──────────────────────────────────

interface ColumnarMeta {
  nameDict: string[];
  keyDict: string[];
  valDict: string[];
  msgDict: string[];
}

export class ColumnarTracePolicy implements ChunkPolicy {
  codecName(): string {
    return "columnar-v1";
  }

  encodePayload(spans: readonly SpanRecord[]): { payload: Uint8Array; meta?: unknown } {
    const n = spans.length;
    // Single output buffer — sections written inline with length backpatching
    const out = new ByteBuf(n * 60);

    // Build dictionaries with O(1) index maps
    const names = buildDictWithIndex(spans.map((s) => s.name));
    const keys = buildDictWithIndex(collectAttrKeys(spans));
    const vals = buildDictWithIndex(collectAttrStringVals(spans));
    const msgs = buildDictWithIndex(collectStatusMsgs(spans));

    // Section 0: Timestamps (delta-of-delta startTime + delta-of-delta endTime)
    {
      const off = out.reserveSectionLength();
      let prevStart = 0n;
      let prevStartDelta = 0n;
      let prevEnd = 0n;
      let prevEndDelta = 0n;
      for (const s of spans) {
        const startDelta = s.startTimeUnixNano - prevStart;
        const startDoD = startDelta - prevStartDelta;
        out.writeVarint(startDoD);
        prevStartDelta = startDelta;
        prevStart = s.startTimeUnixNano;

        const endDelta = s.endTimeUnixNano - prevEnd;
        const endDoD = endDelta - prevEndDelta;
        out.writeVarint(endDoD);
        prevEndDelta = endDelta;
        prevEnd = s.endTimeUnixNano;
      }
      out.patchSectionLength(off);
    }

    // Section 1: Durations (zigzag-varint)
    {
      const off = out.reserveSectionLength();
      for (const s of spans) out.writeVarint(s.durationNanos);
      out.patchSectionLength(off);
    }

    // Section 2: IDs (null bitmap + traceId×16 + spanId×8 + parentSpanId×8)
    {
      const off = out.reserveSectionLength();
      const nullBitmapLen = Math.ceil(n / 8);
      const nullBitmap = new Uint8Array(nullBitmapLen);
      for (let i = 0; i < n; i++) {
        if (spans[i]!.parentSpanId !== undefined) {
          nullBitmap[i >>> 3]! |= 1 << (i & 7);
        }
      }
      out.writeBytes(nullBitmap);
      for (const s of spans) out.writeBytes(s.traceId);
      for (const s of spans) out.writeBytes(s.spanId);
      for (const s of spans) {
        if (s.parentSpanId !== undefined) out.writeBytes(s.parentSpanId);
      }
      out.patchSectionLength(off);
    }

    // Section 3: Span names (dictionary + u16 indices)
    {
      const off = out.reserveSectionLength();
      out.writeUvarint(names.dict.length);
      for (const name of names.dict) out.writeString(name);
      for (const s of spans) out.writeU16(names.index.get(s.name)!);
      out.patchSectionLength(off);
    }

    // Section 4: Kind (u8 per span)
    {
      const off = out.reserveSectionLength();
      for (const s of spans) out.writeU8(s.kind);
      out.patchSectionLength(off);
    }

    // Section 5: Status (u8 code + optional message via dict index)
    {
      const off = out.reserveSectionLength();
      out.writeUvarint(msgs.dict.length);
      for (const msg of msgs.dict) out.writeString(msg);
      for (const s of spans) {
        out.writeU8(s.statusCode);
        if (s.statusMessage !== undefined) {
          const idx = msgs.index.get(s.statusMessage);
          out.writeU16(idx !== undefined ? idx : 0xffff);
        } else {
          out.writeU16(0xffff);
        }
      }
      out.patchSectionLength(off);
    }

    // Section 6: Attributes (key dict + value dict + per-span data)
    {
      const off = out.reserveSectionLength();
      out.writeUvarint(keys.dict.length);
      for (const key of keys.dict) out.writeString(key);
      out.writeUvarint(vals.dict.length);
      for (const val of vals.dict) out.writeString(val);
      for (const s of spans) {
        out.writeUvarint(s.attributes.length);
        for (const attr of s.attributes) {
          out.writeU16(keys.index.get(attr.key)!);
          encodeAnyValue(out, attr.value, vals.index);
        }
      }
      out.patchSectionLength(off);
    }

    // Section 7: Events (per-span event count + encoded events with delta timestamps)
    {
      const off = out.reserveSectionLength();
      for (let idx = 0; idx < n; idx++) {
        const s = spans[idx]!;
        out.writeUvarint(s.events.length);
        for (const evt of s.events) {
          // Store as delta from span start for better compression
          const timeDelta = evt.timeUnixNano - s.startTimeUnixNano;
          out.writeVarint(timeDelta);
          out.writeString(evt.name);
          out.writeUvarint(evt.attributes.length);
          for (const attr of evt.attributes) {
            out.writeString(attr.key);
            encodeAnyValue(out, attr.value, vals.index);
          }
        }
      }
      out.patchSectionLength(off);
    }

    // Section 8: Links (per-span link count + encoded links)
    {
      const off = out.reserveSectionLength();
      for (const s of spans) {
        out.writeUvarint(s.links.length);
        for (const link of s.links) {
          out.writeBytes(link.traceId);
          out.writeBytes(link.spanId);
          out.writeUvarint(link.attributes.length);
          for (const attr of link.attributes) {
            out.writeString(attr.key);
            encodeAnyValue(out, attr.value, vals.index);
          }
        }
      }
      out.patchSectionLength(off);
    }

    // Section 9: Nested sets (delta-encoded i32: left, right, parent)
    {
      const off = out.reserveSectionLength();
      let prevLeft = 0;
      let prevRight = 0;
      let prevParent = 0;
      for (const s of spans) {
        const left = s.nestedSetLeft ?? 0;
        const right = s.nestedSetRight ?? 0;
        const parent = s.nestedSetParent ?? 0;
        out.writeVarint(BigInt(left - prevLeft));
        out.writeVarint(BigInt(right - prevRight));
        out.writeVarint(BigInt(parent - prevParent));
        prevLeft = left;
        prevRight = right;
        prevParent = parent;
      }
      out.patchSectionLength(off);
    }

    const meta: ColumnarMeta = {
      nameDict: names.dict,
      keyDict: keys.dict,
      valDict: vals.dict,
      msgDict: msgs.dict,
    };
    return { payload: out.finish(), meta };
  }

  decodePayload(buf: Uint8Array, nSpans: number, _meta: unknown): SpanRecord[] {
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

    // Section 2: IDs (zero-copy: use slice() for owned copies without retaining parent buffer)
    const idSection = new ByteReader(reader.readSection());
    const nullBitmapLen = Math.ceil(n / 8);
    const nullBitmap = idSection.readBytes(nullBitmapLen);
    const traceIds: Uint8Array[] = new Array(n);
    const spanIds: Uint8Array[] = new Array(n);
    const parentSpanIds: (Uint8Array | undefined)[] = new Array(n);
    for (let i = 0; i < n; i++) traceIds[i] = idSection.readBytes(16).slice();
    for (let i = 0; i < n; i++) spanIds[i] = idSection.readBytes(8).slice();
    for (let i = 0; i < n; i++) {
      if (nullBitmap[i >>> 3]! & (1 << (i & 7))) {
        parentSpanIds[i] = idSection.readBytes(8).slice();
      }
    }

    // Section 3: Names (uses header-level nameDict for decode)
    const nameSection = new ByteReader(reader.readSection());
    const dictLen = nameSection.readUvarint();
    const localNameDict: string[] = new Array(dictLen);
    for (let i = 0; i < dictLen; i++) localNameDict[i] = nameSection.readString();
    const nameIndices: string[] = new Array(n);
    for (let i = 0; i < n; i++) nameIndices[i] = localNameDict[nameSection.readU16()]!;

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

    // Section 7: Events (decode delta timestamps back to absolute)
    const evtSection = new ByteReader(reader.readSection());
    const allEvents: SpanEvent[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const evtCount = evtSection.readUvarint();
      const events: SpanEvent[] = new Array(evtCount);
      for (let j = 0; j < evtCount; j++) {
        const timeDelta = evtSection.readVarint();
        const timeUnixNano = startTimes[i]! + timeDelta;
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
        const traceId = linkSection.readBytes(16).slice();
        const spanId = linkSection.readBytes(8).slice();
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

    // Section 9: Nested sets (delta-encoded i32)
    const nestedSetSection = new ByteReader(reader.readSection());
    const nestedSetLefts: number[] = new Array(n);
    const nestedSetRights: number[] = new Array(n);
    const nestedSetParents: number[] = new Array(n);
    {
      let prevLeft = 0;
      let prevRight = 0;
      let prevParent = 0;
      for (let i = 0; i < n; i++) {
        prevLeft += Number(nestedSetSection.readVarint());
        prevRight += Number(nestedSetSection.readVarint());
        prevParent += Number(nestedSetSection.readVarint());
        nestedSetLefts[i] = prevLeft;
        nestedSetRights[i] = prevRight;
        nestedSetParents[i] = prevParent;
      }
    }

    // Assemble SpanRecords
    for (let i = 0; i < n; i++) {
      const parentId = parentSpanIds[i];
      const statusMsg = statusMessages[i];
      const nsLeft = nestedSetLefts[i]!;
      const nsRight = nestedSetRights[i]!;
      const nsParent = nestedSetParents[i]!;
      spans[i] = {
        traceId: traceIds[i]!,
        spanId: spanIds[i]!,
        ...(parentId !== undefined ? { parentSpanId: parentId } : {}),
        name: nameIndices[i]!,
        kind: kinds[i]! as SpanRecord["kind"],
        startTimeUnixNano: startTimes[i]!,
        endTimeUnixNano: endTimes[i]!,
        durationNanos: durations[i]!,
        statusCode: statusCodes[i]! as StatusCode,
        ...(statusMsg !== undefined ? { statusMessage: statusMsg } : {}),
        attributes: allAttrs[i]!,
        events: allEvents[i]!,
        links: allLinks[i]!,
        ...(nsLeft !== 0 ? { nestedSetLeft: nsLeft } : {}),
        ...(nsRight !== 0 ? { nestedSetRight: nsRight } : {}),
        ...(nsParent !== 0 ? { nestedSetParent: nsParent } : {}),
      };
    }

    return spans;
  }

  /**
   * Decode only the ID columns (Section 2) — used for trace assembly
   * when we just need trace IDs without full span data.
   * Skips sections 0, 1 and 3-8.
   */
  decodeIdsOnly(
    buf: Uint8Array,
    nSpans: number
  ): {
    traceIds: Uint8Array[];
    spanIds: Uint8Array[];
    parentSpanIds: (Uint8Array | undefined)[];
  } {
    const reader = new ByteReader(buf);
    const n = nSpans;

    // Skip Section 0 (timestamps)
    const sec0Len = reader.readU32();
    reader.pos += sec0Len;

    // Skip Section 1 (durations)
    const sec1Len = reader.readU32();
    reader.pos += sec1Len;

    // Decode Section 2 (IDs)
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

    return { traceIds, spanIds, parentSpanIds };
  }
}

// ─── AnyValue encoding ───────────────────────────────────────────────

enum ValueTag {
  NULL = 0,
  STRING_DICT = 1,
  STRING_RAW = 2,
  INT = 3,
  DOUBLE = 4,
  BOOL_TRUE = 5,
  BOOL_FALSE = 6,
  BYTES = 7,
  ARRAY = 8,
  MAP = 9,
}

function encodeAnyValue(buf: ByteBuf, value: AnyValue, valIndex: Map<string, number>): void {
  if (value === null) {
    buf.writeU8(ValueTag.NULL);
  } else if (typeof value === "string") {
    const dictIdx = valIndex.get(value);
    if (dictIdx !== undefined) {
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
    for (const item of value) encodeAnyValue(buf, item, valIndex);
  } else {
    buf.writeU8(ValueTag.MAP);
    const entries = Object.entries(value);
    buf.writeUvarint(entries.length);
    for (const [k, v] of entries) {
      buf.writeString(k);
      encodeAnyValue(buf, v as AnyValue, valIndex);
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
    case ValueTag.DOUBLE:
      return reader.readFloat64();
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
