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

**Tag 0: CONSTANT**
- Store: 1 value (8 bytes) + count (2 bytes) = 10 bytes total
- Expected: 10-20% of chunks, 0.016 B/sample

**Tag 1: CONSTANT_DELTA**
- Store: first value (8 bytes) + delta (8 bytes) + count (2 bytes) = 18 bytes
- For monotonic counters with fixed increment
- Expected: 5-15% of chunks, 0.028 B/sample

**Tag 2: RLE_DELTA**
- Store: first value + sequence of (delta, run_length) pairs
- For series alternating between changing and stable periods
- Expected: 10-20% of chunks, 0.05-0.3 B/sample

**Tag 3: INT_DELTA_BITPACK**
- Convert float64 → int64 via detected decimal multiplier (10^k, k=0..6)
- Delta encode the integers
- Bit-pack deltas at detected bit width
- Header: multiplier (3 bits) + first value (8 bytes) + bit_width (5 bits)
- For integer-representable metrics with small deltas
- Expected: 30-50% of chunks
- At 4-bit deltas: 0.52 B/sample; at 1-bit: 0.14 B/sample

**Tag 4: INT_DELTA_BITPACK_PATCHED (PFOR-style)**
- Like Tag 3 but with exception handling: pack 95% of deltas at narrow bit width, store 5% as exceptions
- Prevents one outlier from blowing up the bit width for the entire chunk
- Expected: 0.3-0.8 B/sample

