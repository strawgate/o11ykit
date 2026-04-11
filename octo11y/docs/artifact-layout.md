# Octo11y Artifact Layout

This document describes the files written by `actions/aggregate` to the data branch.

## Directory structure

```
data/
├── index.json                      # Global run index (backward-compatible)
├── runs/
│   └── {run-id}.json               # Raw OTLP metrics JSON (written by actions/stash)
├── series/
│   └── {metric}.json               # Pre-aggregated time-series per metric
├── index/                          # Navigation indexes
│   ├── refs.json                   # Runs grouped by git ref
│   ├── prs.json                    # Runs grouped by pull-request number
│   └── metrics.json                # All known metrics with latest activity
├── views/
│   └── runs/
│       └── {run-id}/
│           └── detail.json         # All metrics for a single run
└── telemetry/
    └── {run-id}.otlp.jsonl.gz      # Raw OTLP telemetry sidecar (written by actions/monitor)
```

---

## Artifact taxonomy

### Raw sidecars

`data/runs/{run-id}.json`

Written by `actions/stash`. Contains OTLP metrics JSON for a single CI run.
These files are the source of truth; all derived files are rebuilt from them on every aggregate.

### Global index (backward-compatible)

`data/index.json`

A list of all run entries (newest-first) plus a deduplicated list of all known metric names.
Schema: `schema/index.schema.json`

### Pre-aggregated series

`data/series/{metric}.json`

One file per metric. Each file contains the full time-series for every benchmark series that
reported that metric, keyed by benchmark name (with tag suffix when tags are present).
Schema: `schema/series.schema.json`

---

## Navigation indexes

Lightweight files designed for navigation menus and index pages.
Each file is a JSON array sorted newest-first.

### `data/index/refs.json`

Groups runs by git ref. Useful for the refs/branches navigation sidebar.

```json
[
  {
    "ref": "refs/heads/main",
    "latestRunId": "12345-1",
    "latestTimestamp": "2026-04-01T10:00:00Z",
    "latestCommit": "abc123",
    "runCount": 42
  }
]
```

Schema: `schema/index-refs.schema.json`

### `data/index/prs.json`

Groups runs by pull-request number (refs matching `refs/pull/{n}/merge`). Useful for the
PR benchmarks dashboard.

```json
[
  {
    "prNumber": 42,
    "ref": "refs/pull/42/merge",
    "latestRunId": "12346-1",
    "latestTimestamp": "2026-04-01T11:00:00Z",
    "latestCommit": "def456",
    "runCount": 3
  }
]
```

Schema: `schema/index-prs.schema.json`

### `data/index/metrics.json`

Lists all known metrics with latest-activity metadata. Useful for the metric discovery page
and custom metric dashboards.

```json
[
  {
    "metric": "ns_per_op",
    "latestSeriesCount": 5,
    "latestRunId": "12345-1",
    "latestTimestamp": "2026-04-01T10:00:00Z"
  }
]
```

Schema: `schema/index-metrics.schema.json`

---

## Detail views

Heavier files intended for single-entity detail pages. Rebuilt from raw run data on every
aggregate so they always reflect the current state.

### `data/views/runs/{run-id}/detail.json`

All benchmarks and metric values for a single run, grouped by metric name and sorted
alphabetically. Suitable for a run detail page without requiring the full series files.

```json
{
  "run": {
    "id": "12345-1",
    "timestamp": "2026-04-01T10:00:00Z",
    "commit": "abc123",
    "ref": "refs/heads/main",
    "benchmarks": 3,
    "metrics": ["bytes_per_op", "ns_per_op"]
  },
  "metricSnapshots": [
    {
      "metric": "ns_per_op",
      "unit": "ns/op",
      "direction": "smaller_is_better",
      "values": [
        {
          "name": "BenchmarkSort",
          "value": 320,
          "unit": "ns/op",
          "direction": "smaller_is_better"
        }
      ]
    }
  ]
}
```

Schema: `schema/view-run-detail.schema.json`

---

## Telemetry sidecars

### `data/telemetry/{run-id}.otlp.jsonl.gz`

Written by `actions/monitor` at shutdown. Contains the raw OTLP metrics collected during the
CI run — host CPU, memory, load, process stats, and any custom metrics sent to the
collector's OTLP endpoint. The file is gzip-compressed newline-delimited JSON (one
`ExportMetricsServiceRequest` per line).

Telemetry sidecars are **not** consumed by `actions/aggregate`. They exist for offline
analysis, debugging, and future aggregation use cases. Each sidecar is keyed to a run via
the run ID in the filename, which matches the corresponding `data/runs/{run-id}.json` file.

---

## Frontend fetch strategy

| Surface | Files to fetch |
|---------|---------------|
| Runs list / home | `data/index.json` or `data/index/refs.json` |
| PR dashboard | `data/index/prs.json`, then `data/views/runs/{id}/detail.json` per PR run |
| Metric discovery | `data/index/metrics.json` |
| Metric chart | `data/series/{metric}.json` |
| Run detail page | `data/views/runs/{id}/detail.json` |

This layout allows the frontend to fetch one small file for navigation and one
medium file for detail, avoiding a single giant blob or many per-run raw files.
