# Fused Quantize-on-Encode in Rust WASM

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Implement a fused quantize-on-encode path in the Rust WASM codecs that combines value quantization and ALP encoding into a single WASM call, eliminating one JS↔WASM boundary crossing and one memory pass.

## Why this workstream exists

The o11ytsdb ingest pipeline currently performs quantization and encoding as separate steps:

1. **Quantize** — `quantizeBatch()` in `column-store.ts` `appendBatch()` rounds values in-place using WASM SIMD (~17× faster than JS Math.round)
2. **Encode** — `encodeBatchValuesALPWithStats()` in `column-store.ts` `maybeFreeze()` compresses chunks using ALP codec

These are separate WASM calls with separate memory copies. A fused path would:
- Quantize values during ALP encoding (no separate pass)
- Compute stats on quantized values in the same pass
- Eliminate one WASM boundary crossing per chunk freeze
- Reduce memory traffic (values stay in WASM linear memory)

Current performance: 852K pts/sec for 10K metrics (TS-only). The quantize+encode path runs in the storage layer during chunk freeze.

## Mode

implementation + benchmark

## Required execution checklist

- You MUST read `packages/o11ytsdb/rust/src/lib.rs` to understand the ALP encoder, stats computation, and existing batch encode functions.
- You MUST read `packages/o11ytsdb/src/wasm-codecs.ts` to understand the JS-side WASM bindings, especially `quantizeBatch`, `encodeValuesALPWithStats`, and `encodeBatchValuesALPWithStats`.
- You MUST read `packages/o11ytsdb/src/column-store.ts` lines 272-363 (`appendBatch`) and lines 568-660 (`maybeFreeze`) to understand the current two-step quantize-then-encode flow.
- You MUST read `packages/o11ytsdb/src/types.ts` for `ValuesCodec`, `ChunkStats`, and related interfaces.
- You MUST read `packages/o11ytsdb/bench/codec.bench.ts` to understand how codec benchmarks work.

### Implementation requirements

1. **Rust side** (`packages/o11ytsdb/rust/src/lib.rs`):
   - Add a new exported function `encode_values_alp_with_quantize_and_stats(val_ptr, count, scale, out_ptr, out_cap, stats_ptr) -> i32`
   - The function should: (a) quantize each f64 value by `round(val * scale) / scale` before feeding it to the ALP encoder, (b) compute stats on the quantized values, (c) return the compressed output
   - Also add a batch variant: `encode_batch_values_alp_with_quantize_and_stats(vals_ptr, chunk_size, num_arrays, scale, out_ptr, out_cap, offsets_ptr, sizes_ptr, stats_ptr) -> i32`
   - Use SIMD intrinsics for quantization if the existing `quantize_batch` already does (check)

2. **TypeScript side** (`packages/o11ytsdb/src/wasm-codecs.ts`):
   - Add JS bindings for the new fused functions
   - Expose them through the `WasmCodecs` interface (add a new method like `encodeValuesWithQuantize`)

3. **Integration** (`packages/o11ytsdb/src/column-store.ts`):
   - In `maybeFreeze()`, when quantization is enabled AND WASM is available, use the fused path instead of the separate quantize + encode steps
   - Fall back to the existing two-step path when fused is unavailable

4. **Benchmark**:
   - Add a benchmark case in `packages/o11ytsdb/bench/codec.bench.ts` or a new file that compares: (a) separate quantize + encode, (b) fused quantize-on-encode
   - Measure encode throughput (samples/sec) and total encode time for 640-sample chunks
   - Report whether the fused path is faster and by how much

5. **Tests**:
   - Add a round-trip test: quantize+encode → decode → verify values match `Math.round(original * scale) / scale`
   - Test with gauge_2dp, counter_mono vectors from `packages/o11ytsdb/bench/vectors.ts`

### Building the WASM

- The Rust crate is at `packages/o11ytsdb/rust/` with `Cargo.toml`
- Build with: `cd packages/o11ytsdb/rust && cargo build --target wasm32-unknown-unknown --release`
- The `.wasm` file needs to be copied to the right location for the TS tests to pick it up
- Check if there's a build script (look for `build-wasm` in package.json or similar)
- If you can't build WASM (missing toolchain), implement the Rust code and TS bindings, write a clear note about what to build, and benchmark using the JS fallback path

After completing the required work, use your judgment to explore whether the fused path also benefits the non-batch (single-series) encode path.

## Required repo context

Read at least these:
- `packages/o11ytsdb/rust/src/lib.rs` — Rust WASM codecs (ALP, XOR-delta, delta-ALP)
- `packages/o11ytsdb/rust/Cargo.toml` — Rust crate config
- `packages/o11ytsdb/src/wasm-codecs.ts` — JS WASM bindings
- `packages/o11ytsdb/src/column-store.ts` — Storage layer (appendBatch, maybeFreeze)
- `packages/o11ytsdb/src/types.ts` — ValuesCodec, ChunkStats interfaces
- `packages/o11ytsdb/bench/codec.bench.ts` — Codec benchmarks
- `packages/o11ytsdb/bench/vectors.ts` — Test vectors

## Deliverable

Write implementation in the files listed above, plus a summary at:

`research/ingest-perf-fanout-2/fused-quantize-encode-results.md`

The summary should include:
- What was implemented
- Benchmark numbers (fused vs separate, with confidence intervals)
- Recommendation: ship or not
- What evidence would change the recommendation

## Constraints

- Do NOT modify the existing `encodeValuesALP` or `encodeValuesALPWithStats` functions — add new functions alongside them
- Do NOT change the `ValuesCodec` interface in a breaking way — extend it with optional new methods
- The Rust crate has zero external dependencies — keep it that way
- Ground everything in actual benchmark measurements, not theoretical analysis
- Distinguish `required evidence` (fused vs separate encode throughput) from `optional exploration` (memory allocation, GC pressure)

## Success criteria

- Fused Rust function implemented and compiles (or clear pseudo-implementation if toolchain unavailable)
- TS bindings written and integrated into column-store freeze path
- Benchmark comparing fused vs separate with numbers
- Clear recommendation: "ship" or "defer" with reasoning

## Decision style

End with a decisive recommendation. State whether the fused path is worth shipping, and what the measured speedup is. If the speedup is <10%, recommend deferring.
