/**
 * Binary encoding/decoding for OTLP AnyValue types.
 * Tag-based serialization using ByteBuf/ByteReader, with optional
 * dictionary-aware string encoding for high-frequency values.
 */

import { ByteBuf, ByteReader } from "./binary.js";
import type { AnyValue } from "./types.js";

export { ByteBuf, ByteReader };

export enum ValueTag {
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

/**
 * Encode an AnyValue into a ByteBuf using tag-based binary serialization.
 * When `valIndex` is provided, matching strings are encoded as dictionary references.
 */
export function encodeAnyValue(buf: ByteBuf, value: AnyValue, valIndex: Map<string, number>): void {
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
    buf.writeZigzagVarint(value);
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

/**
 * Decode an AnyValue from a ByteReader.
 * When `valDict` is provided, STRING_DICT tags are resolved from it.
 */
export function decodeAnyValue(reader: ByteReader, valDict: string[]): AnyValue {
  const tag = reader.readU8();
  switch (tag) {
    case ValueTag.NULL:
      return null;
    case ValueTag.STRING_DICT:
      return valDict[reader.readU16()] ?? "";
    case ValueTag.STRING_RAW:
      return reader.readString();
    case ValueTag.INT:
      return reader.readZigzagVarint();
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
      throw new Error(`stardb: unknown AnyValue tag ${tag}`);
  }
}
