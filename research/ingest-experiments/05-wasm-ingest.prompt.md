# Experiment: WASM ingest — raw JSON to typed arrays

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Prototype a Rust-based WASM module that takes raw OTLP JSON bytes and emits parsed metric samples (timestamps + values + series fingerprints) directly into WASM linear memory, completely bypassing `JSON.parse()` and the JS object tree. Benchmark against the optimized TS ingest path.

## Why this workstream exists

After three rounds of TS optimization (10× speedup to 1.20M pts/sec), the remaining parse costs are fundamentally about the JS object model:
- 40% is property access on JS objects (`.timeUnixNano`, `.asDouble`, `.attributes`)
- 18% is FNV hashing (arithmetic that WASM does natively)
- 11% is digit scanning for timestamps
- 9% is flattenAttributes (allocates intermediate objects)

A WASM scanner that never creates JS objects could potentially eliminate all four. The project PLAN.md (line 221-224) already envisions this: "Schema-aware JSON scanner: skip unknown fields, emit directly to column buffers in WASM linear memory."

## Mode

prototype

## Required execution checklist

- You MUST read these files first:
  - `packages/o11ytsdb/src/ingest.ts` — understand what the TS pipeline produces (PendingSeriesSamples, fingerprints, labels)
  - `packages/o11ytsdb/src/types.ts` — StorageBackend interface
  - `packages/o11ytsdb/PLAN.md` — the triple-implementation protocol and WASM targets
  - `metrics-with-wasm.md` — existing research on WASM integration patterns
  - `metrics-with-wasm-2.md` — more WASM research
  - `packages/o11ytsdb/bench/ingest.bench.ts` — the benchmark payload structure
- You MUST build a minimal Rust prototype:
  1. Create a Rust crate at `research/ingest-experiments/wasm-ingest/` with `Cargo.toml` targeting `wasm32-unknown-unknown`
  2. Use `#![no_std]` with a simple bump allocator (or `wee_alloc`) — no `std` runtime
  3. Implement a function `parse_gauges(json_ptr: u32, json_len: u32) -> u32` that:
     - Reads UTF-8 JSON bytes from linear memory
     - Scans for gauge dataPoints (can be a simple state machine, does not need a full JSON parser)
     - Extracts `timeUnixNano` (as integer) and `asDouble` (as f64)
     - Computes FNV-1a fingerprints from metric name + attributes
     - Writes results into an output region of linear memory as columnar arrays: `[timestamps: f64[N], values: f64[N], fingerprints: u32[N]]`
     - Returns the number of points parsed
  4. Compile with: `cargo build --target wasm32-unknown-unknown --release`
  5. Optionally run `wasm-opt -Oz` if available
- You MUST create a JS harness at `research/ingest-experiments/05-wasm-bench.mjs` that:
  1. Loads the compiled .wasm module
  2. Builds the same 10K gauge payload as the main benchmark
  3. Encodes it to JSON bytes with `TextEncoder`
  4. Copies bytes into WASM linear memory
  5. Calls `parse_gauges`
  6. Reads results from WASM memory
  7. Benchmarks: TS `parseOtlpToSamples` vs WASM `parse_gauges` for the same payload
  8. Reports throughput (pts/sec) for both paths
- You MUST write results to `research/ingest-experiments/05-wasm-ingest-results.md`
- You MUST report the .wasm binary size

After completing the required work, explore:
- What the crossover point is (payload size where WASM beats TS)
- Whether SIMD (`target-feature=+simd128`) helps with digit scanning or string matching
- How much of the cost is `TextEncoder.encode()` (the JS→WASM copy)
- Whether a full OTLP parser or a schema-aware scanner is the right approach

## Required repo context

Read at least these:

- `packages/o11ytsdb/src/ingest.ts` — what the output should look like
- `packages/o11ytsdb/PLAN.md` — WASM targets and triple-implementation protocol
- `metrics-with-wasm.md` and `metrics-with-wasm-2.md` — WASM integration research
- `packages/o11ytsdb/bench/ingest.bench.ts` — benchmark payload

Key context about the benchmark payload:
- 10,000 gauge metrics in a single OTLP document
- 32 unique metric names (`bench.cpu.utilization.0` through `bench.cpu.utilization.31`)
- 2 point attributes per data point: `host.name` (256 values) and `cpu` (8 values)
- Resource attributes: `service.name=bench`, `service.instance.id=i-1`
- Scope: `name=bench`, `version=0.1`
- Timestamps are 19-digit nanosecond strings
- Values are f64 doubles
- 256 unique series fingerprints

The TS path currently achieves 1.20M pts/sec at p50 for this payload.

## Deliverable

1. Rust crate at `research/ingest-experiments/wasm-ingest/`
2. JS benchmark harness at `research/ingest-experiments/05-wasm-bench.mjs`
3. Compiled .wasm file (checked in or build instructions)
4. Results at `research/ingest-experiments/05-wasm-ingest-results.md` with:
   - Throughput: TS vs WASM
   - Binary size
   - Memory usage
   - Crossover analysis
   - What a production WASM ingest module would need

## Constraints

- Do NOT use `wasm-bindgen` for the hot path — use raw `#[no_mangle] pub extern "C"` exports
- Do NOT use `serde` or `serde_json` — they pull in too much code. Hand-write a minimal JSON scanner.
- Target `wasm32-unknown-unknown`, NOT `wasm32-wasi`
- Keep the .wasm binary under 50KB if possible (the research docs target <20KB for hot modules)
- The prototype only needs to handle gauge metrics — don't try to support all 5 metric types
- If `rustup` and `cargo` are not available in the environment, document the build instructions clearly and create the Rust source files anyway, plus a mock benchmark that estimates what the WASM path could achieve based on the arithmetic cost analysis
- It's fine if the prototype doesn't produce identical output to the TS path (fingerprint format may differ) — the goal is to measure raw parsing throughput

## Success criteria

- Working Rust crate that compiles to WASM (or clear build instructions if toolchain isn't available)
- Benchmark comparison against TS baseline
- Honest assessment of whether WASM ingest is worth pursuing for this workload size
- Binary size reported
- Clear recommendation on next steps

## Decision style

End with a clear recommendation: PURSUE (significant speedup, worth productionizing), DEFER (marginal gains, revisit for larger payloads), or SKIP (JS overhead not the bottleneck we thought).
