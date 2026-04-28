/** Binary search on sorted BigInt64Array — lower bound (first element ≥ target). */
export function lowerBound(arr: BigInt64Array, target: bigint, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Binary search on sorted BigInt64Array — upper bound (first element > target). */
export function upperBound(arr: BigInt64Array, target: bigint, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    if (arr[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
