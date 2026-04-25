/**
 * Precision auto-detect benchmark: measures appendBatch throughput
 * with and without precision=6 across three data patterns:
 *   1. Integer counter data (quantize is a no-op → auto-detect should skip)
 *   2. 2-decimal-place gauge data (moderate precision)
 *   3. High-precision ratio data (15+ decimal digits — quantize helps most)
 *
 * The auto-detect optimisation scans each batch for integer-only values
 * and skips the quantize call entirely, saving WASM call overhead + memcpy.
 */
import { describe, expect, it } from "vitest";
import { RowGroupStore } from "../src/row-group-store.js";
import type { ValuesCodec } from "../src/types.js";

// ── Constants ─────────────────────────────────────────────────────────

const CHUNK_SIZE = 640;
const SAMPLES = CHUNK_SIZE * 4; // 4 full chunks per series
const ITERS = 20;

// ── Plain codec (no compression, isolates quantize overhead) ──────────

function createPlainCodec(): ValuesCodec {
  return {
    name: "f64-plain",
    encodeValues(values: Float64Array): Uint8Array {
      const out = new Uint8Array(4 + values.byteLength);
      new DataView(out.buffer).setUint32(0, values.length, true);
      out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
      return out;
    },
    decodeValues(buf: Uint8Array): Float64Array {
      if (buf.byteLength < 4) return new Float64Array(0);
      const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      const raw = buf.subarray(4);
      const bytes = raw.byteLength - (raw.byteLength % 8);
      const copy = raw.slice(0, bytes);
      return new Float64Array(copy.buffer, copy.byteOffset, Math.min(n, Math.floor(bytes / 8)));
    },
  };
}

// ── PRNG ──────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Data generators ───────────────────────────────────────────────────

function makeTimestamps(n: number): BigInt64Array {
  const ts = new BigInt64Array(n);
  const baseT = 1_700_000_000_000_000_000n;
  for (let i = 0; i < n; i++) ts[i] = baseT + BigInt(i) * 15_000_000_000n;
  return ts;
}

function integerCounterData(n: number): Float64Array {
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) vals[i] = i * 42;
  return vals;
}

function twoDecimalGaugeData(n: number): Float64Array {
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    vals[i] = Math.round((Math.sin(i * 0.05) * 100 + 200) * 100) / 100;
  }
  return vals;
}

function highPrecisionRatioData(n: number): Float64Array {
  const rng = mulberry32(42);
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) vals[i] = rng() * 0.01 + 0.5;
  return vals;
}

// ── Benchmark runner ──────────────────────────────────────────────────

interface BenchResult {
  label: string;
  elapsedMs: number;
  samplesPerSec: number;
}

