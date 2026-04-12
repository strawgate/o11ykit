# Octo11y JSON schemas

This directory contains [JSON Schema (2020-12)](https://json-schema.org/draft/2020-12/schema) definitions for the data-branch files produced by Octo11y actions. Run files are written in OTLP JSON format by `bench-stash`, and derived aggregate views conform to these schemas.

## Schemas

### `index.schema.json`

Defines the **run index** maintained on the data branch.

```jsonc
{
  "runs": [
    {
      "id": "12345678-1",                   // unique run identifier
      "timestamp": "2025-01-15T10:30:00Z",
      "commit": "abc123...",
      "ref": "main",
      "benchmarks": 5,                      // number of benchmarks in the run
      "metrics": ["ns_per_op", "bytes_per_op"]
    }
  ],
  "metrics": ["ns_per_op", "bytes_per_op", "allocs_per_op"]  // all known metrics
}
```

Written to `data/index.json` by `bench-aggregate`.

### `series.schema.json`

Defines **pre-aggregated time-series** data for a single metric.

```jsonc
{
  "metric": "ns_per_op",
  "unit": "ns/op",
  "direction": "smaller_is_better",
  "series": {
    "BenchmarkScanner": {
      "tags": { "procs": "8" },
      "points": [
        {
          "timestamp": "2025-01-14T08:00:00Z",
          "value": 42000,
          "commit": "def456...",
          "run_id": "12345678-1",
          "range": 120
        },
        {
          "timestamp": "2025-01-15T10:30:00Z",
          "value": 41653,
          "commit": "abc123...",
          "run_id": "12345679-1"
        }
      ]
    }
  }
}
```

Written to `data/series/{metricName}.json` by `bench-aggregate`.

### `index-refs.schema.json`

Defines the ref-grouped navigation index written to `data/index/refs.json`.
Each entry summarizes the latest run and total run count for a git ref.

### `index-prs.schema.json`

Defines the pull-request navigation index written to `data/index/prs.json`.
Each entry summarizes the latest run and total run count for one PR ref.

### `index-metrics.schema.json`

Defines the metric navigation index written to `data/index/metrics.json`.
Each entry records a metric name plus latest-activity metadata used by metric
discovery or custom metric surfaces.

### `view-run-detail.schema.json`

Defines the run-detail artifact written to `data/views/runs/{runId}/detail.json`.
This groups one run's metrics into a detail-friendly view so run-oriented UIs do
not need to fetch and reshape all raw run files client-side.

### `comparison-result.schema.json`

Defines the output of `compare()` — per-benchmark per-metric comparison with
regression detection.

```jsonc
{
  "entries": [
    {
      "benchmark": "BenchmarkSort",
      "metric": "ns_per_op",
      "unit": "ns/op",
      "direction": "smaller_is_better",
      "baseline": 100,                    // averaged across baseline runs
      "current": 120,
      "percentChange": 20,               // positive = increased
      "status": "regressed"              // "improved" | "stable" | "regressed"
    }
  ],
  "hasRegression": true
}
```

Produced by `compare()` in `@benchkit/format`. Used by `actions/compare` for
PR comments and job summaries.

## Direction field

The `direction` field on metrics and series declares whether higher or lower
values represent improvement:

| Value | Meaning | Typical metrics |
|---|---|---|
| `bigger_is_better` | Higher = improvement | throughput, events/sec, MB/s |
| `smaller_is_better` | Lower = improvement | latency (ns/op), memory (B/op), allocations |

When direction is absent, consumers should default to `smaller_is_better`.

## Validating data

### CLI (with ajv-cli)

```bash
npx ajv validate -s schema/index.schema.json -d data/index.json
npx ajv validate -s schema/index-refs.schema.json -d data/index/refs.json
npx ajv validate -s schema/index-prs.schema.json -d data/index/prs.json
npx ajv validate -s schema/index-metrics.schema.json -d data/index/metrics.json
npx ajv validate -s schema/series.schema.json -d data/series/ns_per_op.json
npx ajv validate -s schema/view-run-detail.schema.json -d data/views/runs/my-run/detail.json
```

## Relationship between files

```
bench-stash                      bench-aggregate
    │                                  │
    ▼                                  ▼
data/runs/{id}/benchmark.otlp.json ───────► data/index.json
  (OTLP metrics JSON)                    data/index/refs.json
                               data/index/prs.json
                               data/index/metrics.json
                               data/series/{metric}.json
                               data/views/runs/{id}/detail.json

actions/monitor
    │
    ▼
data/runs/{id}/telemetry.otlp.jsonl.gz
  (raw OTLP JSONL sidecar)
```

1. `bench-stash` parses benchmark output and writes a run file.
2. `bench-aggregate` reads all run files and rebuilds the backward-compatible index, per-metric series, navigation indexes, and run-detail views.
3. `@benchkit/chart` and future run/PR-oriented surfaces read those derived files instead of joining many raw runs in the browser.
