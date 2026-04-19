# Experiment: schema-specialized ingest codegen

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Explore whether generating a specialized ingest function at runtime for known OTLP metric shapes can meaningfully reduce parse overhead compared to the current generic ingest pipeline.

## Why this workstream exists

After three rounds of optimization (10× speedup to 1.20M pts/sec), the V8 profile shows 40% of parse time is in `ingestNumberPoints` — the generic per-point loop that reads properties, computes hashes, and dispatches to the pending map. For steady-state workloads (same metrics every scrape), the metric names, attribute keys, label counts, and even fingerprints are identical across batches. The current code rediscovers all of this every time.

The hypothesis: if we analyze the first batch's shape and generate a tight function that hardcodes the known structure, subsequent batches could skip most of the generic work.

## Mode

prototype

## Required execution checklist

- You MUST read these files first:
  - `packages/o11ytsdb/src/ingest.ts` — understand the full ingest pipeline, especially `ingestMetricsDocument`, `ingestNumberPoints`, `computePointAttrsHash`, `buildSnapshotLabels`, `toFingerprint`, `fnvHashEntry`
  - `packages/o11ytsdb/src/types.ts` — StorageBackend interface
  - `packages/o11ytsdb/bench/ingest.bench.ts` — understand the benchmark payload structure
- You MUST implement a prototype that:
  1. Analyzes a payload to extract its "shape" (metric names, types, attribute key sets, label counts)
  2. Generates a specialized ingest function for that shape (using `new Function()` or a hand-written template approach)
  3. Falls back to the generic path when the shape doesn't match
- The specialized function should at minimum hardcode:
  - Pre-computed `baseHash` and `metricHash` values (no per-point hashing of base labels)
  - Pre-computed fingerprints for each unique attribute key combination
  - Direct property access instead of generic iteration where possible
- You MUST benchmark the specialized path vs the generic path using the existing benchmark:
  - Build: `./node_modules/.bin/tsc -b` from repo root
  - For the prototype, you may write a custom benchmark script at `research/ingest-experiments/03-codegen-bench.mjs` that:
    - Builds the same 10K gauge payload as the main benchmark
    - Runs the generic `parseOtlpToSamples` as baseline
    - Runs the specialized function
    - Reports p50 throughput for both
- You MUST write results to `research/ingest-experiments/03-codegen-results.md`

After completing the required work, explore:
- How stable real OTLP payloads are across scrapes (do shapes actually repeat?)
- Whether the `new Function()` approach causes V8 deoptimization
- What the shape detection overhead is relative to the savings

## Required repo context

Read at least these:

- `packages/o11ytsdb/src/ingest.ts`
- `packages/o11ytsdb/src/types.ts`
- `packages/o11ytsdb/bench/ingest.bench.ts`

Key context about the current state:
- The benchmark payload has 32 gauge metrics × ~312 points each = 10K points, with 2 point attributes (`host.name`, `cpu`)
- 256 unique series (32 metrics × 8 cpu values, but host varies within cpu groups)
- Resource attributes: `service.name`, `service.instance.id`
- Scope: `name=bench`, `version=0.1`
- The generic path costs: `fnvHashEntry` per label (18% of profile), `normalizeTimestamp` (11%), `computePointAttrsHash` (1%), `toFingerprint` (5%)
- `prefixedKey()` already caches sanitized key strings
- The `pending` map uses string fingerprints as keys

## Deliverable

1. Prototype at `research/ingest-experiments/03-codegen-prototype.mjs` (or `.ts` if you prefer)
2. Benchmark at `research/ingest-experiments/03-codegen-bench.mjs`
3. Results at `research/ingest-experiments/03-codegen-results.md` with:
   - Throughput numbers: generic vs specialized
   - Shape detection overhead
   - Analysis of what the codegen actually eliminates
   - Honest assessment of whether this is worth productionizing

## Constraints

- Do NOT modify `ingest.ts` for this experiment — write the prototype as a standalone module that imports from the built dist
- Do NOT use `eval()` — use `new Function()` if generating code dynamically
- Keep the prototype focused on gauge metrics (the benchmark workload) — don't try to handle all 5 metric types
- The prototype must produce the same `ParsedOtlpResult` as the generic path (verify correctness)

## Success criteria

- Working prototype that produces correct results for the benchmark payload
- Clear benchmark comparison (generic vs specialized)
- Honest assessment: is the speedup worth the complexity? What % of real workloads would benefit?
- If the answer is "not worth it", that's a valid and useful result

## Decision style

End with a clear recommendation: ADOPT (worth productionizing), DEFER (interesting but not enough impact), or REJECT (fundamental issues).
