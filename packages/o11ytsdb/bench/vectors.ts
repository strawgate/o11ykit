/**
 * Shared test data generators for o11ytsdb benchmarks.
 *
 * Every benchmark and cross-validation test uses these generators
 * to produce deterministic, reproducible data. Both TS and Zig
 * implementations must produce identical output for these inputs.
 */

/** Deterministic PRNG (xoshiro128**). Same sequence on every run. */
export class Rng {
  private s: Uint32Array;

  constructor(seed = 42) {
    this.s = new Uint32Array(4);
    this.s[0] = seed;
    this.s[1] = seed ^ 0x6c078965;
    this.s[2] = seed ^ 0xdeadbeef;
    this.s[3] = seed ^ 0x01234567;
    // Warm up.
    for (let i = 0; i < 16; i++) this.next();
  }

  next(): number {
    const s = this.s;
    const result = Math.imul(this.rotl(Math.imul(s[0]!, 5), 7), 9) >>> 0;
    const t = s[1]! << 9;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3]! = this.rotl(s[3]!, 11);
    return result / 0x100000000; // [0, 1)
  }

  private rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Gaussian via Box-Muller. */
  gaussian(mean: number, stddev: number): number {
    const u1 = this.next() || 1e-10;
    const u2 = this.next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// ── Data generators ──────────────────────────────────────────────────
//
// Modeled on real OTel host-metrics distributions:
//   - Integer counters (small and large)
//   - Gauges at 2dp, 3dp, 11dp, 12dp (all ALP-clean)
//   - High-precision ratios (cpu.utilization — NOT ALP-clean, FoR-u64 exceptions)
//   - Constants, high-variance
//
// The old generators (constantGauge, slowGauge, monotonicCounter,
// spikyLatency, highEntropy) are kept for backwards compatibility.

export interface ChunkData {
  name: string;
  timestamps: BigInt64Array;
  values: Float64Array;
}

function makeTimes(n: number, t0: bigint): BigInt64Array {
  const ts = new BigInt64Array(n);
  for (let i = 0; i < n; i++) ts[i] = t0 + BigInt(i) * 15_000n;
  return ts;
}

/** Constant gauge (v=42). Best case for XOR compression. */
export function constantGauge(n = 1024, t0 = 1_700_000_000_000n): ChunkData {
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = 42.0;
  return { name: 'constant_gauge', timestamps, values };
}

/** Counter with small integer increments (disk_ops, net_packets). */
export function counterSmall(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let counter = Math.floor(rng.next() * 10000);
  for (let i = 0; i < n; i++) {
    if (rng.next() >= 0.4) counter += Math.floor(rng.next() * 10) + 1;
    values[i] = counter;
  }
  return { name: 'counter_small', timestamps, values };
}

/** Counter with large integers (~10^10, like network bytes). */
export function counterLarge(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let counter = Math.floor(rng.next() * 1e10) + 1e10;
  for (let i = 0; i < n; i++) {
    if (rng.next() >= 0.3) counter += Math.floor(rng.next() * 100000) + 1;
    values[i] = counter;
  }
  return { name: 'counter_large', timestamps, values };
}

/** Gauge with 2 decimal places (cpu_time, load_average). */
export function gauge2dp(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let v = Math.round(rng.next() * 10000) / 100;
  for (let i = 0; i < n; i++) {
    v += rng.gaussian(0, 0.05);
    v = Math.max(0, v);
    values[i] = Math.round(v * 100) / 100;
  }
  return { name: 'gauge_2dp', timestamps, values };
}

/** Gauge with 3 decimal places (disk_io_time, operation_time). */
export function gauge3dp(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let v = rng.next() * 500;
  for (let i = 0; i < n; i++) {
    v += rng.gaussian(0, 0.02);
    v = Math.max(0, v);
    values[i] = Math.round(v * 1000) / 1000;
  }
  return { name: 'gauge_3dp', timestamps, values };
}

/** Gauge with 11 decimal places (memory.utilization). ALP-clean at e=11. */
export function gauge11dp(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let base = rng.next() * 0.5 + 0.05;
  for (let i = 0; i < n; i++) {
    base += rng.gaussian(0, 0.0001);
    base = Math.max(0, Math.min(1, base));
    values[i] = Math.round(base * 1e11) / 1e11;
  }
  return { name: 'gauge_11dp', timestamps, values };
}

/** Gauge with 12 decimal places (filesystem.utilization). ALP-clean at e=12. */
export function gauge12dp(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let base = rng.next() * 0.4 + 0.1;
  for (let i = 0; i < n; i++) {
    base += rng.gaussian(0, 0.000001);
    base = Math.max(0, Math.min(1, base));
    values[i] = Math.round(base * 1e12) / 1e12;
  }
  return { name: 'gauge_12dp', timestamps, values };
}

/**
 * High-precision ratio (cpu.utilization). Full f64 precision from
 * integer division — NOT ALP-clean at any exponent. These become
 * FoR-u64 exceptions.
 */
export function highPrecisionRatio(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let ticks = Math.floor(rng.next() * 1e6);
  let totalTicks = Math.floor(1e7 + rng.next() * 1e6);
  for (let i = 0; i < n; i++) {
    ticks += Math.floor(rng.next() * 200) + 1;
    totalTicks += 1000;
    values[i] = ticks / totalTicks;
  }
  return { name: 'high_precision_ratio', timestamps, values };
}

/** High-variance gauge with 2dp (latency-like random walk). */
export function highVarianceGauge(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let v = rng.next() * 100;
  for (let i = 0; i < n; i++) {
    v += rng.gaussian(0, 0.5);
    v = Math.max(0, v);
    values[i] = Math.round(v * 100) / 100;
  }
  return { name: 'high_variance_gauge', timestamps, values };
}

// ── Legacy generators (kept for backwards compatibility) ─────────────

/** Slow-changing gauge (CPU %). @deprecated Use gauge2dp. */
export function slowGauge(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const data = gauge2dp(n, t0, seed);
  return { ...data, name: 'slow_gauge' };
}

/** Monotonic counter. @deprecated Use counterSmall. */
export function monotonicCounter(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  let v = 1_000_000;
  for (let i = 0; i < n; i++) {
    v += rng.int(10, 200);
    values[i] = v;
  }
  return { name: 'monotonic_counter', timestamps, values };
}

/** Spiky latency (5-2000ms). @deprecated Use highVarianceGauge. */
export function spikyLatency(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const base = rng.gaussian(50, 30);
    const spike = rng.next() < 0.05 ? rng.gaussian(500, 300) : 0;
    values[i] = Math.max(5, base + spike);
  }
  return { name: 'spiky_latency', timestamps, values };
}

