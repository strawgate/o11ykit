/**
 * Shared utilities for benchmark output parsers.
 */

/**
 * Convert a benchmark unit string to a metric name suitable for use as an
 * object key.
 *
 * Known aliases take precedence over the general rule:
 *   "B/op"    -> "bytes_per_op"
 *   "MB/s"    -> "mb_per_s"
 *   "ns/iter" -> "ns_per_iter"
 *
 * General rule: replace every `/` with `_per_`, replace spaces with `_`,
 * then lowercase.
 */
export function unitToMetricName(unit: string): string {
  const aliases: Record<string, string> = {
    "B/op": "bytes_per_op",
    "MB/s": "mb_per_s",
    "ns/iter": "ns_per_iter",
  };
  if (aliases[unit]) return aliases[unit];
  return unit.replace(/\//g, "_per_").replace(/\s+/g, "_").toLowerCase();
}
