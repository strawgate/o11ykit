# Adaptive Precision Detection + Chunk Size Scaling

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Investigate two orthogonal compression improvements that can stack with any cross-series technique:

1. **Adaptive precision detection**: automatically detect the natural decimal precision of each series and round to that precision before ALP encoding, eliminating exceptions without user-specified `precision=N`
2. **Chunk size scaling**: test whether larger chunks (1280, 2560, 5120 samples) yield better compression ratios with acceptable query granularity tradeoffs

## Why this workstream exists

**Precision**: The current engine bench shows that `precision=3` (explicit 3-decimal-place rounding) drops bytes/point from 2.88 to ~2.3 B/pt by eliminating ALP exceptions. But precision=3 is lossy and user-specified. Many OTel metrics have a *natural* precision (2dp for load_average, 3dp for disk_io_time, 11dp for memory.utilization). If we detect this automatically and round to the natural precision, we eliminate exceptions without information loss.

**Chunk size**: ALP's 14-byte header is amortized over chunk_size samples. At 640 samples, that's 0.022 B/pt header overhead. At 2560 samples, it's 0.0055 B/pt. More importantly, larger chunks give the FoR algorithm a better statistical picture of the value range, potentially finding tighter exponents and bit-widths.

Current: 2.88 B/pt at chunk_size=640, ~2.3 B/pt at precision=3. Can we get closer to 2.3 B/pt without lossy rounding?

## Mode

prototype + benchmark

## Required execution checklist

- You MUST read these files:
  - `packages/o11ytsdb/src/column-store.ts` — how precision is applied (look for `precision` in the constructor and appendBatch), and hot buffer management
  - `packages/o11ytsdb/src/row-group-store.ts` — same precision handling
  - `packages/o11ytsdb/src/types.ts` — StorageBackend interface
  - `packages/o11ytsdb/bench/engine.bench.ts` — how precision=3 variant is configured (lines 259-295), data patterns
  - `packages/o11ytsdb/rust/src/lib.rs` — ALP exponent finding (lines 937-997), understand what makes a value "ALP-clean"

- **Adaptive precision detection**: You MUST implement a function `detectPrecision(values: Float64Array): number | null` that:
  1. Samples the first 32-64 values
  2. For each candidate precision p ∈ {0, 1, 2, 3, ..., 15}:
     - Round each value: `rounded = Math.round(value * 10**p) / 10**p`
     - Check if `rounded === value` (exact bit equality) for all sampled values
  3. Return the minimum p where all values round-trip, or null if no precision ≤ 15 works
  4. This is the "natural precision" — rounding to it is lossless

- You MUST create a `PrecisionAdaptiveStore` in `packages/o11ytsdb/src/precision-adaptive-store.ts` that:
  1. Wraps ColumnStore (delegates most functionality)
  2. During appendBatch: detects precision per series chunk and rounds values to that precision
  3. Falls back to no rounding if natural precision > 15 (high-precision ratios)
  4. Tracks how many series/chunks had precision detected vs fell back

- **Chunk size scaling**: You MUST test ColumnStore with ALP at these chunk sizes: 640, 1280, 2560, 5120
  - Add each as a separate backend in engine.bench.ts (e.g., "alp-range-1280", "alp-range-2560")
  - Note: larger chunks mean more data decoded per query even if only a small time range is needed
  - Measure both compression ratio AND query throughput

- You MUST test the **combination**: adaptive precision + larger chunk size

- You MUST add all variants to `packages/o11ytsdb/bench/engine.bench.ts`

- You MUST run: `npx tsc -b packages/otlpjson packages/o11ytsdb --force && npx tsc -p packages/o11ytsdb/bench/tsconfig.json && node packages/o11ytsdb/bench/run.mjs engine`

- You MUST report:
  - Adaptive precision: which patterns get detected at what precision, bytes/pt improvement
  - Chunk scaling: bytes/pt at each chunk size, ingest throughput, query throughput
  - Combined: best achievable bytes/pt
  - Whether adaptive precision is truly lossless (cross-validation must pass)

- You MUST end with a **recommendation label**: `ADOPT`, `INVESTIGATE_FURTHER`, or `REJECT`

## Required repo context

- `packages/o11ytsdb/src/column-store.ts` (full file, esp. precision handling)
- `packages/o11ytsdb/src/types.ts`
- `packages/o11ytsdb/bench/engine.bench.ts`
- `packages/o11ytsdb/bench/harness.ts`
- `packages/o11ytsdb/bench/vectors.ts`
- `packages/o11ytsdb/rust/src/lib.rs` (lines 937-997 for exponent search)

## Key technical constraints

- Adaptive precision MUST be lossless — the detected precision is the value's natural precision, not an approximation
- Values like `0.10774188717` (11dp, pattern 5) should detect precision=11 and round-trip exactly
- Values like `0.0736272803207...` (pattern 7, ~15+ significant digits) may not have a clean precision — fall back to no rounding
- IEEE 754 double has ~15.9 significant decimal digits — precision detection above 15 is unreliable
- Larger chunk sizes increase memory amplification on partial-range queries (decode more samples than needed)
- The fused range-decode codec (`rangeDecodeALP`) is chunk-size-agnostic — it handles larger buffers fine
- Cross-validation must produce bit-exact results for adaptive precision (since it's lossless)

## What NOT to do

- Do NOT modify the Rust/WASM codec
- Do NOT change existing backends (add new variants instead)
- Do NOT implement lossy precision detection — must be provably lossless
- Do NOT skip measuring query throughput at larger chunk sizes — compression ratio alone is misleading if queries get slower

## Deliverable

1. New file: `packages/o11ytsdb/src/precision-adaptive-store.ts`
2. Modified: `packages/o11ytsdb/bench/engine.bench.ts` (add adaptive + chunk size variants)
3. Benchmark results table showing all configurations
4. Recommendation with label

## Success criteria

- Adaptive precision correctly detects natural precision for patterns 0-6 (constant through 12dp)
- Adaptive precision falls back gracefully for patterns 7-8 (high-precision ratios)
- Clear quantification: adaptive precision saves X B/pt on average (vs 2.88 baseline)
- Clear quantification: chunk_size=2560 saves Y B/pt but costs Z% query throughput
- Combined best configuration identified

## Decision style

Produce a configuration recommendation: "Use adaptive precision (saves X B/pt) + chunk_size=Y (saves Z B/pt) for a combined W B/pt. Adaptive precision is lossless and should be the default. Chunk size increase to Y is worth it because query throughput only drops by Q%."
