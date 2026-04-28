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
 *   Section 10: Optional fields (traceState, dropped counts per span/event/link)
 *
 * Sections are length-prefixed so the decoder can seek to any section
 * for partial decode (e.g. decode only IDs for trace assembly).
 */

import { ByteBuf, ByteReader, buildDictWithIndex, decodeAnyValue, encodeAnyValue } from "stardb";
import type { ChunkPolicy } from "./chunk.js";
import type { AnyValue, KeyValue, SpanEvent, SpanLink, SpanRecord, StatusCode } from "./types.js";

// ─── Dictionary builder ──────────────────────────────────────────────

interface DictWithIndex {
  dict: string[];
  index: Map<string, number>;
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

/** Default columnar codec for trace span storage. */
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

    // Validate dictionary sizes fit in U16 indices
    const MAX_DICT = 0xfffe; // 0xffff reserved as sentinel
    if (names.dict.length > MAX_DICT) {
      throw new RangeError(
        `Span name dictionary overflow: ${names.dict.length} entries (max ${MAX_DICT})`
      );
    }
    if (keys.dict.length > MAX_DICT) {
      throw new RangeError(
        `Attribute key dictionary overflow: ${keys.dict.length} entries (max ${MAX_DICT})`
      );
    }
    if (vals.dict.length > MAX_DICT) {
      throw new RangeError(
        `Attribute value dictionary overflow: ${vals.dict.length} entries (max ${MAX_DICT})`
      );
    }
    if (msgs.dict.length > MAX_DICT) {
      throw new RangeError(
        `Status message dictionary overflow: ${msgs.dict.length} entries (max ${MAX_DICT})`
      );
    }

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
        out.writeZigzagVarint(startDoD);
        prevStartDelta = startDelta;
        prevStart = s.startTimeUnixNano;