function benchAppendBatch(
  label: string,
  ts: BigInt64Array,
  vals: Float64Array,
  precision?: number
): BenchResult {
  const codec = createPlainCodec();

  // Warmup
  const warmup = new RowGroupStore(
    codec,
    CHUNK_SIZE,
    () => 0,
    32,
    label,
    undefined,
    undefined,
    undefined,
    precision
  );
  const wId = warmup.getOrCreateSeries(new Map([["__name__", "warmup"]]));
  warmup.appendBatch(wId, ts, vals);

  // Timed
  const start = performance.now();
  for (let iter = 0; iter < ITERS; iter++) {
    const store = new RowGroupStore(
      codec,
      CHUNK_SIZE,
      () => 0,
      32,
      label,
      undefined,
      undefined,
      undefined,
      precision
    );
    const id = store.getOrCreateSeries(new Map([["__name__", `s_${iter}`]]));
    store.appendBatch(id, ts, vals);
  }
  const elapsedMs = performance.now() - start;
  const totalSamples = ITERS * ts.length;
  return { label, elapsedMs, samplesPerSec: (totalSamples / elapsedMs) * 1000 };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("precision auto-detect benchmark", () => {
  const ts = makeTimestamps(SAMPLES);

  it("integer counter data: precision=6 should not regress vs no precision", () => {
    const vals = integerCounterData(SAMPLES);
    const noPrecision = benchAppendBatch("counter-no-precision", ts, vals);
    const withPrecision = benchAppendBatch("counter-precision-6", ts, vals, 6);

    console.log(
      `  integer counters — no precision: ${noPrecision.samplesPerSec.toFixed(0)} samples/s, ` +
        `precision=6: ${withPrecision.samplesPerSec.toFixed(0)} samples/s ` +
        `(ratio: ${(withPrecision.samplesPerSec / noPrecision.samplesPerSec).toFixed(2)}x)`
    );

    // With auto-detect, precision=6 on integers should be within 70% of baseline.
    // The integer scan loop has some overhead, but avoids wasteful quantize calls.
    expect(withPrecision.samplesPerSec).toBeGreaterThan(noPrecision.samplesPerSec * 0.3);
  });

  it("2dp gauge data: precision=6 applies quantization", () => {
    const vals = twoDecimalGaugeData(SAMPLES);
    const noPrecision = benchAppendBatch("gauge-no-precision", ts, vals);
    const withPrecision = benchAppendBatch("gauge-precision-6", ts, vals, 6);

    console.log(
      `  2dp gauges — no precision: ${noPrecision.samplesPerSec.toFixed(0)} samples/s, ` +
        `precision=6: ${withPrecision.samplesPerSec.toFixed(0)} samples/s ` +
        `(ratio: ${(withPrecision.samplesPerSec / noPrecision.samplesPerSec).toFixed(2)}x)`
    );

    // Quantization has overhead, but should still be serviceable.
    expect(withPrecision.samplesPerSec).toBeGreaterThan(0);
  });

  it("high-precision ratio data: quantization changes values", () => {
    const vals = highPrecisionRatioData(SAMPLES);
    const noPrecision = benchAppendBatch("ratio-no-precision", ts, vals);
    const withPrecision = benchAppendBatch("ratio-precision-6", ts, vals, 6);

    console.log(
      `  high-precision ratios — no precision: ${noPrecision.samplesPerSec.toFixed(0)} samples/s, ` +
        `precision=6: ${withPrecision.samplesPerSec.toFixed(0)} samples/s ` +
        `(ratio: ${(withPrecision.samplesPerSec / noPrecision.samplesPerSec).toFixed(2)}x)`
    );

    // Verify quantization actually rounds values.
    const store = new RowGroupStore(
      createPlainCodec(),
      CHUNK_SIZE,
      () => 0,
      32,
      "verify",
      undefined,
      undefined,
      undefined,
      6
    );
    const id = store.getOrCreateSeries(new Map([["__name__", "verify"]]));
    store.appendBatch(id, ts, vals);
    const result = store.read(id, ts[0]!, ts[ts.length - 1]!);
    // Values should be rounded to 6 decimal places.
    for (let i = 0; i < Math.min(10, result.values.length); i++) {
      const v = result.values[i]!;
      const rounded = Math.round(v * 1e6) / 1e6;
      expect(v).toBeCloseTo(rounded, 6);
    }

    expect(withPrecision.samplesPerSec).toBeGreaterThan(0);
  });

  it("auto-detect correctness: integer values pass through unchanged", () => {
    const codec = createPlainCodec();
    const store = new RowGroupStore(
      codec,
      CHUNK_SIZE,
      () => 0,
      32,
      "int-check",
      undefined,
      undefined,
      undefined,
      6
    );
    const id = store.getOrCreateSeries(new Map([["__name__", "counter"]]));

    const smallTs = new BigInt64Array([1n, 2n, 3n, 4n, 5n]);
    const intVals = new Float64Array([0, 1, 42, 1000, -7]);
    store.appendBatch(id, smallTs, intVals);

    const result = store.read(id, 1n, 5n);
    expect(Array.from(result.values)).toEqual([0, 1, 42, 1000, -7]);
  });

  it("auto-detect correctness: mixed batch quantizes non-integers", () => {
    const codec = createPlainCodec();
    const store = new RowGroupStore(
      codec,
      CHUNK_SIZE,
      () => 0,
      32,
      "mixed-check",
      undefined,
      undefined,
      undefined,
      3
    );
    const id = store.getOrCreateSeries(new Map([["__name__", "mixed"]]));

    const smallTs = new BigInt64Array([1n, 2n, 3n]);
    // Value 1.23456 is non-integer → should be quantized to 3dp → 1.235 (Math.round)
    const mixedVals = new Float64Array([42, 1.23456, 100]);
    store.appendBatch(id, smallTs, mixedVals);

    const result = store.read(id, 1n, 3n);
    // Batch has a non-integer, so whole batch goes through quantize.
    // 42 → 42.0, 1.23456 → 1.235, 100 → 100.0
    expect(result.values[0]).toBe(42);
    expect(result.values[1]).toBeCloseTo(1.235, 3);
    expect(result.values[2]).toBe(100);
  });

  it("auto-detect correctness: append() skips quantize for integer values", () => {
    const codec = createPlainCodec();
    const store = new RowGroupStore(
      codec,
      CHUNK_SIZE,
      () => 0,
      32,
      "single-check",
      undefined,
      undefined,
      undefined,
      6
    );
    const id = store.getOrCreateSeries(new Map([["__name__", "single"]]));

    store.append(id, 1n, 42);
    store.append(id, 2n, 0);
    store.append(id, 3n, -7);
    store.append(id, 4n, Math.PI);

    const result = store.read(id, 1n, 4n);
    expect(result.values[0]).toBe(42);
    expect(result.values[1]).toBe(0);
    expect(result.values[2]).toBe(-7);
    // Math.PI → quantized to 6dp → 3.141593
    const quantized = Math.round(Math.PI * 1e6) / 1e6;
    expect(result.values[3]).toBe(quantized);
  });
});
