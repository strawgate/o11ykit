import { performance } from "node:perf_hooks";

const N = 5_000_000;
const ts = new BigInt64Array(N);
const tsF = new Float64Array(N);
const vals = new Float64Array(N);

for (let i = 0; i < N; i++) {
  ts[i] = 1700000000000n + BigInt(i) * 15000n;
  tsF[i] = 1700000000000 + i * 15000;
  vals[i] = Math.random() * 100;
}

const buckets = new Float64Array(42000);
const minT = 1700000000000n;
const step = 60000n;
const minTN = 1700000000000;
const stepN = 60000;

function bench(name, fn, warmup = 3, runs = 5) {
  for (let w = 0; w < warmup; w++) fn();
  const times = [];
  for (let r = 0; r < runs; r++) {
    if (global.gc) global.gc();
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mid = times.length >> 1;
  const median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
  console.log(`  ${name.padEnd(30)} min=${times[0].toFixed(1)}ms  median=${median.toFixed(1)}ms`);
}

// 1. Original: BigInt subtract + divide per element
bench("BigInt sub+div", () => {
  buckets.fill(Infinity);
  for (let i = 0; i < N; i++) {
    const b = Number((ts[i] - minT) / step);
    if (vals[i] < buckets[b]) buckets[b] = vals[i];
  }
});

// 2. Pre-converted Float64Array (ideal inner loop)
bench("Float64 div", () => {
  buckets.fill(Infinity);
  for (let i = 0; i < N; i++) {
    const b = (tsF[i] - minTN) / stepN | 0;
    if (vals[i] < buckets[b]) buckets[b] = vals[i];
  }
});

// 3. Number(BigInt) inline + Number arithmetic
bench("Number(BigInt) inline", () => {
  buckets.fill(Infinity);
  for (let i = 0; i < N; i++) {
    const b = (Number(ts[i]) - minTN) / stepN | 0;
    if (vals[i] < buckets[b]) buckets[b] = vals[i];
  }
});

// 4. Batch convert then Number loop
bench("Batch convert + loop", () => {
  const tsN = new Float64Array(N);
  for (let i = 0; i < N; i++) tsN[i] = Number(ts[i]);
  buckets.fill(Infinity);
  for (let i = 0; i < N; i++) {
    const b = (tsN[i] - minTN) / stepN | 0;
    if (vals[i] < buckets[b]) buckets[b] = vals[i];
  }
});

// 5. Conversion cost alone
bench("BigInt->Number convert only", () => {
  const dst = new Float64Array(N);
  for (let i = 0; i < N; i++) dst[i] = Number(ts[i]);
});

// 6. DataView approach (read BigInt64 as bytes, convert)
bench("DataView i64->f64", () => {
  const buf = ts.buffer;
  const dv = new DataView(buf);
  const dst = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    // Read the low 32 bits + high 32 bits, combine as Number
    const lo = dv.getUint32(i * 8, true);
    const hi = dv.getInt32(i * 8 + 4, true);
    dst[i] = hi * 4294967296 + lo;
  }
  buckets.fill(Infinity);
  for (let i = 0; i < N; i++) {
    const b = (dst[i] - minTN) / stepN | 0;
    if (vals[i] < buckets[b]) buckets[b] = vals[i];
  }
});

// 7. Float64Array reinterpret (timestamps stored as Float64Array from the start)
// This simulates what we'd get if read() returned Float64Array timestamps
bench("Float64 pre-stored (best)", () => {
  buckets.fill(Infinity);
  for (let i = 0; i < N; i++) {
    const b = (tsF[i] - minTN) / stepN | 0;
    if (vals[i] < buckets[b]) buckets[b] = vals[i];
  }
});
