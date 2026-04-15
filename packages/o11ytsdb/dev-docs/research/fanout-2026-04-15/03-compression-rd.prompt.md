# Compression R&D: Adaptive Codec Pipeline for Monitoring Data

You are handling one workstream inside a larger Codex Cloud fanout for the o11ytsdb package — a browser-native time-series database for OpenTelemetry data.

## Objective

Build and benchmark an adaptive per-chunk compression pipeline that selects from specialized codecs based on data characteristics, targeting **<0.5 bytes/sample** (stretch: <0.3 B/sample) on real monitoring workloads — a 2.7× improvement over the current Gorilla XOR codec's 1.37 B/sample average.

## Why this workstream exists

The M1 XOR-delta (Gorilla) codec achieves 2.3–57.9× compression depending on data pattern, averaging ~1.37 B/sample. But Gorilla treats all data as opaque float64 XOR sequences. Real monitoring data has exploitable structure:

- 30-50% of samples are unchanged from the previous value
- 60-80% of series are integer-representable (byte counts, file descriptors, packet counts)
- 90%+ of values have ≤3 decimal places (they originate as decimals, not arbitrary IEEE 754)
- 10-20% of series are fully constant over any 640-sample window
- Monotonic counters often increment by multiples of a fixed quantum (e.g., MTU=1500 for network bytes)

A **codec tag per chunk** that selects the best encoding from a small set of specialized codecs, combined with **decimal-to-integer conversion** and **change bitmap filtering**, should beat Gorilla by 2-5× on typical Prometheus/OTel workloads.

## Chunk size: 640 samples

Use **640 samples per chunk** (not the current 1024). Rationale:
- 640 = 5 × 128 (FastLanes-friendly for future SIMD bit-unpacking)
- ~2.7 hours at 15s scrape interval, ~10.7 min at 1s scrape
- At Gorilla's 1.37 B/sample baseline: ~877 bytes per chunk
- Target: <320 bytes (0.5 B/sample), stretch: <192 bytes (0.3 B/sample)

## Mode

**implementation + benchmark**

## Required execution checklist

### Step 0: Read the codebase

- You MUST read these files first:
  - `packages/o11ytsdb/src/codec.ts` (current XOR-delta — the Gorilla baseline)
  - `packages/o11ytsdb/rust/src/lib.rs` (Rust WASM with ALP + rangeDecodeALP)
  - `packages/o11ytsdb/src/types.ts` (Codec, ValuesCodec interfaces)
  - `packages/o11ytsdb/bench/competitive.bench.ts` (existing 7-strategy comparison)
  - `packages/o11ytsdb/bench/vectors.ts` (test data generators — 5 patterns)
  - `packages/o11ytsdb/bench/harness.ts` (benchmark infrastructure)
  - `packages/o11ytsdb/PLAN.md` (performance targets, M1 context)
  - `packages/o11ytsdb/README.md` (current benchmark results)

### Step 1: Expand test vectors

Add these new realistic vector generators to `bench/vectors.ts` (or a new file):

```
6. integerCounter()    — monotonically increasing integers (file descriptors, packet counts)
7. lowCardinality()    — only 5-10 distinct float values, repeated with pattern
8. burstCounter()      — counter that increments in bursts (0,0,0,1500,1500,0,0,3000,...)
9. smallFloat()        — gauge values with ≤2 decimal places (e.g., go_gc_duration_seconds)
10. constantSeries()   — exactly the same value for all 640 samples
11. constantRate()     — counter incrementing by exactly the same delta each step
```

### Step 2: Implement specialized codecs (all TypeScript)

Implement each codec as a standalone encode/decode function pair. All MUST be lossless (exact roundtrip).

**Tag 0: CONSTANT** — Store: 1 value (8 bytes) + count (2 bytes) = 10 bytes total. Expected: 10-20% of chunks, 0.016 B/sample.

