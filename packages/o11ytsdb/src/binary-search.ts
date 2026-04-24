import type { TimeRange } from "./types.js";

export function lowerBound(arr: BigInt64Array, target: bigint, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function upperBound(arr: BigInt64Array, target: bigint, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    if (arr[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function concatRanges(parts: TimeRange[]): TimeRange {
  if (parts.length === 0) {
    return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  }
  if (parts.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const only = parts[0]!;
    if ((only.timestamps.length > 0 && only.values.length > 0) || !only.decode) return only;
    const decoded = only.decodeView ? only.decodeView() : only.decode();
    return {
      timestamps: decoded.timestamps.slice(),
      values: decoded.values.slice(),
    };
  }

  let total = 0;
  const materialized: TimeRange[] = [];
  for (const part of parts) {
    const range =
      (part.timestamps.length === 0 || part.values.length === 0) && part.decode
        ? part.decodeView
          ? part.decodeView()
          : part.decode()
        : part;
    materialized.push(range);
    total += range.timestamps.length;
  }

  const timestamps = new BigInt64Array(total);
  const values = new Float64Array(total);
  let offset = 0;
  for (const part of materialized) {
    timestamps.set(part.timestamps, offset);
    values.set(part.values, offset);
    offset += part.timestamps.length;
  }
  return { timestamps, values };
}
