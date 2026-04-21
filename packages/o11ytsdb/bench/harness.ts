/**
 * o11ytsdb benchmark harness.
 *
 * Pluggable, multi-runtime benchmark framework. Every module exports
 * an interface; implementations register against that interface and
 * get benchmarked head-to-head across all runtimes.
 *
 * Key design:
 *   - Pluggable: any number of implementations per module
 *   - Per-benchmark memory: heap delta measured around each bench
 *   - Allocation tracking: count of GC-visible allocations
 *   - Compression metrics: bytes/point, ratio, output size
 *   - Cross-validation: pairwise correctness checks across impls
 *   - JSON output: machine-readable for CI regression detection
 *
 * Usage:
 *   import { Suite } from './harness.js';
 *   const suite = new Suite('codec');
 *   suite.add('encode_gauge', fn, opts);
 *   const report = suite.run('ts');
 *   printReport(report);
 */

// ── Types ────────────────────────────────────────────────────────────

/** Runtime tag — open string, not a closed union. */
export type Runtime = string; // 'ts' | 'rust' | future

export interface BenchResult {
  name: string;
  runtime: Runtime;
  unit: string;
  iterations: number;
  /** Throughput / timing percentiles (higher is better for throughput). */
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  stddev: number;
  /** Memory delta: heap increase caused by this benchmark. */
  heapDeltaBytes: number;
  /** Memory delta: ArrayBuffer increase caused by this benchmark. */
  arrayBufferDeltaBytes: number;
}

export interface CompressionResult {
  name: string;
  runtime: Runtime;
  inputSamples: number;
  rawBytes: number;
  compressedBytes: number;
  bytesPerPoint: number;
  ratio: number;
}

export interface CrossValidation {
  implA: Runtime;
  implB: Runtime;
  vector: string;
  ok: boolean;
  detail: string;
}

export interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface BenchReport {
  module: string;
  timestamp: string;
  commit: string;
  /** All runtimes that were benchmarked in this report. */
  runtimes: Runtime[];
  results: BenchResult[];
  compression: CompressionResult[];
  crossValidation: CrossValidation[];
  memory: MemorySnapshot;
}

export interface BenchOptions {
  /** Number of warmup iterations (default: 100). */
  warmup?: number;
  /** Number of measured iterations (default: 1000). */
  iterations?: number;
  /** Unit label for the result (default: 'ops/sec'). */
  unit?: string;
  /** If set, measure throughput: items processed per call. */
  itemsPerCall?: number;
}

// ── Suite ────────────────────────────────────────────────────────────

const DEFAULT_WARMUP = 100;
const DEFAULT_ITERATIONS = 1000;

interface PendingBench {
  name: string;
  runtime: Runtime;
  fn: () => void;
  opts: BenchOptions;
}

/**
 * Benchmark suite for a single module. Collects benchmarks from
 * multiple runtimes, runs them, and produces a unified report.
 */
export class Suite {
  readonly module: string;
  private benches: PendingBench[] = [];
  private compressions: CompressionResult[] = [];
  private validations: CrossValidation[] = [];
  private runtimes = new Set<Runtime>();

  constructor(module: string) {
    this.module = module;
  }

  /** Register a benchmark for a specific runtime. */
  add(name: string, runtime: Runtime, fn: () => void, opts: BenchOptions = {}): void {
    this.benches.push({ name, runtime, fn, opts });
    this.runtimes.add(runtime);
  }

  /** Record a compression measurement (not timed — just ratio/size). */
  addCompression(
    name: string,
    runtime: Runtime,
    inputSamples: number,
    rawBytes: number,
    compressedBytes: number
  ): void {
    this.compressions.push({
      name,
      runtime,
      inputSamples,
      rawBytes,
      compressedBytes,
      bytesPerPoint: compressedBytes / inputSamples,
      ratio: rawBytes / compressedBytes,
    });
    this.runtimes.add(runtime);
  }

  /** Record a cross-validation result between two implementations. */
  addValidation(implA: Runtime, implB: Runtime, vector: string, ok: boolean, detail: string): void {
    this.validations.push({ implA, implB, vector, ok, detail });
  }