**Tag 1: CONSTANT_DELTA** — Store: first value (8 bytes) + delta (8 bytes) + count (2 bytes) = 18 bytes. For monotonic counters with fixed increment. Expected: 5-15% of chunks, 0.028 B/sample.

**Tag 2: RLE_DELTA** — Store: first value + sequence of (delta, run_length) pairs. For series alternating between changing and stable periods. Expected: 10-20% of chunks, 0.05-0.3 B/sample.

**Tag 3: INT_DELTA_BITPACK** — Convert float64 → int64 via detected decimal multiplier (10^k, k=0..6). Delta encode the integers. Bit-pack deltas at detected bit width. Header: multiplier (3 bits) + first value (8 bytes) + bit_width (5 bits). For integer-representable metrics with small deltas. Expected: 30-50% of chunks. At 4-bit deltas: 0.52 B/sample; at 1-bit: 0.14 B/sample.

**Tag 4: INT_DELTA_BITPACK_PATCHED (PFOR-style)** — Like Tag 3 but with exception handling: pack 95% of deltas at narrow bit width, store 5% as exceptions. Prevents one outlier from blowing up the bit width for the entire chunk. Expected: 0.3-0.8 B/sample.

**Tag 5: GORILLA_XOR** — Current standard XOR-delta encoding (fallback for anything that doesn't fit above). Expected: 20-40% of remaining chunks, 1.0-1.7 B/sample.

### Step 3: Implement change bitmap layer

Composable layer applied BEFORE any value codec when >30% of samples are unchanged:

```
Format: [bitmap: ceil(640/8) = 80 bytes] [num_changed: u16] [changed_values: ...]
bitmap: bit N = 1 if sample N differs from sample N-1 (bit 0 always = 1)
changed_values: only values where bitmap=1, encoded with the selected value codec
```

Also implement RLE-compressed bitmap variant for long unchanged runs.

### Step 4: Implement counter-specific GCD trick

For monotonic counters:
1. Assert all deltas ≥ 0 → encode as unsigned (no zigzag, saves 1 bit/value)
2. Compute GCD of all deltas → divide all deltas by GCD, store GCD once (8 bytes)
3. Delta-of-delta on GCD-divided values → steady-rate counters become mostly 0
4. Bit-pack the residuals

### Step 5: Implement the adaptive codec selector + full hybrid pipeline

Combine all techniques: classify → decimal-to-int → prediction → change bitmap → bit-pack.

Chunk header format (4-8 bytes):
```
Byte 0: [codec_tag: 4 bits] [flags: 4 bits]
Byte 1: [decimal_exp: 3 bits] [bit_width: 5 bits]
Bytes 2+: first value (8 bytes) + codec-specific payload
```

### Step 6: Benchmark everything

- You MUST measure for EVERY codec × EVERY vector (original 5 + new 6 = 11 vectors): compression ratio, encode throughput, decode throughput, codec selection overhead
- You MUST measure the hybrid pipeline end-to-end vs each standalone codec
- You MUST measure codec tag distribution across all vectors
- You MUST measure the change bitmap layer's impact: with vs without

### Step 7: Recommendation

End with one of: `SHIP_HYBRID`, `SHIP_GORILLA`, `SHIP_PARTIAL`, `NEEDS_REAL_DATA`. State what evidence would change your recommendation.

## Deliverable

Write implementation at:
- `packages/o11ytsdb/src/codec-adaptive.ts` — all specialized codecs + adaptive selector + hybrid pipeline
- `packages/o11ytsdb/src/codec-bitmap.ts` — change bitmap layer
- `packages/o11ytsdb/bench/compression-rd.bench.ts` — comprehensive benchmark
- `packages/o11ytsdb/bench/vectors-extended.ts` — new test vector generators

Write a research memo at:
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/03-compression-rd-results.md`

## Constraints

- TypeScript only. All codecs must implement `Codec` or `ValuesCodec` from `src/types.ts`. Lossless only. Chunk size = 640.
