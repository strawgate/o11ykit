# Fanout Wave 1 Synthesis — o11ytsdb R&D

**Date**: 2026-04-15
**Tasks**: 5 workstreams, 11 total attempts, all completed
**Branch**: `feat/o11ytsdb-rd-fanout`

## Executive Summary

All 5 Codex Cloud tasks completed with usable outputs. Two workstreams (interner/postings, OTLP ingest) are near ship-ready. Two (query language, worker isolation) are strong prototypes needing optimization. One (compression R&D) produced valuable infrastructure but needs real-world data validation before a ship decision.

| # | Workstream | Grade | Verdict | Next Step |
|---|-----------|-------|---------|-----------|
| 01 | Query Language | B+ | Usable prototype | Optimize for <100ms gate |
| 02 | Interner + Postings | A- | Ship-ready (TS) | Merge TS; WASM deferred |
| 03 | Compression R&D | B | NEEDS_REAL_DATA | Collect real Prometheus corpus |
| 04 | OTLP Ingest | A | Ship-ready | Merge after review |
| 05 | Worker Isolation | A | USE_HYBRID | Merge protocol + transferable default |

## Workstream Details

### 01 — Query Language (3 attempts)

**What was built**: Hand-written recursive-descent PromQL-subset parser + streaming range-query executor.

**Syntax supported**: `sum(rate(http_requests_total{job="api"}[5m])) by (status_code)`, including `rate()`, `increase()`, `irate()`, `delta()`, `sum/avg/min/max/count/last()`, `histogram_quantile()`.

**Key results**:
- Parser: 234–321 LOC, zero dependencies, 106K–380K ops/sec parse throughput
- Executor: 481–502 LOC, streaming window evaluation with chunk-level pruning
- Best attempt: 2.91× speedup vs ScanEngine baseline (70.9M pts/sec)
- Implements `QueryEngine` interface, exported from `index.ts`

**Gap**: None of the attempts reach the M6 <100ms target for 10K×1024 (best: 144ms). Buffer pooling, window fusion, and accumulator reuse are the identified optimization paths.

**Convergence**: Strong agreement on architecture across attempts 1/3/4. Attempt 2 was an outlier (0.66× baseline — allocation overhead).

**Recommendation**: Cherry-pick attempt 3's executor as the starting point. Plan a follow-up optimization pass for the M6 gate.

### 02 — Interner + Postings (3 attempts)

**What was built**: FNV-1a string interner backed by typed arrays + MemPostings inverted index with galloping set intersection.

**Key results**:
- Intern: 953K ops/sec, resolve: 6.01M ops/sec
- Galloping intersection: 7.8× speedup at 100 items, **90.8× at 10K items**
- Memory savings: **49.67× compression** (10K series with deduplicated labels)
- All three storage backends (FlatStore, ChunkedStore, ColumnStore) integrated
- Rust WASM interner written but not CI-verified (missing wasm32 target)

**Convergence**: All 3 attempts converge on identical algorithms (FNV-1a, open addressing, galloping). Refinements were code clarity only.

**Recommendation**: **Ship the TS interner + postings immediately**. This is the highest-impact deliverable — eliminates the linear-scan bottleneck and cuts label memory by 50×. WASM interner can follow once CI supports wasm32.

### 03 — Compression R&D (2 attempts)

**What was built**: All 6 codec tags (CONSTANT, CONST_DELTA, RLE_DELTA, INT_DELTA_BITPACK, INT_DELTA_BITPACK_PATCHED, GORILLA_XOR) + change bitmap layer + GCD counter trick + adaptive selector.

**Key results**:
- Constant/constantRate vectors: 0.016–0.037 B/sample (excellent)
- Integer counters: 0.525 B/sample (meets target)
- Aggregate across all 11 vectors: **1.67–1.69 B/sample** (misses 0.5 target)
- High-entropy and spiky vectors force Gorilla fallback (6.5–7.2 B/sample), pulling average up

