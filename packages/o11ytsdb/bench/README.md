# o11ytsdb Benchmarks

This directory contains both maintained benchmark entry points and exploratory scripts.

## Maintained entry points

These are the scripts we expect to keep healthy through the package scripts:

- `npm run bench`
  Runs the maintained `.bench.ts` suite via `bench/run.mjs`.
- `npm run bench:chunk-size-sweep -- <iterations> [chunkSize...]`
  Sweeps row-group chunk sizes and reports memory/query tradeoffs.
- `npm run bench:rowgroup-memory-audit -- [chunkSize]`
  Reports row-group memory composition for one chunk size.
- `npm run bench:rowgroup-profile -- <queryName> [outDir] [iterations]`
  Captures CPU/heap profiles for one row-group query shape.
- `npm run bench:tiered-rowgroup`
  Compares the current single-tier row-group store against the tiered hot/cold store.

All maintained entry points go through:

- `npm run bench:prepare`

That rebuilds:

1. the package JS
2. the Rust/WASM artifact
3. the compiled bench sources in `dist-bench/`

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
