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
  1. **OTLP JSON Parser** (`src/ingest.ts`): `ingestOtlpJson(payload: unknown, storage: StorageBackend): IngestResult`
  2. **Label Normalization**: flatten resource + scope + data point attributes
  3. **Batch Insert**: group data points by series, use `appendBatch()`
  4. **Histogram Handling**: per-bucket series with `le` label, `_count` and `_sum` companions
  5. **Unit tests** with realistic OTLP JSON fixture
  6. **Benchmarks** (`bench/ingest.bench.ts`): synthetic OTLP payloads at 100/1K/10K metrics

- You MUST handle malformed/partial payloads gracefully (return error counts, don't throw)

- After completing the required work, explore:
  - Streaming JSON parsing for large payloads
  - Custom fast-path parser for known OTLP schema
  - Delta temporality handling

## Deliverable

Write implementation at:
- `packages/o11ytsdb/src/ingest.ts` — OTLP ingest pipeline
- `packages/o11ytsdb/bench/ingest.bench.ts` — ingest benchmarks
- `packages/o11ytsdb/test/ingest.test.ts` — unit tests
- `packages/o11ytsdb/test/fixtures/otlp-sample.json` — test fixture

Write a research memo at:
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/04-otlp-ingest-results.md`

## Constraints

- Use @otlpkit/otlpjson types if they exist; otherwise define minimal types
- No external JSON parsing libraries
- Must handle both nanosecond and millisecond timestamps
- Must be tree-shakeable
