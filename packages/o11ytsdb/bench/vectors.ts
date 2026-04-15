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

export interface ChunkData {
  name: string;
  timestamps: BigInt64Array;
  values: Float64Array;
}

/** Constant gauge (v=42). Best case for XOR compression. */
export function constantGauge(n = 1024, t0 = 1_700_000_000_000n): ChunkData {
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    timestamps[i] = t0 + BigInt(i) * 15_000n; // 15s intervals
    values[i] = 42.0;
  }
  return { name: 'constant_gauge', timestamps, values };
}

/** Slow-changing gauge (CPU %). Realistic infrastructure metric. */
export function slowGauge(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  let v = 45.0;
  for (let i = 0; i < n; i++) {
    timestamps[i] = t0 + BigInt(i) * 15_000n;
    v += rng.gaussian(0, 0.5);
    v = Math.max(0, Math.min(100, v));
    values[i] = Math.round(v * 100) / 100; // 2 decimal places
  }
  return { name: 'slow_gauge', timestamps, values };
}

/** Monotonic counter (HTTP requests). Strictly increasing integers. */
export function monotonicCounter(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  let v = 1_000_000;
  for (let i = 0; i < n; i++) {
    timestamps[i] = t0 + BigInt(i) * 15_000n;
    v += rng.int(10, 200);
    values[i] = v;
  }
  return { name: 'monotonic_counter', timestamps, values };
}

/** Spiky latency (5-2000ms). High variance, many leading zeros in XOR. */
export function spikyLatency(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    timestamps[i] = t0 + BigInt(i) * 15_000n;
    const base = rng.gaussian(50, 30);
    const spike = rng.next() < 0.05 ? rng.gaussian(500, 300) : 0;
    values[i] = Math.max(5, base + spike);
  }
  return { name: 'spiky_latency', timestamps, values };
}

/** High entropy random. Worst case for compression. */
export function highEntropy(n = 1024, t0 = 1_700_000_000_000n, seed = 42): ChunkData {
  const rng = new Rng(seed);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    timestamps[i] = t0 + BigInt(i) * 15_000n;
    values[i] = rng.next() * 1e6;
  }
  return { name: 'high_entropy', timestamps, values };
}

/** All generators for bulk benchmarking. */
export function allGenerators(n = 1024): ChunkData[] {
  return [
    constantGauge(n),
    slowGauge(n),
    monotonicCounter(n),
    spikyLatency(n),
    highEntropy(n),
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
