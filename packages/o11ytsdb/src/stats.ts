import type { ChunkStats } from "./types.js";

export function computeStats(values: Float64Array): ChunkStats {
  const n = values.length;
  let minV = values[0]!;
  let maxV = values[0]!;
  let sum = values[0]!;
  let sumOfSquares = values[0]! * values[0]!;
  let resetCount = 0;

  for (let i = 1; i < n; i++) {
    const v = values[i]!;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    sum += v;
    sumOfSquares += v * v;
    if (v < values[i - 1]!) resetCount++;
  }

  return {
    minV,
    maxV,
    sum,
    count: n,
    firstV: values[0]!,
    lastV: values[n - 1]!,
    sumOfSquares,
    resetCount,
  };
}
