/**
 * A/B comparison: original BigInt stepAggregate vs DataView+Number stepAggregate.
 * Both run in the same process to eliminate system-load variance.
 */
import { performance } from "node:perf_hooks";

const N = 5_000_000;
const SERIES = 30;
const PER_SERIES = Math.ceil(N / SERIES);
const T0 = 1700000000000n;
const INTERVAL = 15000n;
const STEP = 60000n;
const _STEP_N = 60000;

// Build ranges (simulate 30 series)
const ranges = [];
for (let s = 0; s < SERIES; s++) {
  const ts = new BigInt64Array(PER_SERIES);
  const vals = new Float64Array(PER_SERIES);
  for (let i = 0; i < PER_SERIES; i++) {
    ts[i] = T0 + BigInt(i) * INTERVAL;
    vals[i] = Math.sin(i * 0.001 + s) * 50 + 100;
  }
  ranges.push({ timestamps: ts, values: vals });
}

// ── Original: BigInt sub+div per sample ──
function stepAggOriginal(ranges, step) {
  let minT = BigInt("9223372036854775807");
  let maxT = -minT;
  for (const r of ranges) {
    if (r.timestamps.length === 0) continue;
    if (r.timestamps[0] < minT) minT = r.timestamps[0];
    if (r.timestamps[r.timestamps.length - 1] > maxT) maxT = r.timestamps[r.timestamps.length - 1];
  }
  const bucketCount = Number((maxT - minT) / step) + 1;
  const values = new Float64Array(bucketCount);
  values.fill(Infinity);
  for (const r of ranges) {
    for (let i = 0; i < r.timestamps.length; i++) {
      const bucket = Number((r.timestamps[i] - minT) / step);
      if (r.values[i] < values[bucket]) values[bucket] = r.values[i];
    }
  }
  return values;
}

// ── New: DataView conversion + Number inner loop ──
const _le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function bigInt64ToFloat64(src) {
  const n = src.length;
  const dst = new Float64Array(n);
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  for (let i = 0; i < n; i++) {
    const off = i * 8;
    const lo = dv.getUint32(off, _le);
    const hi = dv.getInt32(off + 4, _le);
    dst[i] = hi * 4294967296 + lo;
  }
  return dst;
}

function stepAggDataView(ranges, step) {
  let minT = BigInt("9223372036854775807");
  let maxT = -minT;
  for (const r of ranges) {
    if (r.timestamps.length === 0) continue;
    if (r.timestamps[0] < minT) minT = r.timestamps[0];
    if (r.timestamps[r.timestamps.length - 1] > maxT) maxT = r.timestamps[r.timestamps.length - 1];
  }
  const bucketCount = Number((maxT - minT) / step) + 1;
  const values = new Float64Array(bucketCount);
  values.fill(Infinity);

  const minTN = Number(minT);
  const stepN = Number(step);

  const tsNum = new Array(ranges.length);
  for (let ri = 0; ri < ranges.length; ri++) {
    tsNum[ri] = bigInt64ToFloat64(ranges[ri].timestamps);
  }

  for (let ri = 0; ri < ranges.length; ri++) {
    const ts = tsNum[ri];
    const vs = ranges[ri].values;
    for (let i = 0, len = ts.length; i < len; i++) {
      const bucket = ((ts[i] - minTN) / stepN) | 0;
      if (vs[i] < values[bucket]) values[bucket] = vs[i];
    }
  }
  return values;
}

// ── Benchmark ──
function bench(name, fn, warmup = 3, runs = 7) {
  for (let w = 0; w < warmup; w++) fn();
  const times = [];
  for (let r = 0; r < runs; r++) {
    if (global.gc) global.gc();
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(
    `  ${name.padEnd(30)} min=${times[0].toFixed(1)}ms  med=${times[3].toFixed(1)}ms  max=${times[6].toFixed(1)}ms`
  );
  return times[3]; // median
}

console.log(
  `  ${SERIES} series × ${PER_SERIES.toLocaleString()} pts = ${(SERIES * PER_SERIES).toLocaleString()} samples\n`
);

const medOrig = bench("Original (BigInt)", () => stepAggOriginal(ranges, STEP));
const medNew = bench("DataView + Number", () => stepAggDataView(ranges, STEP));

console.log(
  `\n  Speedup: ${(medOrig / medNew).toFixed(2)}x  (${(medOrig - medNew).toFixed(1)}ms saved)`
);

// Verify correctness
const a = stepAggOriginal(ranges, STEP);
const b = stepAggDataView(ranges, STEP);
let maxErr = 0;
for (let i = 0; i < a.length; i++) {
  const err = Math.abs(a[i] - b[i]);
  if (err > maxErr) maxErr = err;
}
console.log(
  `  Max error: ${maxErr} (${maxErr === 0 ? "EXACT MATCH ✓" : maxErr < 1e-10 ? "negligible ✓" : "MISMATCH ✗"})`
);
