# Octo11y OTLP Semantic Conventions

Benchkit-specific semantic conventions layered on top of OTLP metrics.

This contract ensures that benchmark data from different producers can be
aggregated, compared, and rendered consistently.

## Goals

These conventions must support:

- code benchmarks
- workflow benchmarks
- hybrid workflow benchmarks
- PR/run dashboards
- competitive dashboards
- run detail and diagnostics

## Design principles

1. Use OTLP-native structures where possible.
2. Put run-level metadata on **resource attributes**.
3. Put benchmark/scenario/series identity on **metric datapoint attributes**.
4. Make required fields small and explicit.
5. Keep custom producer logic simple enough that users can emit compliant data
   from scripts and workflows without a huge SDK wrapper.

## Required concepts

Benchkit must always be able to identify:

- which **run** a metric belongs to
- which **benchmark scenario** it belongs to
- which **series** within that scenario it belongs to
- whether a metric is **bigger** or **smaller** when it improves
- whether the metric is an **outcome** metric or a **diagnostic/monitor** metric

## Resource attributes

These apply to the whole run payload.

### Required resource attributes

| Attribute | Type | Meaning |
| --- | --- | --- |
| `benchkit.run_id` | string | Unique identifier for this stored run artifact |
| `benchkit.kind` | string | One of `code`, `workflow`, `hybrid` |
| `benchkit.source_format` | string | Input origin such as `go`, `otlp`, `rust`, `hyperfine`, `pytest-benchmark` |

### Strongly recommended

| Attribute | Type | Meaning |
| --- | --- | --- |
| `benchkit.ref` | string | Git ref associated with the run |
| `benchkit.commit` | string | Commit SHA associated with the run |
| `benchkit.workflow` | string | Workflow name or workflow identifier |
| `benchkit.job` | string | Job name or job identifier |
| `service.name` | string | Service or product name emitting the metrics |

### Optional

| Attribute | Type | Meaning |
| --- | --- | --- |
| `benchkit.run_attempt` | string | Retry or rerun number if meaningful |
| `benchkit.runner` | string | Human-readable runner description |
| `service.version` | string | Application version if useful |

## Datapoint attributes

These identify a metric within a run.

### Required datapoint attributes

| Attribute | Type | Meaning |
| --- | --- | --- |
| `benchkit.scenario` | string | Primary benchmark scenario/workload name |
| `benchkit.series` | string | Series identity within the scenario |
| `benchkit.metric.direction` | string | `bigger_is_better` or `smaller_is_better` |

### Recommended

| Attribute | Type | Meaning |
| --- | --- | --- |
| `benchkit.metric.role` | string | `outcome` or `diagnostic` |
| `benchkit.impl` | string | Implementation or product label if distinct from `series` |

### Optional grouping dimensions

These are free-form but should stay stable within a project:

- `benchkit.dataset`
- `benchkit.transport`
- `benchkit.batch_size`
- `benchkit.process`
- `benchkit.pipeline`
- `benchkit.variant`

If a dimension is expected to be used in filtering or grouping, it should be a
flat string attribute rather than encoded inside the metric name.

## Metric naming

Metric names should be:

- explicit
- stable across runs
- machine-friendly
- free of display-only formatting

Examples:

- `events_per_sec`
- `p95_latency_ms`
- `service_rss_mb`
- `docs_indexed_per_sec`
- `_monitor.cpu_user_pct`
- `_monitor.wall_clock_ms`

### Monitor and diagnostic naming

Benchkit reserves the `_monitor.` prefix for diagnostic metrics captured by
benchkit-managed monitoring or telemetry adapters.

Examples:

- `_monitor.cpu_user_pct`
- `_monitor.cpu_system_pct`
- `_monitor.wall_clock_ms`
- `_monitor.peak_rss_kb`

This makes it easy for aggregators and dashboards to partition outcome metrics
from diagnostics without depending only on free-form tags.

