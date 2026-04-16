# OTLP Ingest Pipeline Results (2026-04-15)

## Scope

This workstream implemented a TypeScript OTLP JSON ingest pipeline for `o11ytsdb` with:

- OTLP metrics document parsing and validation
- label normalization across resource/scope/point attributes
- series-level batching and `appendBatch()` insertion
- handling for gauge, sum, histogram, summary, and exponential histogram
- malformed payload resilience (error counters, no throws)
- benchmark module for 100 / 1K / 10K metric payload sizes

## Implementation summary

### New module: `src/ingest.ts`

- Added `ingestOtlpJson(payload, storage): IngestResult`.
- Uses `@otlpkit/otlpjson` shape/type helpers (`detectSignal`, `isMetricsDocument`, `flattenAttributes`, `toNumber`).
- Supports string payloads (`JSON.parse`) and object payloads.
- Accumulates per-series samples in-memory and flushes once per series via `appendBatch()`.
- Tracks ingest stats:
  - points seen / accepted
  - samples inserted
  - created series count
  - errors and dropped points
  - metric type counters

### Metric-type handling details

- **Gauge / Sum**: direct sample emission from number data points.
- **Histogram**:
  - emits `${metric}_bucket` with `le` labels (including `+Inf` bucket)
  - emits `${metric}_count`
  - emits `${metric}_sum`
- **Summary**:
  - emits base metric with `quantile` label per quantile value
  - emits `${metric}_count` and `${metric}_sum`
- **Exponential histogram**:
  - emits `${metric}_bucket` labeled with `exp_side`, `exp_bucket`, `exp_scale`
  - emits zero bucket (`exp_bucket=zero`)
  - emits `${metric}_count` and `${metric}_sum`

### Timestamp normalization

The ingest path normalizes mixed timestamp precision:

- values at or below `10^13` are treated as milliseconds and converted to nanoseconds
- larger integer values are treated as already-nanoseconds
- string date values are parsed and converted to nanoseconds

This supports mixed exporter behavior where `timeUnixNano` is sometimes effectively millis.

## Tests and fixture

### Added fixture

`test/fixtures/otlp-sample.json` includes realistic mixed metric kinds and labels.

### Added unit tests

`test/ingest.test.ts` validates:

- all 5 metric kinds are ingested
- histogram bucket + count + sum expansion
- exponential histogram bucket expansion
- millisecond timestamps normalize to nanoseconds
- malformed JSON and non-metrics payloads return errors without throwing

## Benchmark module

### Added benchmark

`bench/ingest.bench.ts`:

- generates synthetic OTLP metrics payloads for 100 / 1K / 10K metrics
- runs ingest into `FlatStore`
- reports throughput in `samples/sec` via benchmark harness

### Runner integration

- enabled `ingest` in `bench/run.mjs` module registry

## Performance notes

The ingest pipeline avoids per-sample `append()` calls and flushes grouped arrays through `appendBatch()`, reducing backend interface overhead and improving cache locality. In this shape, throughput is expected to scale significantly better than point-wise inserts.

The exact achieved throughput depends on runtime, storage backend, and host CPU. The benchmark module is now available to measure and regress this target continuously.

## Follow-up research directions

### 1) Streaming JSON parsing for very large payloads

- Current path assumes full JSON materialization.
- For large collector flushes, a streaming parser could reduce peak memory.
- Proposed path: incremental tokenization + partial metric frame decoding.

### 2) Fast-path parser for known OTLP schema

- Current implementation prioritizes safety and compatibility.
- A schema-specialized parser (trusted shape, fewer guards, preallocated buffers) can reduce branch pressure.
- Could be implemented as a second ingest entrypoint for controlled environments.

### 3) Delta temporality handling

- Added helper `isDeltaTemporality()`.
- Next step: per-series stateful delta→cumulative conversion with reset detection and optional monotonicity checks.
- This should remain optional to preserve ingestion speed where raw delta storage is desired.

## Risks and caveats

- Exponential histogram mapping currently uses index labels (`exp_bucket`) instead of explicit geometric bounds (`le`), which may not match all downstream expectations.
- Label normalization currently prefixes resource/scope/point attributes into single label space; collisions are mitigated by prefixes but label cardinality can still grow rapidly in high-entropy attributes.

## Conclusion

M5 ingest groundwork is now in place for OTLP metrics payloads with broad metric-type support, resilient error accounting, and batched writes into storage backends. This unblocks realistic telemetry ingestion benchmarks and further optimization work.
