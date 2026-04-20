# Shared-Exponent ALP with Header Amortization

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Prototype and benchmark a **shared-exponent ALP** encoding where all series in a row group share a single ALP decimal exponent, eliminating per-series ALP headers and potentially enabling cross-series integer FoR packing.

## Why this workstream exists

The current ALP codec encodes each series independently with its own 14-byte header:

```text
[0-1]   count (u16)
[2]     exponent (u8)
[3]     bit_width (u8)
[4-11]  min_int (i64)
[12-13] exception_count (u16)
```

With 100 series per group and 640-sample chunks, that's 100 × 14 = 1,400 bytes of headers per row group freeze. At 64,000 samples per row group (100 × 640), headers alone cost 0.022 B/pt.

But the bigger opportunity is: if all series in a group share the same exponent `e`, we can:
1. Store one exponent for the whole group (eliminate 100 × 1 = 100 bytes)
2. Scale all values to integers with the same exponent, then do cross-series FoR on the integers
3. Series of the same metric type (e.g., all `system.cpu.utilization` at e=11) will have similar integer ranges → small combined bit-width

The ALP exponent selection algorithm (in `packages/o11ytsdb/rust/src/lib.rs` lines 937-997) tests each exponent e ∈ [0..18] by sampling values and picking the one that minimizes total encoded size. Series of the same type typically pick the same exponent.

## Mode

prototype + benchmark

## Required execution checklist

- You MUST read these files:
  - `packages/o11ytsdb/rust/src/lib.rs` — ALP exponent finding (lines 937-997), FoR packing (lines 1045-1076), full encode (lines 1078-1129)
  - `packages/o11ytsdb/src/row-group-store.ts` — RowGroup, maybeFreeze
  - `packages/o11ytsdb/src/types.ts` — ValuesCodec interface
  - `packages/o11ytsdb/bench/engine.bench.ts` — data patterns, backend loading

- You MUST create `packages/o11ytsdb/src/shared-exp-store.ts` that:
  1. During freeze: for each group, determine the "best shared exponent" across all member series
     - For each candidate exponent e ∈ {0,1,2,...,18}: scale all values from all series by 10**e, count how many round-trip correctly
     - Pick the exponent with highest total match count (or lowest total encoded size)
  2. Encode all series using that shared exponent:
     - Scale values to integers: `int = round(value × 10**e)`
     - Exceptions: values that don't round-trip at this exponent
     - Store: [group header: exponent, member count] + [per-series: bit_width, min_int, exception_count, packed data]
  3. Compare total encoded size vs independent-exponent ALP
  4. Implement full StorageBackend interface

- You MUST implement the ALP exponent selection and integer encoding **in TypeScript** (no Rust changes):
  - Replicate the core ALP algorithm: for each value, `int = Math.round(value * 10**e)`, check `int / 10**e === value` (within tolerance)
  - FoR packing: compute min/max integers, bit-width = ceil(log2(max - min + 1)), bit-pack offsets
  - This is a prototype — performance matters less than correctness

- You MUST test these scenarios:
  - **Homogeneous group**: all 100 series are the same pattern (e.g., all gauge-2dp) → shared exponent should be perfect
  - **Mixed group**: the default engine bench has 10 patterns × 10 series each in one group → shared exponent may not exist
  - **Sub-group approach**: cluster series by their natural exponent, share within clusters

- You MUST add backends to `packages/o11ytsdb/bench/engine.bench.ts`

- You MUST run: `npx tsc -b packages/otlpjson packages/o11ytsdb --force && npx tsc -p packages/o11ytsdb/bench/tsconfig.json && node packages/o11ytsdb/bench/run.mjs engine`

- You MUST report bytes/point and ingest/query throughput

- You MUST end with a **recommendation label**: `ADOPT`, `INVESTIGATE_FURTHER`, or `REJECT`

## Required repo context

- `packages/o11ytsdb/rust/src/lib.rs` (lines 937-1129 — ALP algorithm)
- `packages/o11ytsdb/src/row-group-store.ts`
- `packages/o11ytsdb/src/column-store.ts`
- `packages/o11ytsdb/src/types.ts`
- `packages/o11ytsdb/bench/engine.bench.ts` (esp. data patterns lines 313-440)
- `packages/o11ytsdb/bench/harness.ts`

## Key technical constraints

- ALP exponent varies by data pattern: constants use e=1, gauges use e=2-12, high-precision ratios may not have a clean exponent
- The engine benchmark puts all 100 series in one group (10 patterns × 10 series). A shared exponent across ALL patterns is unlikely to be optimal.
- Sub-grouping by exponent is the realistic approach: cluster series by their natural exponent, share within each cluster
- The TS implementation of ALP encoding will be slower than WASM — that's OK for a prototype, but note the throughput numbers will be pessimistic
- Must handle exceptions (values that don't round-trip) correctly
- Memory accounting must reflect actual stored bytes

## What NOT to do

- Do NOT modify the Rust/WASM codec
- Do NOT change existing backends
- Do NOT implement only the theoretical analysis — build a working prototype
- Do NOT assume all series in a group share the same exponent — handle mixed groups

## Deliverable

1. New file: `packages/o11ytsdb/src/shared-exp-store.ts`
2. Modified: `packages/o11ytsdb/bench/engine.bench.ts`
3. Benchmark results
4. Analysis: header savings + cross-series FoR benefit (or lack thereof)
5. Recommendation with label

## Success criteria

- Working prototype with correct decode (cross-validation passes)
- Clear measurement of header amortization savings
- Analysis of whether shared exponent enables better cross-series FoR
- If sub-grouping by exponent is needed, implement and measure it
- Decisive recommendation on whether shared-exponent ALP is worth pursuing in WASM

## Decision style

Quantify the savings: "Shared exponent saves X bytes/pt from header amortization and Y bytes/pt from cross-series FoR, for a total of Z B/pt (vs 2.88 B/pt baseline). Sub-grouping is needed for mixed workloads. ADOPT/INVESTIGATE/REJECT."
