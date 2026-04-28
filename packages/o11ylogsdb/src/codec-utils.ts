/**
 * Shared internal utilities for o11ylogsdb codecs.
 *
 * Consolidates functions that were previously duplicated across
 * chunk.ts, codec-columnar.ts, codec-typed.ts, and codec-drain.ts.
 */

export { anyValueToJson, jsonToAnyValue } from "stardb";

import { PARAM_STR } from "./drain.js";

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
