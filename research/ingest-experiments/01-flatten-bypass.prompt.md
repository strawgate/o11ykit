# Experiment: bypass flattenAttributes allocation in OTLP ingest hot path

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Eliminate the intermediate `Record<string, unknown>` allocation from `flattenAttributes()` in the OTLP metrics ingest hot path by adding a zero-allocation iteration API to `@otlpkit/otlpjson` and using it in `packages/o11ytsdb/src/ingest.ts`.

## Why this workstream exists

After three rounds of ingest optimization (10× speedup: 119K → 1.20M pts/sec for 10K gauge points), V8 CPU profiling shows `flattenAttributes` from `@otlpkit/otlpjson` accounts for ~9% of parse-phase CPU time. It allocates a `Record<string, unknown>` per call that is immediately iterated and discarded. The ingest code only needs to iterate key/value pairs — it never stores the flattened object.

The current call chain is:
```
OtlpKeyValue[] → flattenAttributes() → Record<string,unknown> → Object.keys() loop → prefixedKey() + attributeValueToLabel()
```

We also have a reference-identity cache (`cachedFlattenAttributes` in ingest.ts) that helps when the same `OtlpKeyValue[]` array is reused across points, but cache misses still pay the full allocation cost.

## Mode

implementation

## Required execution checklist

- You MUST read these files before changing anything:
  - `packages/otlpjson/src/index.ts` — find the `flattenAttributes` function and understand its recursive structure (nested arrays, maps, kvlists)
  - `packages/o11ytsdb/src/ingest.ts` — find all call sites of `cachedFlattenAttributes`, `flattenAttributes`, `computePointAttrsHash`, and `buildSnapshotLabels` to understand how flattened attributes are consumed
  - `packages/o11ytsdb/src/types.ts` — understand the Labels type
- You MUST add a new zero-allocation iteration function to `packages/otlpjson/src/index.ts`. Two options to evaluate:
  1. Callback-based: `forEachAttribute(attrs, (key, value) => void)` — avoids generator overhead
  2. Inline iteration: just export a helper that the caller uses in a for-loop without allocating the intermediate Record
- You MUST update the ingest.ts hot path to use the new API instead of `flattenAttributes()` / `cachedFlattenAttributes()` for the two consumption sites:
  1. `computePointAttrsHash()` — iterates attrs to hash them into the fingerprint
  2. `buildSnapshotLabels()` — iterates attrs to build the label Map for new series
- You MUST ensure all existing tests pass: `npx vitest run packages/o11ytsdb/test/` and `npx vitest run packages/otlpjson/test/` (if tests exist)
- You MUST run the ingest benchmark and report before/after numbers:
  - Build: `./node_modules/.bin/tsc -b` from repo root
  - Build bench: `cd packages/o11ytsdb && ../../node_modules/.bin/tsc -p bench/tsconfig.json`
  - Run: `cd packages/o11ytsdb && node --expose-gc bench/run.mjs ingest`
  - Report p50 and p99 for ingest_10000_metrics
- You MUST write results to `research/ingest-experiments/01-flatten-bypass-results.md`

After completing the required work, use your judgment to explore whether the reference-identity cache (`cachedAttrRef`/`cachedAttrResult`) is still needed or can be simplified with the new approach.

## Required repo context

Read at least these:

- `packages/otlpjson/src/index.ts` — the flattenAttributes implementation
- `packages/o11ytsdb/src/ingest.ts` — the full ingest pipeline (all functions)
- `packages/o11ytsdb/src/types.ts` — Labels type definition

Key context about the current optimization state:
- `computePointAttrsHash(baseHash, pointAttrs)` iterates `Object.keys(pointAttrs)` to incrementally hash attribute key/value pairs using FNV-1a
- `buildSnapshotLabels(baseEntries, metricName, pointAttrs)` iterates `Object.keys(pointAttrs)` to build a `Map<string,string>` — only called once per unique series (~256 times for 10K points)
- The hot path is `computePointAttrsHash` (called per point = 10K times). `buildSnapshotLabels` is cold.
- `prefixedKey(ATTR_PREFIX_POINT, key)` caches the sanitized+prefixed key string
- `attributeValueToLabel(value)` converts the value to string

## Deliverable

1. Modified `packages/otlpjson/src/index.ts` with new iteration API
2. Modified `packages/o11ytsdb/src/ingest.ts` using the new API
3. Results at `research/ingest-experiments/01-flatten-bypass-results.md` with benchmark numbers

## Constraints

- Do NOT change the public API semantics of `flattenAttributes` — it should still exist for other callers
- Do NOT change any test fixture data
- Do NOT introduce new dependencies
- The new iteration API must handle the same recursive attribute types as `flattenAttributes` (string, int, double, bool, array, kvlist, bytes)
- Keep the `prefixedKey` and `attributeValueToLabel` functions — just feed them directly from the iterator instead of via an intermediate Record

## Success criteria

- All tests pass
- Benchmark shows measurable improvement (even 3-5% is meaningful at this stage)
- The `flattenAttributes` call is eliminated from the per-point hot path
- Results file documents the before/after numbers and approach taken