  /** Run all registered benchmarks and produce a report. */
  run(): BenchReport {
    const results: BenchResult[] = [];

    for (const b of this.benches) {
      results.push(runOne(b.name, b.runtime, b.fn, b.opts));
    }

    const mem = process.memoryUsage();
    return {
      module: this.module,
      timestamp: new Date().toISOString(),
      commit: process.env.GIT_SHA ?? "local",
      runtimes: [...this.runtimes],
      results,
      compression: this.compressions,
      crossValidation: this.validations,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
    };
  }
}

// ── Legacy API (for simple single-runtime benchmarks) ────────────────

const legacySuite = new Suite("_legacy");

export function bench(name: string, fn: () => void, opts: BenchOptions = {}): void {
  legacySuite.add(name, "ts", fn, opts);
}

export function runAll(module: string, runtime: Runtime = "ts"): BenchReport {
  const report = legacySuite.run();
  report.module = module;
  // Override runtimes tag for legacy callers.
  report.runtimes = [runtime];
  for (const r of report.results) r.runtime = runtime;
  return report;
}

// ── Core benchmark runner ────────────────────────────────────────────

function runOne(name: string, runtime: Runtime, fn: () => void, opts: BenchOptions): BenchResult {
  const warmup = opts.warmup ?? DEFAULT_WARMUP;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const unit = opts.unit ?? "ops/sec";

  // Warmup — let V8 JIT optimize.
  for (let i = 0; i < warmup; i++) fn();

  // Measure heap before.
  if (global.gc) global.gc();
  const memBefore = process.memoryUsage();

  // Collect timings.
  const timings = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    timings[i] = performance.now() - t0;
  }

  // Measure heap after.
  const memAfter = process.memoryUsage();
  const heapDelta = memAfter.heapUsed - memBefore.heapUsed;
  const abDelta = memAfter.arrayBuffers - memBefore.arrayBuffers;

  // Convert to throughput if itemsPerCall is set.
  const toThroughput = (ms: number): number => {
    if (opts.itemsPerCall) return (opts.itemsPerCall / ms) * 1000;
    return 1000 / ms; // ops/sec
  };

  const throughputSamples = timings.map(toThroughput).sort((a, b) => a - b);
  const min = throughputSamples[0]!;
  const max = throughputSamples[iterations - 1]!;
  const p50 = throughputSamples[Math.floor(iterations * 0.5)]!;
  const p95 = throughputSamples[Math.floor(iterations * 0.95)]!;
  const p99 = throughputSamples[Math.floor(iterations * 0.99)]!;

  let sum = 0;
  for (let i = 0; i < iterations; i++) sum += throughputSamples[i]!;
  const mean = sum / iterations;

  let sqSum = 0;
  for (let i = 0; i < iterations; i++) sqSum += (throughputSamples[i]! - mean) ** 2;
  const stddev = Math.sqrt(sqSum / iterations);

  return {
    name,
    runtime,
    unit,
    iterations,
    min,
    p50,
    p95,
    p99,
    max,
    mean,
    stddev,
    heapDeltaBytes: Math.max(0, heapDelta),
    arrayBufferDeltaBytes: Math.max(0, abDelta),
  };
}

// ── Pretty printing ──────────────────────────────────────────────────

/**
 * Print a full benchmark report: cross-validation, compression,
 * throughput, and memory — grouped by runtime for comparison.
 */
