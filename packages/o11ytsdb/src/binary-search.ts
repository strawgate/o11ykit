import type { Labels, TimeRange } from "./types.js";

export function seriesKey(labels: Labels): string {
  const entries = [...labels.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return entries.map(([k, v]) => `${k}=${v}`).join(",");
}

export function lowerBound(arr: BigInt64Array, target: bigint, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function upperBound(arr: BigInt64Array, target: bigint, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function concatRanges(parts: TimeRange[]): TimeRange {
  if (parts.length === 0) {
    return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  }
  if (parts.length === 1) return parts[0]!;

  let total = 0;
  for (const p of parts) total += p.timestamps.length;

  const timestamps = new BigInt64Array(total);
  const values = new Float64Array(total);
  let offset = 0;
  for (const p of parts) {
    timestamps.set(p.timestamps, offset);
    values.set(p.values, offset);
    offset += p.timestamps.length;
  }
  return { timestamps, values };
}