        const endDelta = s.endTimeUnixNano - prevEnd;
        const endDoD = endDelta - prevEndDelta;
        out.writeZigzagVarint(endDoD);
        prevEndDelta = endDelta;
        prevEnd = s.endTimeUnixNano;
      }
      out.patchSectionLength(off);
    }

    // Section 1: Durations (zigzag-varint)
    {
      const off = out.reserveSectionLength();
      for (const s of spans) out.writeZigzagVarint(s.durationNanos);
      out.patchSectionLength(off);
    }

    // Section 2: IDs (null bitmap + traceId×16 + spanId×8 + parentSpanId×8)
    {
      const off = out.reserveSectionLength();
      const nullBitmapLen = Math.ceil(n / 8);
      const nullBitmap = new Uint8Array(nullBitmapLen);
      for (let i = 0; i < n; i++) {
        const s = spans[i];
        if (!s) continue;
        if (s.traceId.length !== 16) {
          throw new RangeError(
            `o11ytracesdb: span[${i}] traceId must be 16 bytes, got ${s.traceId.length}`
          );
        }
        if (s.spanId.length !== 8) {
          throw new RangeError(
            `o11ytracesdb: span[${i}] spanId must be 8 bytes, got ${s.spanId.length}`
          );
        }
        if (s.parentSpanId !== undefined && s.parentSpanId.length !== 8) {
          throw new RangeError(
            `o11ytracesdb: span[${i}] parentSpanId must be 8 bytes, got ${s.parentSpanId.length}`
          );
        }
        if (s.parentSpanId !== undefined) {
          const byteIdx = i >>> 3;
          nullBitmap[byteIdx] = (nullBitmap[byteIdx] ?? 0) | (1 << (i & 7));
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
      for (const s of spans) {
        const nameIdx = names.index.get(s.name);
        if (nameIdx === undefined)
          throw new RangeError(`o11ytracesdb: unknown span name "${s.name}"`);
        out.writeU16(nameIdx);
      }
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
          const keyIdx = keys.index.get(attr.key);
          if (keyIdx === undefined)
            throw new RangeError(`o11ytracesdb: unknown attribute key "${attr.key}"`);
          out.writeU16(keyIdx);
          encodeAnyValue(out, attr.value, vals.index);
        }
      }
      out.patchSectionLength(off);
    }

    // Section 7: Events (per-span event count + encoded events with delta timestamps)
    {
      const off = out.reserveSectionLength();
      for (let idx = 0; idx < n; idx++) {
        const s = spans[idx];
        if (!s) continue;
        out.writeUvarint(s.events.length);
        for (const evt of s.events) {
          // Store as delta from span start for better compression
          const timeDelta = evt.timeUnixNano - s.startTimeUnixNano;
          out.writeZigzagVarint(timeDelta);
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
          if (link.traceId.length !== 16) {
            throw new RangeError(
              `o11ytracesdb: link traceId must be 16 bytes, got ${link.traceId.length}`
            );
          }
          if (link.spanId.length !== 8) {
            throw new RangeError(
              `o11ytracesdb: link spanId must be 8 bytes, got ${link.spanId.length}`
            );
          }
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
        out.writeZigzagVarint(BigInt(left - prevLeft));
        out.writeZigzagVarint(BigInt(right - prevRight));
        out.writeZigzagVarint(BigInt(parent - prevParent));
        prevLeft = left;
        prevRight = right;
        prevParent = parent;
      }
      out.patchSectionLength(off);
    }

    // Section 10: Optional per-span fields (traceState, dropped counts)
    {
      const off = out.reserveSectionLength();
      for (const s of spans) {
        out.writeString(s.traceState ?? "");
        out.writeUvarint(s.droppedAttributesCount ?? 0);
        out.writeUvarint(s.droppedEventsCount ?? 0);
        out.writeUvarint(s.droppedLinksCount ?? 0);
      }
      // Per-event dropped attributes count
      for (const s of spans) {
        for (const evt of s.events) {
          out.writeUvarint(evt.droppedAttributesCount ?? 0);
        }
      }
      // Per-link optional fields
      for (const s of spans) {
        for (const link of s.links) {
          out.writeString(link.traceState ?? "");
          out.writeUvarint(link.droppedAttributesCount ?? 0);
        }
      }
      out.patchSectionLength(off);
    }

    return { payload: out.finish(), meta: {} };
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
        const startDoD = tsSection.readZigzagVarint();
        const startDelta = prevStartDelta + startDoD;
        const st = prevStart + startDelta;
        startTimes[i] = st;
        prevStartDelta = startDelta;
        prevStart = st;

        const endDoD = tsSection.readZigzagVarint();
        const endDelta = prevEndDelta + endDoD;
        const et = prevEnd + endDelta;
        endTimes[i] = et;
        prevEndDelta = endDelta;
        prevEnd = et;
      }
    }

    // Section 1: Durations
    const durSection = new ByteReader(reader.readSection());
    const durations = new Array<bigint>(n);
    for (let i = 0; i < n; i++) {
      durations[i] = durSection.readZigzagVarint();
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
      const bitmapByte = nullBitmap[i >>> 3];
      if (bitmapByte !== undefined && bitmapByte & (1 << (i & 7))) {
        parentSpanIds[i] = idSection.readBytes(8).slice();
      }
    }

    // Section 3: Names (uses header-level nameDict for decode)
    const nameSection = new ByteReader(reader.readSection());
    const dictLen = nameSection.readUvarint();
    const localNameDict: string[] = new Array(dictLen);
    for (let i = 0; i < dictLen; i++) localNameDict[i] = nameSection.readString();
    const nameIndices: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const nameIdx = nameSection.readU16();
      nameIndices[i] = localNameDict[nameIdx] ?? "";
    }

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
        attrs[j] = { key: localKeyDict[keyIdx] ?? "", value };
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
        const timeDelta = evtSection.readZigzagVarint();
        const timeUnixNano = (startTimes[i] ?? 0n) + timeDelta;
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
        prevLeft += Number(nestedSetSection.readZigzagVarint());
        prevRight += Number(nestedSetSection.readZigzagVarint());
        prevParent += Number(nestedSetSection.readZigzagVarint());
        nestedSetLefts[i] = prevLeft;
        nestedSetRights[i] = prevRight;
        nestedSetParents[i] = prevParent;
      }
    }

    // Section 10: Optional per-span fields (backward compatible)
    const optTraceStates: (string | undefined)[] = new Array(n);
    const optDroppedAttrCounts: (number | undefined)[] = new Array(n);
    const optDroppedEvtCounts: (number | undefined)[] = new Array(n);
    const optDroppedLinkCounts: (number | undefined)[] = new Array(n);
    if (reader.remaining > 0) {
      try {
        const optSection = new ByteReader(reader.readSection());
        for (let i = 0; i < n; i++) {
          const ts = optSection.readString();
          if (ts.length > 0) optTraceStates[i] = ts;
          const dac = optSection.readUvarint();
          if (dac > 0) optDroppedAttrCounts[i] = dac;
          const dec = optSection.readUvarint();
          if (dec > 0) optDroppedEvtCounts[i] = dec;
          const dlc = optSection.readUvarint();
          if (dlc > 0) optDroppedLinkCounts[i] = dlc;
        }
        // Per-event dropped attributes
        for (let i = 0; i < n; i++) {
          const events = allEvents[i];
          if (!events) continue;
          for (let j = 0; j < events.length; j++) {
            const edac = optSection.readUvarint();
            const evt = events[j];
            if (evt && edac > 0) evt.droppedAttributesCount = edac;
          }
        }
        // Per-link optional fields
        for (let i = 0; i < n; i++) {
          const links = allLinks[i];
          if (!links) continue;
          for (let j = 0; j < links.length; j++) {
            const lts = optSection.readString();
            const lnk = links[j];
            if (lnk) {
              if (lts.length > 0) lnk.traceState = lts;
              const ldac = optSection.readUvarint();
              if (ldac > 0) lnk.droppedAttributesCount = ldac;
            }
          }
        }
      } catch {
        // Section 10 not present in older data — all optional fields remain undefined
      }
    }

    // Assemble SpanRecords
    for (let i = 0; i < n; i++) {
      const parentId = parentSpanIds[i];
      const statusMsg = statusMessages[i];
      const nsLeft = nestedSetLefts[i] ?? 0;
      const nsRight = nestedSetRights[i] ?? 0;
      const nsParent = nestedSetParents[i] ?? 0;
      const traceState = optTraceStates[i];
      const dac = optDroppedAttrCounts[i];
      const dec = optDroppedEvtCounts[i];
      const dlc = optDroppedLinkCounts[i];
      const tId = traceIds[i];
      const sId = spanIds[i];
      const name = nameIndices[i];
      const kind = kinds[i];
      const st = startTimes[i];
      const et = endTimes[i];
      const dur = durations[i];
      const sc = statusCodes[i];
      const attrs = allAttrs[i];
      const evts = allEvents[i];
      const lnks = allLinks[i];
      if (
        !tId ||
        !sId ||
        name === undefined ||
        kind === undefined ||
        st === undefined ||
        et === undefined ||
        dur === undefined ||
        sc === undefined ||
        !attrs ||
        !evts ||
        !lnks
      ) {
        throw new RangeError(`o11ytracesdb: incomplete span data at index ${i}`);
      }
      spans[i] = {
        traceId: tId,
        spanId: sId,
        ...(parentId !== undefined ? { parentSpanId: parentId } : {}),
        ...(traceState !== undefined ? { traceState } : {}),
        name,
        kind: kind as SpanRecord["kind"],
        startTimeUnixNano: st,
        endTimeUnixNano: et,
        durationNanos: dur,
        statusCode: sc as StatusCode,
        ...(statusMsg !== undefined ? { statusMessage: statusMsg } : {}),
        attributes: attrs,
        ...(dac !== undefined ? { droppedAttributesCount: dac } : {}),
        events: evts,
        ...(dec !== undefined ? { droppedEventsCount: dec } : {}),
        links: lnks,
        ...(dlc !== undefined ? { droppedLinksCount: dlc } : {}),
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
      const bitmapByte = nullBitmap[i >>> 3];
      if (bitmapByte !== undefined && bitmapByte & (1 << (i & 7))) {
        parentSpanIds[i] = new Uint8Array(idSection.readBytes(8));
      }
    }

    return { traceIds, spanIds, parentSpanIds };
  }
}

// AnyValue encoding imported from stardb (encodeAnyValue, decodeAnyValue)
