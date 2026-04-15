# Query Language & Streaming Executor

You are handling one workstream inside a larger Codex Cloud fanout for the o11ytsdb package — a browser-native time-series database for OpenTelemetry data.

## Objective

Design and implement a PromQL-subset query language with a streaming range-query executor that meets the performance target: **10K series × 1024 points queried in <100 ms**.

## Why this workstream exists

o11ytsdb has M1 (codec) complete and a baseline `ScanEngine` in `src/query.ts` that does label matching and simple aggregation. But it lacks:

- A proper query language parser (users currently construct `QueryOpts` objects by hand)
- Step-aligned range vector evaluation (`rate()`, `increase()`, `irate()`, `delta()`)
- Efficient group-by aggregation with streaming evaluation
- Subquery support or any composability

The existing `ScanEngine` returns raw data. We need a real executor.

## Mode

**implementation + benchmark**

## Required execution checklist

- You MUST read these files first:
  - `packages/o11ytsdb/PLAN.md` (full roadmap — especially M6)
  - `packages/o11ytsdb/src/query.ts` (existing ScanEngine)
  - `packages/o11ytsdb/src/types.ts` (QueryOpts, AggFn, QueryEngine interface)
  - `packages/o11ytsdb/src/column-store.ts` (ColumnStore — primary storage backend)
  - `packages/o11ytsdb/src/chunked-store.ts` (ChunkedStore)
  - `packages/o11ytsdb/src/stats.ts` (ChunkStats for block pruning)
  - `packages/o11ytsdb/bench/harness.ts` (benchmark infrastructure)
  - `packages/o11ytsdb/bench/vectors.ts` (test data generators)

- You MUST implement:
  1. A query parser that accepts a PromQL-like string syntax: `sum(rate(http_requests_total{job="api"}[5m])) by (status_code)`
  2. At minimum support: `rate()`, `increase()`, `sum()`, `avg()`, `min()`, `max()`, `count()`, `last()`, `histogram_quantile()`
  3. Step-aligned range vector evaluation (given start, end, step, evaluate at each step)
  4. A streaming executor that:
     - Uses block statistics (ChunkStats min_t/max_t) to skip irrelevant chunks
     - Processes series in streaming fashion (not loading all data into memory first)
     - Supports `group by` label aggregation
  5. Unit tests covering: parser edge cases, rate() with resets, step alignment, group-by correctness
  6. A benchmark in `bench/query.bench.ts` that measures:
     - Query parse time
     - 10K series × 1024 points range query throughput
     - Comparison: new executor vs baseline ScanEngine

- You MUST conform to existing interfaces in `src/types.ts` — implement `QueryEngine` interface
- You MUST export the new query engine from `src/index.ts`
- You MUST NOT add external dependencies (parser must be hand-written or use a tiny PEG, not a heavy library)

- After completing the required work, use your judgment to explore:
  - Subquery evaluation
  - Query plan optimization (predicate pushdown)
  - Approximate quantile sketches for histogram queries

## Deliverable

Write implementation at:
- `packages/o11ytsdb/src/parser.ts` — query language parser
- `packages/o11ytsdb/src/executor.ts` — streaming range-query executor
- `packages/o11ytsdb/bench/query.bench.ts` — query benchmarks
- `packages/o11ytsdb/src/query.test.ts` or similar — unit tests

Write a research memo at:
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/01-query-language-results.md`

The memo must include:
- Query parse time (ops/sec)
- Range query throughput (series×points/sec)
- Memory allocation per query
- Comparison vs ScanEngine baseline
- Recommendation: what syntax subset to ship in M6

## Constraints

- Ground everything in the actual repo code
- TypeScript only for this workstream (no WASM needed for query logic)
- No external parser generators or query libs — keep bundle size minimal
- Must work with all three storage backends (FlatStore, ChunkedStore, ColumnStore)
- Target: <5 KB gzipped for the parser + executor combined
