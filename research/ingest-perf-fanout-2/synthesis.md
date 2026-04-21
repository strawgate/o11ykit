# Ingest Performance Fanout-2: Synthesis

## Overview

Two experiments ran as Codex Cloud tasks with best-of-N attempts:

| Experiment | Attempts | Convergence | Recommendation |
|-----------|----------|-------------|----------------|
| Fused quantize-on-encode (Rust WASM) | 3/3 converged | Same 9-file changeset | **Defer** |
| Streaming OTLP decode (skip JSON.parse) | 2/2 converged | Same 5-file changeset | **Abandon** |

## Experiment 1: Fused Quantize-on-Encode

### What was built
- New Rust functions: `encode_values_alp_with_quantize_and_stats` + batch variant
- TS bindings extending `ValuesCodec` with optional fused methods
- Column-store integration: defers quantization to freeze when fused path available
- Round-trip tests + benchmark harness

### Results (640-sample chunks, 500 iterations)

| Vector | Separate (M pts/s) | Fused (M pts/s) | Speedup |
|--------|-------------------|-----------------|---------|
| gauge_2dp | 35.91 | 36.04 | **+0.35%** |
| counter_mono | 37.21 | 38.18 | **+2.62%** |

### Verdict: **Defer**

The fused path works correctly but the speedup is <3% — well below the 10% threshold. The WASM boundary crossing overhead we hoped to eliminate is already negligible at these chunk sizes (640 samples). The optimization is architecturally clean and could be revisited if chunk sizes shrink or encode frequency increases, but there's no measured win to ship today.

## Experiment 2: Streaming OTLP Decode

### What was built
Both attempts implemented Option A (SAX-style tokenizer):
- Attempt 1: Minimal generic JSON tokenizer (~220 LOC), delegates to existing tree walk
- Attempt 2: More ambitious OTLP-schema-aware scanner (~860 LOC), direct extraction for gauge/sum

### Results (10K metrics, p50 latency)

| Attempt | Approach | String p50 | Current p50 | Delta |
|---------|----------|-----------|-------------|-------|
| 1 (selected) | Generic tokenizer + tree walk | 203 ms | 82 ms | **2.47× slower** |
| 2 | OTLP-aware scanner | 47.6 ms | 36.8 ms | **29.6% slower** |

### Verdict: **Abandon**

V8's native `JSON.parse()` is implemented in highly optimized C++ with SIMD acceleration. No TypeScript tokenizer can compete. Even the more ambitious attempt 2 (860 LOC of custom parser) was still 30% slower. The only viable path would be a WASM-compiled simdjson, which would add significant binary size and dependency complexity for a marginal gain on the string path — which most browser callers don't even hit (they use `fetch().json()`).

## Where This Leaves Us

### Current performance stack
| PR | Optimization | Measured impact |
|----|-------------|----------------|
| #110 | WASM SIMD codecs + worker pipeline | 119K → 1.31M pts/s (11×) |
| #131 | Numeric fingerprints, fast-path labels | 276K → 845K pts/s (3×) |
| #135 | Batch multi-series worker messages | 5.8× main-thread prep |

### What's been ruled out
- Fused quantize-on-encode: <3% gain (not worth shipping)
- TS streaming JSON parser: 30-150% slower than native JSON.parse
- WASM ingest (from earlier fanout): 3-4× slower than TS currently

### Remaining optimization surface
The remaining time breakdown for 10K metrics (pre-parsed object):
- Tree walk + fingerprinting: ~7ms (already heavily optimized)
- Worker batch overhead: ~0.11ms (already optimized)
- Storage (appendBatch + freeze): depends on workload, not on hot ingest path

**We've reached diminishing returns on the ingest parse/protocol path.** The low-hanging fruit has been harvested across 3 PRs and 2 experiment rounds.

### Possible future directions (not recommended now)
1. **WASM simdjson** for string-input callers — only if string inputs become the dominant use case
2. **Protobuf OTLP** instead of JSON — would eliminate JSON.parse entirely, but requires protocol change
3. **Schema-specialized codegen** — auto-generate type-specific parsers (deferred from earlier research, high complexity)
