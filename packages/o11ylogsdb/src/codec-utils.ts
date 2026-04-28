/**
 * Shared internal utilities for o11ylogsdb codecs.
 *
 * Consolidates functions that were previously duplicated across
 * chunk.ts, codec-columnar.ts, codec-typed.ts, and codec-drain.ts.
 */

import { bytesToHex, hexToBytes } from "stardb";
import { PARAM_STR } from "./drain.js";
import type { AnyValue } from "./types.js";

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
 * Given a Drain template (with PARAM_STR wildcards) and the tokenized
 * input, extract just the variable tokens that correspond to wildcards.
 */
export function extractVarsAgainstTemplate(
  template: readonly string[],
  tokens: readonly string[]
): string[] {
  const out: string[] = [];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === PARAM_STR) out.push(tokens[i] ?? "");
  }
  return out;
}
