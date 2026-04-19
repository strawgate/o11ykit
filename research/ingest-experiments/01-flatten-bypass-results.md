# Experiment 01: bypass `flattenAttributes` allocation in ingest hot path

## Summary

Implemented a zero-intermediate-object attribute iteration API in `@otlpkit/otlpjson` and rewired `o11ytsdb` ingest hashing/label construction to consume OTLP key-value arrays directly.

### Code changes

- Added `forEachAttribute(attributes, fn)` to `packages/otlpjson/src/index.ts`.
  - Iterates top-level `OtlpKeyValue[]` entries.
  - Converts each OTLP `AnyValue` via existing recursive `attributeValueToJs` (arrays, kvlists, bytes, numeric/bool/string, null semantics preserved).
  - Avoids allocating the intermediate flattened `Record<string, unknown>` when callers only need iteration.
- Updated `packages/o11ytsdb/src/ingest.ts` hot-path consumers:
  - `computePointAttrsHash(baseHash, pointAttrs)` now accepts `readonly OtlpKeyValue[] | undefined` and hashes via `forEachAttribute`.
  - `buildSnapshotLabels(baseEntries, metricName, pointAttrs)` now accepts `readonly OtlpKeyValue[] | undefined` and builds labels via `forEachAttribute`.
  - Removed `cachedFlattenAttributes` + `cachedAttrRef` + `cachedAttrResult` identity cache (no longer needed for the hot path).
  - Point ingest paths now pass `point.attributes` directly.
- Added `forEachAttribute` coverage in `packages/otlpjson/test/index.test.ts`.

## Benchmark setup

Commands executed:

1. `./node_modules/.bin/tsc -b`
2. `cd packages/o11ytsdb && ../../node_modules/.bin/tsc -p bench/tsconfig.json`
3. `cd packages/o11ytsdb && node --expose-gc bench/run.mjs ingest`

## Results

### Before (baseline)

From `packages/o11ytsdb/bench/results/ingest-1776568576856.json`:

- `ingest_10000_metrics` p50: **633.27K samples/sec**
- `ingest_10000_metrics` p99: **400.54K samples/sec**

### After (flatten bypass)

From `packages/o11ytsdb/bench/results/ingest-1776568799077.json`:

- `ingest_10000_metrics` p50: **711.13K samples/sec**
- `ingest_10000_metrics` p99: **518.42K samples/sec**

### Delta (`ingest_10000_metrics`)

- p50: **+12.3%** (`633.27K` → `711.13K`)
- p99: **+29.4%** (`400.54K` → `518.42K`)

## Notes on attribute reference-identity cache

With direct iteration over `point.attributes`, the prior `cachedFlattenAttributes` optimization no longer provides value in the hot loop, because we no longer materialize a flattened object per point. The cache was removed to simplify code and avoid extra branch/state in ingest.
