# Delta-from-Reference Series Compression

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Prototype and benchmark a **delta-from-reference** encoding where one series in each group is chosen as the "reference" and all other series store compressed deltas (value[i] - reference[i]) instead of raw values. This exploits the fact that correlated series (e.g., multiple CPU cores, similar network interfaces) have small inter-series deltas.

## Why this workstream exists

The current RowGroupStore compresses each series independently via ALP. If two series have values [100.5, 100.7, 100.3, ...] and [100.6, 100.8, 100.4, ...], each needs ~10-11 bits per sample for FoR encoding. But their deltas [0.1, 0.1, 0.1, ...] could be encoded in just 1-2 bits (or even as a constant).

The benchmark uses 10 data patterns (constant, counter-small, counter-large, gauge-2dp, gauge-3dp, gauge-11dp, gauge-12dp, high-precision×2, high-variance). Within each pattern, 10 series share the same generation model — they're correlated by construction. Delta encoding should dramatically reduce bit-widths for these correlated groups.

Current: 2.88 B/pt average. Theory suggests delta encoding could halve the bit-width for correlated series.

## Mode

prototype + benchmark

## Required execution checklist

- You MUST read these files:
  - `packages/o11ytsdb/src/row-group-store.ts` — RowGroup interface (lines 35-48), maybeFreeze (lines 377-503)
  - `packages/o11ytsdb/src/column-store.ts` — FrozenColumns, maybeFreeze, hot buffer management
  - `packages/o11ytsdb/src/types.ts` — StorageBackend, ValuesCodec, ChunkStats
  - `packages/o11ytsdb/bench/engine.bench.ts` — data patterns (lines 313-440), backend loading
  - `packages/o11ytsdb/bench/vectors.ts` — Rng class, generateLabelSets

- You MUST create `packages/o11ytsdb/src/delta-ref-store.ts` that:
  1. Extends or wraps RowGroupStore's architecture
  2. During freeze: picks a "reference" series for the group (e.g., first member, or median by range)
  3. Encodes the reference series normally with ALP
  4. For all other series: computes deltas = values[i] - reference[i], then ALP-encodes the deltas
  5. Stores a flag indicating which series is the reference
  6. On decode: reconstructs original values = deltas[i] + reference[i]
  7. Implements full StorageBackend interface

- You MUST test multiple reference selection strategies:
  - **First member**: simplest, no analysis cost
  - **Median-range member**: pick the series whose values have the median (max-min) range — other series' deltas relative to a "middle" series should have smaller ranges
  - **Median series (actual member)**: pick the series closest to the per-index mean — an actual member series whose values are already bit-exact, avoiding floating-point drift that a synthetic mean would introduce during reconstruction (value - mean + mean ≠ value)

- You MUST handle the case where series are NOT correlated:
  - Patterns 7-8 (high-precision cpu.utilization) have independent random walks
  - Delta encoding could make these WORSE (wider range for deltas than for raw values)
  - Consider: measure delta range vs raw range and fall back to raw encoding when deltas don't help

- You MUST add the backends to `packages/o11ytsdb/bench/engine.bench.ts`

- You MUST run the engine benchmark:

  ```bash
  npx tsc -b packages/otlpjson packages/o11ytsdb --force
  npx tsc -p packages/o11ytsdb/bench/tsconfig.json
  node packages/o11ytsdb/bench/run.mjs engine
  ```


- You MUST report per-pattern compression breakdown (which patterns benefit, which get worse)

- You MUST end with a **recommendation label**: `ADOPT`, `INVESTIGATE_FURTHER`, or `REJECT`

## Required repo context

- `packages/o11ytsdb/src/row-group-store.ts`
- `packages/o11ytsdb/src/column-store.ts`
- `packages/o11ytsdb/src/types.ts`
- `packages/o11ytsdb/bench/engine.bench.ts`
- `packages/o11ytsdb/bench/harness.ts`
- `packages/o11ytsdb/bench/vectors.ts`

## Key technical constraints

- The ALP codec works on Float64Array — deltas are Float64 values which ALP can encode
- Deltas may introduce ALP exceptions if the delta values aren't ALP-clean (e.g., 0.1 + floating point noise)
- The reference series approach means 1 extra decode + N additions on the query path
- Memory must be accounted correctly: reference blob + delta blobs + overhead
- Stats (min, max, sum, count) must be computed on the ORIGINAL values, not the deltas
- Cross-validation must produce bit-exact results matching ColumnStore

## What NOT to do

- Do NOT modify the Rust/WASM codec
- Do NOT change existing backends
- Do NOT skip per-pattern analysis — the aggregate number hides important pattern-level differences
- Do NOT forget to handle the decode path correctly (add reference back to deltas)

## Deliverable

1. New file: `packages/o11ytsdb/src/delta-ref-store.ts`
2. Modified: `packages/o11ytsdb/bench/engine.bench.ts`
3. Benchmark results with per-pattern bytes/point breakdown
4. Recommendation with label

## Success criteria

- Working backend with bit-exact cross-validation
- Clear per-pattern analysis showing which patterns benefit from delta encoding
- Measurement of decode overhead (extra additions on query path)
- If average bytes/point < 2.5 B/pt, recommend ADOPT or INVESTIGATE_FURTHER
- If delta encoding helps some patterns but hurts others, propose an adaptive approach

## Decision style

Be specific about which OTel metric patterns benefit. End with: "Delta-from-reference saves X% on patterns A,B,C (which represent Y% of typical OTel traffic) but costs Z% on patterns D,E. Net effect: W B/pt average."
