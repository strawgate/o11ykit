import type { Direction } from "./otlp-conventions.js";

/**
 * Infer whether a unit is "bigger_is_better" or "smaller_is_better".
 *
 * Common patterns:
 *  - ops/s, MB/s, throughput, events → bigger is better
 *  - ns/op, B/op, allocs/op, ms, bytes → smaller is better (default)
 */
export function inferDirection(unit: string): NonNullable<Direction> {
  const lower = unit.toLowerCase();

  if (
    lower.includes("ops/s") ||
    lower.includes("op/s") ||
    lower.includes("/sec") ||
    lower.includes("mb/s") ||
    lower.includes("throughput") ||
    lower.includes("events")
  ) {
    return "bigger_is_better";
  }

  return "smaller_is_better";
}