/** High entropy random. @deprecated */
export function highEntropy(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = makeTimes(n, t0);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = rng.next() * 1e6;
  return { name: 'high_entropy', timestamps, values };
}

/**
 * All generators matching the real OTel host-metrics distribution.
 * 10 patterns covering the full spectrum from constants to high-precision ratios.
 */
export function allGenerators(n = 1024): ChunkData[] {
  return [
    constantGauge(n),
    counterSmall(n),
    counterLarge(n),
    gauge2dp(n),
    gauge3dp(n),
    gauge11dp(n),
    gauge12dp(n),
    highPrecisionRatio(n),
    highPrecisionRatio(n, undefined, 99), // second seed for variety
    highVarianceGauge(n),
  ];
}

// ── Label generators for index benchmarks ────────────────────────────

export interface LabelSet {
  labels: Array<[name: string, value: string]>;
}

/**
 * Generate N series with realistic label distributions.
 * Each series has `numLabels` labels. Values follow power-law cardinality.
 */
export function generateLabelSets(
  numSeries: number,
  numLabels: number,
  seed = 42,
): LabelSet[] {
  const rng = new Rng(seed);
  const sets: LabelSet[] = [];

  // Label names are fixed.
  const labelNames = Array.from({ length: numLabels }, (_, i) => `label_${i}`);

  // Cardinality per label: power-law. First label has most values.
  const cardinalities = labelNames.map((_, i) => Math.max(3, Math.floor(50 / (i + 1))));

  for (let s = 0; s < numSeries; s++) {
    const labels: Array<[string, string]> = [];
    for (let l = 0; l < numLabels; l++) {
      const card = cardinalities[l]!;
      const valIdx = rng.int(0, card - 1);
      labels.push([labelNames[l]!, `val_${valIdx}`]);
    }
    sets.push({ labels });
  }

  return sets;
}
