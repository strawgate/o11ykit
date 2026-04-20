# Transposed Cross-Series Frame-of-Reference Compression

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Prototype and benchmark a **transposed Frame-of-Reference (FoR)** encoding for the RowGroupStore that compresses values *across series* at each timestamp index instead of compressing each series independently over time.

## Why this workstream exists

The current RowGroupStore packs multiple series' ALP-compressed blobs into one contiguous ArrayBuffer, but each series is still independently ALP-encoded. This means cross-series value correlation is not exploited at all. The result: RowGroupStore achieves 2.89 B/pt — identical to ColumnStore's 2.88 B/pt.

The user expected that co-locating series with shared timestamps into "columns" (one column per series, rows = timestamps) would enable Parquet-style columnar compression where values at the same timestamp across related series compress better together.

**The core idea**: Instead of encoding [640 timestamps of series_0], [640 timestamps of series_1], ..., transpose to encode [N series values at t₀], [N series values at t₁], .... Within a single timestamp, series of the same metric type (e.g., all cpu_utilization values) often have similar magnitudes — so FoR bit-width across N values at one timestamp should be much smaller than FoR bit-width for one series across 640 timestamps.

## Mode

prototype + benchmark

## Required execution checklist

- You MUST read these files first to understand the architecture:
  - `packages/o11ytsdb/src/row-group-store.ts` — current row-group packing (esp. lines 465-503 where blobs are packed)
  - `packages/o11ytsdb/src/column-store.ts` — FrozenColumns type (lines 45-108), maybeFreeze (lines 568-690)
  - `packages/o11ytsdb/src/types.ts` — StorageBackend, ValuesCodec, ChunkStats interfaces
  - `packages/o11ytsdb/bench/engine.bench.ts` — how backends are benchmarked (lines 1-450+)
  - `packages/o11ytsdb/bench/harness.ts` — Suite class, BenchReport, compression tracking
  - `packages/o11ytsdb/bench/vectors.ts` — Rng class and data generation patterns

- You MUST understand the current ALP encoding format:
  - ALP encodes Float64 values by finding a decimal exponent e, scaling to integers, then FoR bit-packing
  - Header: 14 bytes (count, exponent, bit_width, min_int, exception_count)
  - Payload: bit-packed offsets from min_int, then optional exception storage
  - The WASM codec is at `packages/o11ytsdb/rust/src/lib.rs` (lines 817-1129)

- You MUST create a new storage backend variant called `TransposedStore` in a new file `packages/o11ytsdb/src/transposed-store.ts` that:
  1. During freeze: collects all group members' values at each sample index (transpose the matrix)
  2. For each "cross-series column" (values from all N series at timestamp index i), applies a FoR encoding:
     - Compute min/max of the N values (as Float64)
     - Convert to sortable u64 representation (same as ALP's f64_to_sortable_u64: flip sign bit, flip mantissa for negatives)
     - FoR bit-pack: store min_u64 + bit-packed offsets (max_u64 - min_u64 determines bit-width)
  3. Store the transposed encoded buffer plus metadata needed for decoding
  4. Implement the full StorageBackend interface so queries still work

- You MUST also test a **hybrid approach**: 
  - Use ALP per-series encoding for the *within-series temporal* axis (existing codec)
  - Then apply a cross-series FoR pass on the ALP-encoded integers (before bit-packing)
  - Compare: pure transposed vs hybrid vs current independent ALP

- You MUST add the new backend(s) to `packages/o11ytsdb/bench/engine.bench.ts` alongside existing backends

- You MUST run the engine benchmark:
  ```bash
  npx tsc -b packages/otlpjson packages/o11ytsdb --force
  npx tsc -p packages/o11ytsdb/bench/tsconfig.json
  node packages/o11ytsdb/bench/run.mjs engine
  ```

- You MUST report: bytes/point, compression ratio vs FlatStore (26.24 B/pt), ingest throughput (samples/sec), and single-series query throughput

- You MUST end with a **recommendation label**: one of `ADOPT`, `INVESTIGATE_FURTHER`, `REJECT`, with reasoning

## Required repo context

Read at least these:
- `packages/o11ytsdb/src/row-group-store.ts`
- `packages/o11ytsdb/src/column-store.ts` (lines 45-108 for FrozenColumns, lines 568-690 for maybeFreeze)
- `packages/o11ytsdb/src/types.ts`
- `packages/o11ytsdb/bench/engine.bench.ts`
- `packages/o11ytsdb/bench/harness.ts`
- `packages/o11ytsdb/bench/vectors.ts`
- `packages/o11ytsdb/rust/src/lib.rs` (lines 937-1129 for ALP algorithm)

## Key technical constraints

- The WASM ALP codec cannot be modified (no Rust changes). Your transposed encoding must be implemented in TypeScript.
- Existing ALP codec can be used as a building block (e.g., encode per-series first, then cross-series pass)
- The 10 data patterns in engine.bench.ts range from constant (pattern 0) to high-precision ratios (patterns 7-8). Cross-series FoR may help patterns 0-6 (similar magnitudes) but hurt patterns 7-8 (different random walks).
- Chunk size is 640 samples. Groups have 10-100 series typically.
- Must implement the full StorageBackend interface: `add()`, `appendBatch()`, `query()`, `seriesCount()`, `sampleCount()`, `memoryBytes()`
- Cross-validation with existing backends is important — the benchmark checks bit-exact query results

## What NOT to do

- Do NOT modify the Rust/WASM codec
- Do NOT change existing backends (ColumnStore, RowGroupStore)
- Do NOT skip the benchmark — theoretical analysis alone is not sufficient
- Do NOT break existing tests (run `npx vitest run` to verify)

## Deliverable

1. New file: `packages/o11ytsdb/src/transposed-store.ts`
2. Modified: `packages/o11ytsdb/bench/engine.bench.ts` (add new backend variants)
3. Benchmark results pasted in a summary note
4. Recommendation with label

## Success criteria

- Working TransposedStore that passes cross-validation against ColumnStore (bit-exact query results)
- Benchmark numbers showing bytes/point for transposed encoding vs 2.88 B/pt baseline
- Clear analysis of which data patterns benefit and which don't
- Decisive recommendation on whether to pursue transposed encoding

## Decision style

End with a decisive recommendation. If transposed FoR beats 2.5 B/pt average, recommend ADOPT. If 2.5-2.8 B/pt, recommend INVESTIGATE_FURTHER. If ≥2.8 B/pt, recommend REJECT with analysis of why cross-series FoR doesn't help.
