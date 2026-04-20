# Post-ALP Byte-Level Compression (zstd/deflate/brotli on Row Group Buffers)

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Test whether applying a general-purpose byte-level compressor (deflate, gzip, brotli) on top of the ALP-compressed row group buffer yields meaningful compression gains. This exploits cross-series byte-level patterns that ALP's per-series encoding misses.

## Why this workstream exists

RowGroupStore already concatenates all series' ALP blobs into one contiguous `valueBuffer`. But no byte-level compressor runs on that buffer. Since related series share the same ALP exponent and similar bit-widths, their compressed representations may have repeating byte patterns (shared headers, similar bit-packed regions) that a general-purpose compressor could exploit.

Current state: 2.89 B/pt with ALP per-series encoding. The question is: can a meta-compression pass on the packed row group buffer push this lower?

**Available in the repo**: `fflate` (already a dependency — fast pure-JS deflate/gzip). Node.js `zlib` is also available for benchmarks.

## Mode

prototype + benchmark

## Required execution checklist

- You MUST read these files:
  - `packages/o11ytsdb/src/row-group-store.ts` — understand the RowGroup interface (lines 35-48) and how `valueBuffer` is packed (lines 465-503)
  - `packages/o11ytsdb/src/types.ts` — StorageBackend interface
  - `packages/o11ytsdb/bench/engine.bench.ts` — how backends are configured and benchmarked
  - `packages/o11ytsdb/bench/harness.ts` — Suite class for compression tracking

- You MUST create a new storage backend `CompressedRowGroupStore` in `packages/o11ytsdb/src/compressed-rg-store.ts` that:
  1. Wraps RowGroupStore or reimplements its freeze path
  2. After packing the ALP blobs into `valueBuffer`, applies a byte-level compressor
  3. On query, decompresses the buffer before slicing into individual series blobs
  4. Tracks both the ALP-compressed size and the post-compression size

- You MUST test multiple compression strategies:
  - **deflate** (via `fflate` which is already in the repo: `import { deflateSync, inflateSync } from 'fflate'`)
  - **gzip** (via Node.js `zlib.gzipSync` / `zlib.gunzipSync` for benchmark comparison)
  - **Per-row-group compression**: compress each row group's valueBuffer independently
  - **Batched compression**: accumulate multiple row groups, compress together (larger dictionary window)

- You MUST also test compressing the **packed stats** (Float64Array) and **timestamp blobs** separately to see if those compress well too

- You MUST add the new backend(s) to `packages/o11ytsdb/bench/engine.bench.ts`

- You MUST run the engine benchmark:
  ```bash
  npx tsc -b packages/otlpjson packages/o11ytsdb --force
  npx tsc -p packages/o11ytsdb/bench/tsconfig.json
  node packages/o11ytsdb/bench/run.mjs engine
  ```

- You MUST report: bytes/point (post-compression), compression ratio vs raw (26.24 B/pt) and vs ALP-only (2.88 B/pt), ingest throughput impact, query throughput impact (decompression cost)

- You MUST end with a **recommendation label**: `ADOPT`, `INVESTIGATE_FURTHER`, or `REJECT`

## Required repo context

- `packages/o11ytsdb/src/row-group-store.ts` (full file)
- `packages/o11ytsdb/src/column-store.ts` (for comparison, esp. FrozenColumns)
- `packages/o11ytsdb/src/types.ts`
- `packages/o11ytsdb/bench/engine.bench.ts`
- `packages/o11ytsdb/bench/harness.ts`
- `node_modules/fflate/` — the fflate library is available

## Key technical constraints

- `fflate` is already a dependency — prefer it for browser-compatible compression
- Node.js `zlib` can be used in benchmarks but note it's not available in browsers
- The key tradeoff is compression ratio vs decode latency — every query must decompress
- Row groups are ~640 samples × N series. With 100 series at ~4.5 bytes/series/chunk, each row group buffer is ~450 bytes per series × 100 = ~45KB. This is enough data for deflate to find patterns.
- The benchmark uses 100 series × 10K points = 1M total samples
- Memory accounting (`memoryBytes()`) must reflect the compressed size, not the decompressed size

## What NOT to do

- Do NOT modify the Rust/WASM ALP codec
- Do NOT modify existing RowGroupStore or ColumnStore
- Do NOT implement compression in Rust/WASM — use fflate or Node zlib
- Do NOT skip measuring the ingest and query throughput impact — compression ratio alone is insufficient

## Deliverable

1. New file: `packages/o11ytsdb/src/compressed-rg-store.ts`
2. Modified: `packages/o11ytsdb/bench/engine.bench.ts` (add compressed variants)
3. Benchmark results with bytes/point, throughput, and decompression overhead
4. Recommendation with label

## Success criteria

- Working backend that passes cross-validation (bit-exact results)
- Clear measurement of compression ratio improvement over ALP-only
- Clear measurement of ingest/query throughput impact
- If compression saves >15% space (below 2.45 B/pt), it's potentially interesting
- If decompression adds >2× query latency, it's likely not worth it for hot queries

## Decision style

Be concrete: "deflate on row group buffers saves X% space but costs Y% query throughput". State whether the tradeoff is worth it for a browser-native TSDB where memory is precious but query latency matters.