**Why the gap**: Synthetic test vectors include 5 high-entropy/noisy patterns that are unrepresentative of real monitoring data. Real Prometheus scrapes are ~60-80% integer counters and low-change gauges — exactly where the adaptive codecs excel.

**Convergence**: Attempts agree on codec implementations. Diverge on selector heuristic (size-only vs multi-factor). GCD trick implemented but under-utilized by the selector.

**Recommendation**: `NEEDS_REAL_DATA`. The codecs are solid and lossless-verified. Ship decision requires running the adaptive pipeline against a real Prometheus TSDB WAL dump to get a weighted compression ratio.

### 04 — OTLP Ingest (2 attempts)

**What was built**: Streaming OTLP JSON ingest pipeline handling all 5 metric types (gauge, sum, histogram, summary, exponential histogram).

**Key results**:
- All metric types fully implemented with correct Prometheus-convention expansion (histogram → `_bucket`/`_count`/`_sum`)
- Label normalization: resource → `resource.*`, scope → `scope.*`, data point → `attr.*`
- Batch insertion via `appendBatch()` (no per-sample overhead)
- Graceful error handling: returns `IngestResult` with error/dropped counts, never throws
- Comprehensive test fixtures covering all 5 types + malformed payloads

**Convergence**: High. Both attempts converge on identical core logic; attempt 2 adds explicit `otel.metric_type` labels.

**Recommendation**: **Ship after review**. Clean, well-tested, handles all OTLP metric types. Minor caveats: exponential histogram bucket representation and delta temporality conversion deferred.

### 05 — Worker Isolation (1 attempt)

**What was built**: Typed message protocol + worker runtime (ColumnStore + ScanEngine) + main-thread async client + transfer strategy benchmarks.

**Key results**:
- Transferable: 0.705ms RTT @ 1M samples (vs structured clone: 116.9ms)
- SharedArrayBuffer: 0.642ms RTT @ 1M samples (requires COOP/COEP)
- Structured clone: O(n) cost, unusable at scale
- Protocol: Fully typed envelopes with numeric ID correlation
- End-to-end proof: ingest 2K samples → query → validate

**Recommendation**: `USE_HYBRID` — default to Transferable (works everywhere), optional SAB when available. Ship the protocol and client as-is.

## Integration Plan

### Phase 1: Immediate merges (no conflicts)

1. **02-interner-postings** → cherry-pick TS implementation. Updates all 3 storage backends. No overlap with other workstreams.
2. **04-otlp-ingest** → cherry-pick `src/ingest.ts` + tests. Depends on storage backends (compatible).
3. **05-worker-isolation** → cherry-pick protocol + client + worker entry point. Orthogonal to other changes.

### Phase 2: Optimization pass

4. **01-query-language** → cherry-pick parser + executor. Follow up with buffer pooling to hit <100ms. Must coordinate with interner (label matching should use postings).

### Phase 3: Validation needed

5. **03-compression-rd** → Hold for real-data validation. Codec implementations ready; selector needs tuning once we have a representative corpus.

## Overlap and Conflict Risk

| Workstream pair | Conflict risk | Notes |
|----------------|:---:|---|
| 02 ↔ 01 | LOW | Query should use postings for label matching; straightforward integration |
| 02 ↔ 04 | NONE | Ingest calls `getOrCreateSeries()` which already uses interner after 02 merge |
| 02 ↔ 05 | NONE | Worker wraps storage; interner is internal to storage backends |
| 03 ↔ all | NONE | Codec-adaptive is additive; doesn't modify existing codec interface |
| 01 ↔ 05 | LOW | Worker needs to forward query requests; executor must be worker-compatible |

## Missing from fanout

- No attempt wrote a WASM interner that compiled and ran (CI env limitation)
- No real-world Prometheus/OTel data tested (only synthetic vectors)
- No attempt addressed the `packages/o11ytsdb/PLAN.md` M4 (Chunk Store) milestone directly — the chunked/column stores were modified but not redesigned
- Benchmark numbers are from Codex sandbox, not our CI hardware — expect different absolute values
