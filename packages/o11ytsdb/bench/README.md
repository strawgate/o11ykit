# o11ytsdb Benchmarks

This directory contains both maintained benchmark entry points and exploratory scripts.

## Maintained entry points

These are the maintained scripts we expect to keep healthy through package scripts.

- `npm run bench`
  Runs the maintained `.bench.ts` suite via `bench/run.mjs`.
- `npm run bench:chunk-size-sweep -- <iterations> [chunkSize...]`
  Sweeps row-group chunk sizes and reports memory/query tradeoffs.
- `npm run bench:compaction -- [iterations]`
  Isolates the marginal cost of a hot-to-cold compaction-triggering ingest round.
- `npm run bench:memory-curve -- [batchSize]`
  Reports memory-over-time for current single-tier `640` versus tiered `80 -> 640`.
- `npm run bench:rowgroup-memory-audit -- [chunkSize]`
  Reports row-group memory composition for one chunk size.
- `npm run bench:rowgroup-profile -- <queryName> [outDir] [iterations]`
  Captures CPU/heap profiles for one row-group query shape.
- `npm run bench:tiered-store-matrix -- [queryIterations] [compactionIterations] [memoryBatchSize]`
  Runs the maintained one-shot comparison of current single-tier `640` versus tiered `80 -> 640` across ingest, memory curve, query matrix, and compaction cost.
- `npm run bench:tiered-rowgroup`
  Compares the current single-tier row-group store against the tiered hot/cold store.
- `npm run bench:tiered-query-matrix -- [iterations]`
  Benchmarks hot-only, cold-only, mixed, and raw-read workloads against current and tiered stores.

All maintained entry points go through:

- `npm run bench:prepare`

That rebuilds:

1. the package JS
2. the Rust/WASM artifact
3. the compiled bench sources in `dist-bench/`

## Benchmark taxonomy

The maintained surface is intentionally split into a few classes:

- `Micro`
  The `.bench.ts` suite and narrow codec/layout benches.
- `Component`
  Store-level costs such as `bench:compaction` and `bench:memory-curve`.
- `Scenario`
  Design-steering comparisons such as `bench:chunk-size-sweep`, `bench:tiered-store-matrix`, `bench:tiered-rowgroup`, and `bench:tiered-query-matrix`.
- `Profiling`
  Deep CPU/heap capture via `bench:rowgroup-profile`.

## Shared utilities

- `common.ts`
  Shared helpers for:
  - loading the package-local WASM artifact
  - initializing WASM codecs
  - common timing summaries
- `harness.ts`
  The maintained `.bench.ts` suite harness.

## Exploratory scripts

The remaining scripts in this directory are still useful, but they are exploratory and not part of the maintained package-script surface. They may be diagnostics, experiments, or one-off analysis helpers.

When promoting an exploratory script into the supported workflow:

1. move duplicated timing/WASM setup into `common.ts`
2. add a package script
3. make sure it compiles under `npm run bench:build`
4. document it here
