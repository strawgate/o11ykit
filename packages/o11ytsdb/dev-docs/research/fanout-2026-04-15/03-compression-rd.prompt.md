# Compression R&D: ALP vs Gorilla vs Hybrid Encodings

You are handling one workstream inside a larger Codex Cloud fanout for the o11ytsdb package — a browser-native time-series database for OpenTelemetry data.

## Objective

Investigate and benchmark alternative compression strategies beyond the current XOR-delta (Gorilla) codec to find the best encoding for each metric type: gauges, counters, histograms, and high-cardinality string-heavy workloads.

## Why this workstream exists

The M1 XOR-delta codec achieves 2.3–57.9× compression depending on data pattern. But newer research suggests:

- **ALP (Adaptive Lossless floating-Point)** from the DuckDB/CWI team can beat Gorilla on many workloads by exploiting the limited precision of real-world floats
- **Frame-of-Reference (FOR) + bit-packing** for integer counters can be dramatically better than XOR-delta
- **Dictionary encoding** for low-cardinality float values (e.g., HTTP status codes stored as floats)
- **Run-length encoding** for constant/near-constant series
- The current codec already has ALP support in the Rust WASM (`rangeDecodeALP` in lib.rs) but it hasn't been systematically benchmarked against Gorilla

We need decision-grade evidence on which codec to use for which data pattern, and whether a hybrid approach (auto-detecting the best codec per chunk) is worth the complexity.

## Mode

**research + benchmark**

## Required execution checklist

- You MUST read these files first:
  - `packages/o11ytsdb/src/codec.ts` (current XOR-delta implementation — the reference)
  - `packages/o11ytsdb/rust/src/lib.rs` (Rust WASM including ALP encode/decode)
  - `packages/o11ytsdb/bench/competitive.bench.ts` (existing 7-strategy comparison)
  - `packages/o11ytsdb/bench/vectors.ts` (test data generators)
  - `packages/o11ytsdb/bench/harness.ts` (benchmark infrastructure)
  - `packages/o11ytsdb/PLAN.md` (performance targets)
  - `packages/o11ytsdb/README.md` (current benchmark results)

- You MUST implement and benchmark these compression strategies (all in TypeScript):
  1. **ALP (Adaptive Lossless floating-Point)**: detect float precision, encode as integer with small exception list
  2. **FOR + BitPacking**: for integer-valued counters — find min, subtract, pack in minimum bits
  3. **Dictionary + RLE**: for low-cardinality float values — dictionary lookup + run-length
  4. **Hybrid auto-detect**: header byte selects codec per chunk based on data analysis (first N samples)
  5. **Gorilla baseline**: current XOR-delta (for comparison)

- You MUST benchmark each strategy on ALL 5 existing test vectors PLUS:
  - A new "integer counter" vector (monotonically increasing integers, no floats)
  - A new "low cardinality" vector (only 5-10 distinct values, repeated)
  - A new "nanosecond timestamps from real OTel data" vector if you can construct one from the repo's test infrastructure

- You MUST measure:
  - Compression ratio (bytes/sample)
  - Encode throughput (samples/sec)
  - Decode throughput (samples/sec)
  - Encode + decode combined latency for 1024-sample chunks

- You MUST produce a decision matrix: for each data pattern, which codec wins on (a) compression ratio, (b) decode speed, (c) encode speed

- You MUST end with a concrete recommendation:
  - `SHIP_HYBRID` — auto-detect per chunk, worth the complexity
  - `SHIP_GORILLA` — current codec is good enough for all patterns
  - `SHIP_ALP` — ALP dominates, replace Gorilla
  - `SHIP_GORILLA_PLUS_FOR` — Gorilla for floats, FOR for integers

- After completing the required work, explore:
  - Whether Brotli/gzip on top of each codec changes the ranking
  - Whether chunk size (256 vs 512 vs 1024 vs 2048) affects the winner
  - SIMD-friendly decode layouts for future WASM optimization

## Deliverable

Write implementation at:
- `packages/o11ytsdb/src/codec-alp.ts` — ALP codec
- `packages/o11ytsdb/src/codec-for.ts` — Frame-of-Reference codec
- `packages/o11ytsdb/src/codec-dict.ts` — Dictionary + RLE codec
- `packages/o11ytsdb/src/codec-hybrid.ts` — Auto-detecting hybrid codec
- `packages/o11ytsdb/bench/compression-rd.bench.ts` — comprehensive benchmark

Write a research memo at:
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/03-compression-rd-results.md`

The memo must include:
- Full benchmark table (all codecs × all vectors × all metrics)
- Decision matrix with clear winner per pattern
- Recommendation label (one of the four above)
- What evidence would change the recommendation
- Whether the hybrid approach's decode-time header check overhead is negligible

## Constraints

- Ground everything in the actual repo code
- TypeScript implementations only (WASM versions come later if the codec wins)
- All codecs must implement the `Codec` or `ValuesCodec` interface from `src/types.ts`
- Lossless only — no lossy compression
- Must be correct: roundtrip test for every codec × every vector
