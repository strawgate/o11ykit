# OTLP Ingest Pipeline

You are handling one workstream inside a larger Codex Cloud fanout for the o11ytsdb package — a browser-native time-series database for OpenTelemetry data.

## Objective

Build a streaming OTLP JSON ingest pipeline that parses OpenTelemetry metrics export payloads, normalizes labels, and batch-inserts samples into the storage backends, targeting ≥200K samples/sec throughput.

## Why this workstream exists

o11ytsdb can store and query time-series data, but has no way to ingest real OpenTelemetry data. The M5 milestone requires:

- Parsing OTLP JSON (the format used by OTel collectors and exporters)
- Handling all metric types: gauge, sum (counter), histogram, summary, exponential histogram
- Label normalization (resource attributes → series labels, scope → series labels)
- Efficient batch insertion into storage backends
- This is the bridge between "database" and "usable product"

The repo already depends on `@otlpkit/otlpjson` (see package.json) which may provide OTLP type definitions.

## Mode

**implementation + benchmark**

## Required execution checklist

- You MUST read these files first:
  - `packages/o11ytsdb/PLAN.md` (M5 section)
  - `packages/o11ytsdb/src/types.ts` (StorageBackend interface, especially appendBatch)
  - `packages/o11ytsdb/src/column-store.ts` (ColumnStore — primary target for ingest)
  - `packages/o11ytsdb/src/chunked-store.ts` (ChunkedStore)
  - `packages/o11ytsdb/package.json` (check @otlpkit/otlpjson dependency)
  - `packages/otlpjson/src/` (explore what types/parsers already exist in the monorepo)
  - `packages/o11ytsdb/bench/harness.ts` (benchmark infrastructure)

- You MUST implement:
  1. **OTLP JSON Parser** (`src/ingest.ts`):
     - `ingestOtlpJson(payload: unknown, storage: StorageBackend): IngestResult`
     - Handle resource metrics → scope metrics → metrics → data points
     - Extract: metric name as `__name__`, resource attributes as labels, data point attributes as labels
     - For each data point: extract timestamp (nanos → bigint), value (as number)
     - Support metric types: gauge, sum, histogram (per-bucket), summary
  2. **Label Normalization**:
     - Flatten resource attributes + scope attributes + data point attributes into a single label map
     - Handle attribute value types (string, int, double, bool → string)
     - Configurable label prefix/filtering (e.g., drop `telemetry.sdk.*` labels)
  3. **Batch Insert**:
     - Group data points by series (same label set)
     - Use `appendBatch()` for efficient bulk insertion
     - Pre-sort by timestamp within each batch
  4. **Histogram Handling**:
     - For explicit-boundary histograms: create one series per bucket boundary (`le` label)
     - Create `_count` and `_sum` companion series
     - For exponential histograms: map to explicit buckets or store native
  5. **Unit tests**: parse a realistic OTLP JSON payload, verify correct series creation and sample values
  6. **Benchmarks** (`bench/ingest.bench.ts`):
     - Generate synthetic OTLP JSON payloads (100, 1K, 10K metrics)
     - Measure: parse time, label normalization time, batch insert time, total ingest throughput
     - Compare: ColumnStore vs ChunkedStore as ingest target

- You MUST include at least one realistic OTLP JSON test fixture (can be generated)
- You MUST handle malformed/partial payloads gracefully (return error counts, don't throw)

- After completing the required work, explore:
  - Streaming JSON parsing (for large payloads, avoid parsing the whole string)
  - Whether a custom fast-path parser for the known OTLP schema beats JSON.parse
  - Delta temporality handling (converting delta → cumulative for counters)

## Deliverable

Write implementation at:
- `packages/o11ytsdb/src/ingest.ts` — OTLP ingest pipeline
- `packages/o11ytsdb/bench/ingest.bench.ts` — ingest benchmarks
- `packages/o11ytsdb/test/ingest.test.ts` — unit tests
- `packages/o11ytsdb/test/fixtures/otlp-sample.json` — test fixture

Write a research memo at:
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/04-otlp-ingest-results.md`

The memo must include:
- Ingest throughput (samples/sec) for each storage backend
- Parse vs normalize vs insert time breakdown
- Memory allocation per ingest batch
- Histogram expansion factor (1 histogram → N series)
- Recommendation: optimal batch size for browser context

## Constraints

- Ground everything in the actual repo code
- Use @otlpkit/otlpjson types if they exist in the monorepo; otherwise define minimal types
- No external JSON parsing libraries — use native JSON.parse or custom scanner
- Must handle both nanosecond and millisecond timestamps
- Must be tree-shakeable (no side effects at module level)