export function printReport(report: BenchReport): void {
  const w = 72;
  console.log(`\n╔${"═".repeat(w)}╗`);
  console.log(
    `${`║  o11ytsdb bench — ${report.module} [${report.runtimes.join(", ")}]`.padEnd(w + 1)}║`
  );
  console.log(`╚${"═".repeat(w)}╝\n`);

  // ── Cross-validation ──
  if (report.crossValidation.length > 0) {
    console.log("  ── Cross-validation ──\n");
    for (const v of report.crossValidation) {
      const mark = v.ok ? "✓" : "✗";
      console.log(`    ${mark} ${v.vector}: ${v.implA} ↔ ${v.implB} — ${v.detail}`);
    }
    console.log();
  }

  // ── Compression ──
  if (report.compression.length > 0) {
    console.log("  ── Compression ──\n");

    // Group by vector name to show runtimes side by side.
    const vectors = [...new Set(report.compression.map((c) => c.name))];
    const rts = report.runtimes;

    // Header.
    let hdr = "    Vector".padEnd(28);
    for (const rt of rts) hdr += `  ${rt} bytes/pt`.padStart(14) + `  ${rt} ratio`.padStart(12);
    console.log(hdr);
    console.log(`    ${"─".repeat(hdr.length - 4)}`);

    for (const vec of vectors) {
      let line = `    ${vec}`.padEnd(28);
      for (const rt of rts) {
        const c = report.compression.find((x) => x.name === vec && x.runtime === rt);
        if (c) {
          line += c.bytesPerPoint.toFixed(2).padStart(14) + `${c.ratio.toFixed(1)}x`.padStart(12);
        } else {
          line += "—".padStart(14) + "—".padStart(12);
        }
      }
      console.log(line);
    }
    console.log();
  }

  // ── Throughput ──
  if (report.results.length > 0) {
    console.log("  ── Throughput ──\n");

    // Group by bench name to show runtimes side by side.
    const names = [...new Set(report.results.map((r) => r.name))];
    const rts = report.runtimes;

    let hdr = "    Benchmark".padEnd(32);
    for (const rt of rts) hdr += `  ${rt} p50`.padStart(14) + `  ${rt} p99`.padStart(14);
    hdr += "  unit";
    console.log(hdr);
    console.log(`    ${"─".repeat(hdr.length - 4)}`);

    for (const name of names) {
      let line = `    ${name}`.padEnd(32);
      let unit = "";
      for (const rt of rts) {
        const r = report.results.find((x) => x.name === name && x.runtime === rt);
        if (r) {
          line += fmt(r.p50).padStart(14) + fmt(r.p99).padStart(14);
          unit = r.unit;
        } else {
          line += "—".padStart(14) + "—".padStart(14);
        }
      }
      line += `  ${unit}`;
      console.log(line);
    }
    console.log();
  }

  // ── Memory per benchmark ──
  const withMem = report.results.filter((r) => r.heapDeltaBytes > 0 || r.arrayBufferDeltaBytes > 0);
  if (withMem.length > 0) {
    console.log("  ── Memory (heap delta during benchmark) ──\n");
    console.log(
      "    Benchmark".padEnd(32) +
        "  runtime".padEnd(10) +
        "  heap Δ".padStart(14) +
        "  arrayBuf Δ".padStart(14)
    );
    console.log(`    ${"─".repeat(66)}`);
    for (const r of withMem) {
      console.log(
        `    ${r.name}`.padEnd(32) +
          `  ${r.runtime}`.padEnd(10) +
          fmtBytes(r.heapDeltaBytes).padStart(14) +
          fmtBytes(r.arrayBufferDeltaBytes).padStart(14)
      );
    }
    console.log();
  }

  // ── Final snapshot ──
  console.log(
    `  Memory snapshot: heap=${fmtBytes(report.memory.heapUsed)} / ${fmtBytes(report.memory.heapTotal)}`
  );
  console.log(`                   arrayBuffers=${fmtBytes(report.memory.arrayBuffers)}\n`);
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Compare two reports and flag regressions.
 * Matches by (name, runtime) pair. Returns true if all pass.
 */
export function compareReports(
  baseline: BenchReport,
  current: BenchReport,
  threshold = 0.05
): { passed: boolean; regressions: string[] } {
  const regressions: string[] = [];
  const key = (r: BenchResult) => `${r.name}:${r.runtime}`;
  const baseMap = new Map(baseline.results.map((r) => [key(r), r]));

  for (const cur of current.results) {
    const base = baseMap.get(key(cur));
    if (!base) continue;
    const delta = (base.p50 - cur.p50) / base.p50;
    if (delta > threshold) {
      regressions.push(
        `${cur.name} (${cur.runtime}): p50 regressed ${(delta * 100).toFixed(1)}% ` +
          `(${fmt(base.p50)} → ${fmt(cur.p50)} ${cur.unit})`
      );
    }
  }

  return { passed: regressions.length === 0, regressions };
}
