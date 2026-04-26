/**
 * profile-harness — CPU + memory profiling primitives for codec
 * experiments.
 *
 * Three measurement layers:
 *
 *   1. Timing percentiles (min / p50 / p90 / p99 / max) over N
 *      iterations of an arbitrary closure, with warmup.
 *   2. Heap delta (heapUsed before/after a closure, gated on
 *      `global.gc` availability via `--expose-gc`).
 *   3. ArrayBuffer / external memory delta (Node `process.memoryUsage`
 *      `arrayBuffers` field — captures Buffer / Uint8Array residency
 *      that doesn't show up in `heapUsed`).
 *
 * Use `node --expose-gc --cpu-prof bench/run.mjs profile-policies` for
 * the full picture. CPU profile lands in `isolate-*-v8.log` in cwd;
 * the bench writes a JSON report alongside.
 */

import {
  bytesPerLog as bytesPerLogFn,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

export interface TimingStats {
  iterations: number;
  /** Lower-is-better unit (e.g. ms per iteration). */
  unit: string;
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  stddev: number;
}

export interface MemoryStats {
  /** Heap delta in bytes around the run (post-warmup, post-GC). */
  heapDeltaBytes: number;
  /** ArrayBuffer / external delta in bytes. */
  arrayBufferDeltaBytes: number;
  /** Heap snapshot at end of run. */
  heapUsedAfter: number;
  /** rss snapshot at end of run. */
  rssAfter: number;
}

export interface ProfileResult extends CompressionResult {
  timing: TimingStats;
  memory: MemoryStats;
}

export interface ProfileReport {
  module: string;
  timestamp: string;
  commit: string | null;
  node: string;
  /** True if `--expose-gc` is present (heap deltas are reliable). */
  gcAvailable: boolean;
  results: ProfileResult[];
}

function tryGc(): void {
  // `global.gc` exists only when started with --expose-gc.
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

function memSnapshot(): { heapUsed: number; arrayBuffers: number; rss: number } {
  const m = process.memoryUsage();
  return {
    heapUsed: m.heapUsed,
    arrayBuffers: m.arrayBuffers,
    rss: m.rss,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i] as number;
}

function meanAndStddev(xs: number[]): { mean: number; stddev: number } {
  if (xs.length === 0) return { mean: 0, stddev: 0 };
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / xs.length;
  let sq = 0;
  for (const x of xs) sq += (x - mean) ** 2;
  const stddev = Math.sqrt(sq / xs.length);
  return { mean, stddev };
}

export interface ProfileOptions {
  /** Warmup iterations (timing samples discarded). Default 3. */
  warmup?: number;
  /** Measured iterations. Default 10. */
  iterations?: number;
  /** Unit label for timing reports. Default `"ms/run"`. */
  unit?: string;
}

/**
 * Run `fn` warmup+iterations times, return timing percentiles + memory
 * delta. Caller passes a closure that does ONE encode + verify pass;
 * the harness handles measurement bookkeeping.
 */
export function runProfile(
  fn: () => void,
  opts: ProfileOptions = {}
): {
  timing: TimingStats;
  memory: MemoryStats;
} {
  const warmup = opts.warmup ?? 3;
  const iterations = opts.iterations ?? 10;
  const unit = opts.unit ?? "ms/run";

  // Warmup phase.
  for (let i = 0; i < warmup; i++) fn();

  // Force GC before measurement so heapUsed reflects residency only.
  tryGc();
  const before = memSnapshot();

  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = nowMillis();
    fn();
    const t1 = nowMillis();
    samples[i] = t1 - t0;
  }

  // GC again to settle, then snapshot.
  tryGc();
  const after = memSnapshot();

  const sorted = [...samples].sort((a, b) => a - b);
  const { mean, stddev } = meanAndStddev(samples);
  const timing: TimingStats = {
    iterations,
    unit,
    min: sorted[0] as number,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] as number,
    mean,
    stddev,
  };
  const memory: MemoryStats = {
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    arrayBufferDeltaBytes: after.arrayBuffers - before.arrayBuffers,
    heapUsedAfter: after.heapUsed,
    rssAfter: after.rss,
  };
  return { timing, memory };
}

/**
 * Convenience wrapper: run an encode-only profile that returns a
 * `ProfileResult` (CompressionResult + timing + memory). Encodes once
 * to capture output size; then runs `iterations` more times for
 * timing/memory.
 */
export interface EncodeProfile {
  corpus: string;
  codec: string;
  inputBytes: number;
  rawTextBytes: number;
  rawNdjsonBytes: number;
  logCount: number;
  /** Closure that performs one full encode pass. Returns total
   * compressed bytes (used to populate CompressionResult). */
  encode: () => number;
  options?: ProfileOptions;
}

export function profileEncode(p: EncodeProfile): ProfileResult {
  // Capture output size from a single sample call.
  const t0 = nowMillis();
  const outputBytes = p.encode();
  const t1 = nowMillis();
  const initialEncodeMs = t1 - t0;

  // Measurement run.
  const { timing, memory } = runProfile(p.encode, p.options);

  return {
    corpus: p.corpus,
    codec: p.codec,
    inputBytes: p.inputBytes,
    outputBytes,
    logCount: p.logCount,
    bytesPerLog: bytesPerLogFn(outputBytes, p.logCount),
    ratioVsRaw: ratioFn(p.rawTextBytes, outputBytes),
    ratioVsNdjson: ratioFn(p.rawNdjsonBytes, outputBytes),
    encodeMillis: initialEncodeMs,
    timing,
    memory,
  };
}

export function buildProfileReport(module: string, results: ProfileResult[]): ProfileReport {
  const gcAvailable = typeof (globalThis as { gc?: () => void }).gc === "function";
  return {
    module,
    timestamp: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? null,
    node: process.version,
    gcAvailable,
    results,
  };
}

/**
 * Render a profile-result table — adds timing p50 + memory deltas to
 * the standard CompressionResult columns.
 */
export function renderProfileTable(results: ProfileResult[]): string {
  const corpora = [...new Set(results.map((r) => r.corpus))];
  const lines: string[] = [];
  lines.push("| corpus | codec | B/log | encode p50 | p99 | heap Δ | array buf Δ |");
  lines.push("|---|---|--:|--:|--:|--:|--:|");
  for (const corpus of corpora) {
    const rows = results
      .filter((r) => r.corpus === corpus)
      .sort((a, b) => a.bytesPerLog - b.bytesPerLog);
    for (const r of rows) {
      lines.push(
        `| ${r.corpus} | ${r.codec} | ${r.bytesPerLog.toFixed(2)} | ` +
          `${r.timing.p50.toFixed(1)} ms | ${r.timing.p99.toFixed(1)} ms | ` +
          `${formatDelta(r.memory.heapDeltaBytes)} | ${formatDelta(r.memory.arrayBufferDeltaBytes)} |`
      );
    }
  }
  return lines.join("\n");
}

function formatDelta(bytes: number): string {
  const sign = bytes < 0 ? "-" : "+";
  const abs = Math.abs(bytes);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)} MB`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)} KB`;
  return `${sign}${abs} B`;
}
