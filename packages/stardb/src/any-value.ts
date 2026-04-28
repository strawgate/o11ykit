/**
 * OTLP AnyValue utilities shared across engines.
 *
 * Provides JSON-safe serialization, deep equality, and attribute lookup
 * for the recursive AnyValue type used in resource attributes, span
 * attributes, log bodies, etc.
 */

import type { AnyValue, KeyValue } from "./types.js";
import { bytesEqual, bytesToHex, hexToBytes } from "./utils.js";

/**
 * Serialize an AnyValue to a JSON-safe representation.
 * Handles bigint → {$bi: string}, Uint8Array → {$b: hex}, and nested structures.
 */
export function anyValueToJson(v: AnyValue): unknown {
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

/**
 * Deserialize a JSON-safe representation back to an AnyValue.
 */
export function jsonToAnyValue(j: unknown): AnyValue {
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

/**
 * Deep equality check for AnyValue. Handles all OTLP value types:
 * primitives, Uint8Array (byte comparison), arrays, and nested maps.
 */
export function anyValueEquals(a: AnyValue, b: AnyValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (
    typeof a === "string" ||
    typeof a === "number" ||
    typeof a === "bigint" ||
    typeof a === "boolean"
  ) {
    return a === b;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return bytesEqual(a, b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const aItem = a[i];
      const bItem = b[i];
      if (aItem === undefined || bItem === undefined) return false;
      if (!anyValueEquals(aItem, bItem)) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const aEntries = Object.entries(a as Record<string, AnyValue>);
    const bObj = b as Record<string, AnyValue>;
    if (aEntries.length !== Object.keys(bObj).length) return false;
    for (const [k, v] of aEntries) {
      const bVal = bObj[k];
      if (bVal === undefined) return false;
      if (!anyValueEquals(v, bVal)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Look up an attribute value by key in a KeyValue array.
 * Returns the value if found, undefined otherwise.
 */
export function findAttribute(attrs: readonly KeyValue[], key: string): AnyValue | undefined {
  for (const kv of attrs) {
    if (kv.key === key) return kv.value;
  }
  return undefined;
}
