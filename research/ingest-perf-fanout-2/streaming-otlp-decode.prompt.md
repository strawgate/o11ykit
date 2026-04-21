# Streaming OTLP Metrics Decode — Skip JSON.parse

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Prototype a streaming/incremental OTLP metrics decoder that avoids `JSON.parse()` for the full payload, and benchmark it against the current `parseOtlpToSamples()` path.

## Why this workstream exists

Profiling the ingest pipeline for 10K gauge metrics (2.1 MB JSON payload) shows:

| Phase | Median time | % of total |
|-------|------------|------------|
| JSON.parse alone | 12.06 ms | 64% |
| Tree walk (pre-parsed object) | 6.87 ms | 37% |
| Full path (JSON string → samples) | 18.74 ms | 100% |

`JSON.parse()` is now **2/3 of the parse cost** for string inputs. The tree walk has already been heavily optimized (numeric fingerprints, cached attribute hashing, fast-path label sanitization).

Current overall throughput: 852K pts/sec (10K metrics). Target: push past 1M pts/sec.

**Important context**: In browser deployments, callers typically use `fetch().json()` which gives a pre-parsed object (skipping JSON.parse). So the tree walk (6.87ms) is the realistic bottleneck for browser use. But for Node.js/worker scenarios receiving raw JSON strings, JSON.parse dominates.

We want to explore whether a SAX-style tokenizer or WASM-accelerated JSON parser could beat V8's native `JSON.parse()` for this specific OTLP structure.

## Mode

prototype + benchmark

## Required execution checklist

- You MUST read `packages/o11ytsdb/src/ingest.ts` to understand `parseOtlpToSamples()`, `ingestMetricsDocument()`, `ingestNumberPoints()`, and the full tree-walk pipeline.
- You MUST read `packages/otlpjson/src/index.ts` to understand the OTLP type definitions, `flattenAttributes()`, `forEachAttribute()`, `detectSignal()`, and the type guards.
- You MUST read `packages/o11ytsdb/bench/ingest.bench.ts` to understand how ingest benchmarks work.
- You MUST read `packages/otlpjson/test/fixtures.ts` to understand the OTLP JSON structure.

### Prototype requirements

Implement ONE of these approaches (pick the most promising, or try both if time permits):

#### Option A: SAX-style State Machine Tokenizer

Build a custom tokenizer in TypeScript that:
1. Scans the JSON string character-by-character (or chunk-by-chunk)
2. Tracks nesting context: resourceMetrics → scopeMetrics → metrics → gauge/sum/histogram → dataPoints
3. Accumulates attributes from resource, scope, and point levels
4. Emits a callback for each data point with `{ resourceLabels, scopeLabels, metricName, metricType, pointTimestamp, pointValue, pointAttributes }`
5. Feeds directly into the fingerprint+pending-map logic from `ingestNumberPoints()`

Key insight: OTLP JSON has a predictable structure. We don't need a general-purpose JSON parser — we can hardcode the OTLP schema navigation and only allocate for the values we extract.

#### Option B: Partial Parse with Lazy Attribute Extraction

Use V8's `JSON.parse()` but with a **reviver function** or **post-parse lazy proxy** that:
1. Defers attribute array flattening until first access
2. Skips parsing of unused fields (description, unit, exemplars)
3. Uses a custom reviver to intercept specific keys

This is less ambitious but might capture some wins with less risk.

#### Option C: WASM JSON Parser

If there's a WASM-compiled JSON parser (like simdjson compiled to WASM) that could be integrated:
1. Research available WASM JSON parsers (simdjson-wasm, simd-json, etc.)
2. Evaluate whether they can beat V8's native JSON.parse for 2MB payloads
3. If promising, prototype integration

### Benchmark requirements

- You MUST benchmark the prototype against current `parseOtlpToSamples()` for:
  - 100 metrics (small payload)
  - 1,000 metrics (medium payload)
  - 10,000 metrics (large payload)
- Measure both string input AND pre-parsed object input paths
- Report p50 latency in milliseconds for each
- Report samples/sec throughput
- Report memory allocation delta (heap + arrayBuffers) if measurable

### Testing requirements

- The prototype MUST produce identical `Map<number, PendingSeriesSamples>` output as the current parser for the same input
- Verify with at least the test fixtures in `packages/otlpjson/test/fixtures.ts`
- Verify with the synthetic 10K-metric payload from the benchmark

After completing the required work, use your judgment to explore whether the approach could also benefit histogram/summary/exponentialHistogram metric types (not just gauge/sum).

## Required repo context

Read at least these:
- `packages/o11ytsdb/src/ingest.ts` — Core parse + ingest pipeline (864 lines)
- `packages/otlpjson/src/index.ts` — OTLP types, flattenAttributes, forEachAttribute
- `packages/otlpjson/test/fixtures.ts` — Real OTLP JSON payloads
- `packages/o11ytsdb/bench/ingest.bench.ts` — Ingest benchmark harness
- `packages/o11ytsdb/bench/harness.ts` — Benchmark suite framework
- `packages/o11ytsdb/src/types.ts` — Core types

Prior optimization context (already applied to main):
- Numeric fingerprints replaced string Map keys (PR #131)
- Fast-path `sanitizeLabelKey` uses char-code scan before regex
- `computePointAttrsHash` caches consecutive same-attrs points
- Worker batch protocol sends flat-packed arrays (PR #135, in review)

## Deliverable

Write the prototype implementation in a new file:

`packages/o11ytsdb/src/streaming-ingest.ts` (or similar)

And write a benchmark + results summary at:

`research/ingest-perf-fanout-2/streaming-otlp-decode-results.md`

The summary should include:
- Which approach was tried (A, B, C, or multiple)
- Benchmark table: current vs prototype for 100/1K/10K metrics
- Memory allocation comparison
- Code complexity assessment (lines of code, maintainability risk)
- Recommendation: ship, iterate, or abandon
- What evidence would change the recommendation

## Constraints

- Do NOT modify the existing `parseOtlpToSamples()` — write a NEW function alongside it
- Do NOT add external npm dependencies — this must be zero-dep like the rest of the package
- The prototype must handle the same OTLP metric types as the current parser (gauge, sum, histogram, summary, exponentialHistogram)
- If the prototype only handles gauge/sum initially, that's fine — note what's missing
- Ground everything in actual benchmark measurements
- Be honest about complexity: if the prototype is 500+ lines of fragile state machine code for a 20% speedup, say so
- Distinguish `required evidence` (throughput comparison) from `optional exploration` (GC pressure, streaming from fetch)

## Success criteria

- A working prototype that produces correct output for gauge and sum metrics
- Benchmark numbers comparing prototype vs current for 3 payload sizes
- Clear recommendation with evidence
- Honest complexity assessment

## Decision style

End with a decisive recommendation:
- **Ship**: Prototype is faster, correct, and maintainable. Worth polishing into production code.
- **Iterate**: Shows promise but needs more work. Specify exactly what needs to change.
- **Abandon**: Not worth the complexity. V8's JSON.parse is hard to beat. Move optimization effort elsewhere.

State what measured speedup would justify the added code complexity (e.g., "Worth it if >30% faster for 10K metrics").