**Tag 5: GORILLA_XOR**
- Current standard XOR-delta encoding (fallback for anything that doesn't fit above)
- Expected: 20-40% of remaining chunks, 1.0-1.7 B/sample

### Step 3: Implement change bitmap layer

This is a composable layer applied BEFORE any value codec when >30% of samples are unchanged:

```
Format: [bitmap: ceil(640/8) = 80 bytes] [num_changed: u16] [changed_values: ...]
bitmap: bit N = 1 if sample N differs from sample N-1 (bit 0 always = 1)
changed_values: only values where bitmap=1, encoded with the selected value codec
```

Also implement **RLE-compressed bitmap** variant: when unchanged runs are long, RLE the bitmap itself (3 pairs × 2 bytes = 6 bytes vs 80 bytes raw).

Break-even analysis: at Gorilla's 1.37 B/sample, saving 320 unchanged samples saves 438 bytes, bitmap costs 80 → net 358 bytes saved.

### Step 4: Implement counter-specific GCD trick

For monotonic counters:
1. Assert all deltas ≥ 0 → encode as unsigned (no zigzag, saves 1 bit/value)
2. Compute GCD of all deltas → divide all deltas by GCD, store GCD once (8 bytes)
3. Delta-of-delta on GCD-divided values → steady-rate counters become mostly 0
4. Bit-pack the residuals

Example: increments [1500,1500,1500,3000,1500], GCD=1500, divided=[1,1,1,2,1], DoD=[0,0,1,-1,0], bit_width=2 → 640×2 bits = 160 bytes + 18 header = 178 bytes = 0.28 B/sample vs Gorilla ~1.0-1.5 B/sample.

### Step 5: Implement the adaptive codec selector

```typescript
function selectCodec(values: Float64Array): CodecTag {
  if (allEqual(values)) return CONSTANT;
  
  const deltas = computeDeltas(values);
  if (allEqual(deltas)) return CONSTANT_DELTA;
  
  const { multiplier, integers, exceptionRate } = tryDecimalToInt(values);
  
  if (exceptionRate === 0) {
    const intDeltas = computeDeltas(integers);
    const bitWidth = maxBitWidth(intDeltas);
    const rleCost = estimateRleCost(intDeltas);
    const bitpackCost = 10 + (bitWidth * 640 / 8);
    if (rleCost < bitpackCost) return RLE_DELTA;
    return INT_DELTA_BITPACK;
  }
  
  if (exceptionRate < 0.05) return INT_DELTA_BITPACK_PATCHED;
  
  return GORILLA_XOR;
}
```

### Step 6: Implement the full hybrid pipeline

Combine all techniques into a single encode/decode function:

1. Classify values (8-sample probe for fast path, full scan for codec selection)
2. Decimal-to-integer conversion (if applicable)
3. Prediction (delta or double-delta or GCD-division)
4. Change bitmap (if >30% unchanged)
5. Bit-packing at detected width (or PFOR with exceptions)

**Chunk header format** (4-8 bytes):

```
Byte 0: [codec_tag: 4 bits] [flags: 4 bits]
  codec_tag: 0=CONSTANT, 1=CONST_DELTA, 2=RLE, 3=INT_BITPACK,
             4=INT_BITPACK_PATCHED, 5=XOR, 6-15=reserved
  flags: [is_monotonic: 1] [has_bitmap: 1] [has_gcd: 1] [reserved: 1]

Byte 1: [decimal_exp: 3 bits] [bit_width: 5 bits]
  decimal_exp: 0-6 → multiplier = 10^decimal_exp (7 = no conversion)
  bit_width: 0-31 bits per residual value

Bytes 2+: first value (8 bytes) + codec-specific payload
```

### Step 7: Benchmark everything

- You MUST measure for EVERY codec × EVERY vector (original 5 + new 6 = 11 vectors):
  - Compression ratio (bytes/sample)
  - Encode throughput (samples/sec)
  - Decode throughput (samples/sec)
  - Codec selection overhead (must be <5% of encode time)
- You MUST measure the **hybrid pipeline** end-to-end vs each standalone codec
- You MUST measure **codec tag distribution** across all vectors (what % hits each tag)
- You MUST measure the **change bitmap** layer's impact: with vs without, at various pct_unchanged

### Step 8: Decision and recommendation

You MUST end with one of these labels:

- `SHIP_HYBRID` — the adaptive pipeline is worth the complexity (>2× improvement over Gorilla on the weighted average)
- `SHIP_GORILLA` — current codec is good enough, adaptive overhead not justified
- `SHIP_PARTIAL` — ship only a subset (specify which codecs and which layers)
- `NEEDS_REAL_DATA` — results are promising but need production monitoring data to make the call

State what evidence would change your recommendation.

### Optional exploration (after required work)

- Whether chunk size 640 vs 512 vs 1024 affects the codec ranking
- Whether Brotli/gzip on top of the hybrid output adds meaningful benefit
- FastLanes-compatible bit-pack layout for future WASM SIMD decode
- Decimal-to-integer strategies: global multiplier vs ALP two-pass vs integer detection shortcut

## Deliverable

Write implementation at:
- `packages/o11ytsdb/src/codec-adaptive.ts` — all specialized codecs + the adaptive selector + hybrid pipeline
- `packages/o11ytsdb/src/codec-bitmap.ts` — change bitmap layer (composable)
- `packages/o11ytsdb/bench/compression-rd.bench.ts` — comprehensive benchmark across all codecs × all vectors
- `packages/o11ytsdb/bench/vectors-extended.ts` — new test vector generators (or extend vectors.ts)

Write a research memo at:
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/03-compression-rd-results.md`

The memo MUST include:
- Full benchmark table: all codecs × all vectors × (bytes/sample, encode speed, decode speed)
- Codec tag distribution: what % of chunks select each codec on each vector
- Change bitmap impact table: with/without at various pct_unchanged thresholds
- GCD trick impact: before/after on counter vectors specifically
- Weighted average bytes/sample across a "typical Prometheus workload" mix (you define the weights)
- Decision matrix with clear winner per data pattern
- Recommendation label (one of the four above)
- What evidence would change the recommendation

## Constraints

- Ground everything in the actual repo code
- TypeScript implementations only (WASM versions come later if the codec wins)
- All codecs must implement the `Codec` or `ValuesCodec` interface from `src/types.ts`
- **Lossless only** — every codec must roundtrip exactly for every vector
- Chunk size = 640 samples for all experiments
- Codec selection must be deterministic (same input → same codec tag)
- The hybrid encode/decode must be a single pair of functions callable from the existing storage backends