## Direction semantics

Every benchmark datapoint that benchkit will compare or rank must provide a
direction.

Allowed values:

- `bigger_is_better`
- `smaller_is_better`

This direction should be available as:

- `benchkit.metric.direction` datapoint attribute

and may also be duplicated into a benchkit-derived view if needed.

If a producer cannot provide direction explicitly, normalization may infer it
from metric naming or unit conventions, but explicit direction is preferred.

## Scenario and series semantics

Benchkit uses these terms consistently:

### Scenario

The workload or benchmark case being measured.

Examples:

- `full-agent-dissect`
- `tcp-syslog-dissect`
- `json-ingest`
- `homepage-load`

### Series

One comparable line or entity within a scenario.

Examples:

- one implementation
- one competitor
- one process
- one variant
- one worker pool

Examples:

- `Our product`
- `Competitor A`
- `filebeat`
- `worker-1`
- `gzip-level-6`

## Recommended mappings by benchmark type

### Code benchmark

Resource attributes:

- `benchkit.kind=code`
- `benchkit.run_id`
- `benchkit.ref`
- `benchkit.commit`

Datapoint attributes:

- `benchkit.scenario=<benchmark name>`
- `benchkit.series=<implementation or tags combo>`
- `benchkit.metric.direction=<...>`

### Workflow benchmark

Resource attributes:

- `benchkit.kind=workflow`
- `benchkit.run_id`
- `benchkit.ref`
- `benchkit.commit`

Datapoint attributes:

- `benchkit.scenario=<workflow scenario>`
- `benchkit.series=<implementation or target>`
- `benchkit.metric.direction=<...>`
- `benchkit.metric.role=outcome`

### Hybrid benchmark

Resource attributes:

- `benchkit.kind=hybrid`
- `benchkit.run_id`
- `benchkit.ref`
- `benchkit.commit`

Outcome metrics:

- use the workflow conventions above

Diagnostic metrics:

- use `_monitor.*` names
- set `benchkit.metric.role=diagnostic`

## Temporality guidance

Benchkit prefers **cumulative temporality** for stored OTLP data unless a source
has a strong reason to emit delta.

Why:

- more resilient to dropped samples
- easier to re-aggregate later
- easier to derive rates and increases from stored data

If delta metrics are emitted, producers or normalizers must preserve that fact
so downstream aggregation can interpret them correctly.

## Validation guidance

A benchkit OTLP parser or linter should reject or warn on:

- missing `benchkit.run_id`
- missing `benchkit.kind`
- missing `benchkit.scenario`
- missing `benchkit.series`
- missing `benchkit.metric.direction` for comparison-eligible metrics
- unknown `benchkit.kind`
- unknown `benchkit.metric.direction`

Diagnostic-only datasets may relax some requirements, but outcome metric sets
should be held to the full contract.

## Example

### Example resource attributes

```json
{
  "benchkit.run_id": "23830839196-1",
  "benchkit.kind": "workflow",
  "benchkit.source_format": "otlp",
  "benchkit.ref": "refs/heads/main",
  "benchkit.commit": "4aefd4614c51c0c8f1a1cc8dfb298d0c11e6846a",
  "benchkit.workflow": "Hybrid Workflow Benchmark",
  "benchkit.job": "hybrid-workflow-bench",
  "service.name": "mock-ingest"
}
```

### Example datapoint attributes

```json
{
  "benchkit.scenario": "json-ingest",
  "benchkit.series": "mock-http-ingest",
  "benchkit.metric.direction": "bigger_is_better",
  "benchkit.metric.role": "outcome",
  "benchkit.transport": "http",
  "benchkit.batch_size": "2000"
}
```

## Relationship to other docs

- Architecture and artifact planning:
  `docs/otlp-aggregation-architecture.md`
- Product roadmap:
  `docs/vision-and-roadmap.md`

This document is the semantic contract that those broader architectural and
product plans depend on.
