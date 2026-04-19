import type { ChunkStats } from "./types.js";

export function computeStats(values: Float64Array): ChunkStats {
  const n = values.length;
  if (n === 0) {
    throw new RangeError("computeStats requires at least one sample");
  }
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked above
  let minV = values[0]!;
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  let maxV = values[0]!;
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  let sum = values[0]!;
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  let sumOfSquares = values[0]! * values[0]!;
  let resetCount = 0;

  for (let i = 1; i < n; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const v = values[i]!;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    sum += v;
    sumOfSquares += v * v;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    if (v < values[i - 1]!) resetCount++;
  }

  return {
    minV,
    maxV,
    sum,
    count: n,
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    firstV: values[0]!,
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    lastV: values[n - 1]!,
    sumOfSquares,
    resetCount,
  };
}
