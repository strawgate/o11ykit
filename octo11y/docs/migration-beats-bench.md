# Migrating from beats-bench to Benchkit

This guide documents how to migrate an existing `beats-bench` setup to use **Benchkit** for data storage, aggregation, comparison, and visualization.

## Overview

`beats-bench` (strawgate/beats-bench) is the original project that inspired Benchkit. While `beats-bench` provides a robust Docker orchestration layer for Filebeat benchmarking, its data pipeline is custom-built for one repo.

By migrating to Benchkit, you keep the specialized Python runner and Docker orchestration while gaining:
- **Standardized data format**: Compatibility with the OTLP metrics schema.
- **Improved CI performance**: Offload data aggregation and stashing to optimized GitHub Actions.
- **Modern visualization**: Use the `@benchkit/chart` Preact components for a faster, more interactive dashboard.
- **PR-Native feedback**: Automatic regression detection and PR comments.

---

## Migration Path

### 1. Update `beats-bench` CLI

> **Status: Blocked upstream.** This step requires a change to the `beats-bench`
> repository that has not been implemented yet. Until the `--output-format benchkit`
> flag ships, the migration cannot proceed end-to-end.

The `beats-bench summarize` command should be updated to emit OTLP JSON.

- **Add flag**: `--output-format benchkit`
- **Action**: When this flag is used, `beats-bench` should map its internal `RunResult` objects to an OTLP metrics JSON file using `buildOtlpResult()` from `@benchkit/format`.

### 2. Replace Custom Data Pipeline
`beats-bench` originally used custom git commands to push data to a `bench-data` branch. This is replaced by two Benchkit actions:

- **Stash**: Replaces `git push` logic. It parses results and commits them to the data branch.
- **Aggregate**: Replaces the custom index-building logic. It rebuilds `index.json` and time-series files.

### 3. Replace Custom PR Comparison
Instead of custom inline arithmetic in the Python runner for PR comments, use `actions/compare@main`. This action:
- Generates a markdown comparison table.
- Posts a PR comment.
- Fails the CI if regressions are detected (optional).

### 4. Migrate Dashboard
Replace the custom Preact dashboard in the `dashboard/` directory with a standard Benchkit dashboard using `@benchkit/chart`.

---

## Field Mapping

### Mapping `RunResult` to OTLP metrics

| beats-bench Field | Benchkit Field | Notes |
|-------------------|----------------|-------|
| `scenario` | `tags.scenario` | Maps the pipeline configuration name. |
| `cpu` | `tags.cpu` | Maps the Docker CPU limit. |
| `eps` | `metrics.eps` | Events per second (unit: `events/sec`). |
| `throughput` | `metrics.throughput` | Bytes per second (unit: `bytes/sec`). |
| `latency` | `metrics.latency` | Process latency (unit: `ms`). |
| `samples` | `samples` | List of `Sample` objects with `t` (seconds). |

### Time-series Samples
`beats-bench` collects samples over the duration of the run. These map directly to Benchkit `Sample` objects.

**beats-bench (internal):**
```python
{
  "timestamp": 12.5,
  "eps": 150000,
  "cpu_usage": 0.45
}
```

**Benchkit (JSON):**
```json
{
  "t": 12.5,
  "eps": 150000,
  "cpu_usage": 0.45
}
```

---

## Workflow Examples

### Before (beats-bench custom pipeline)

```yaml
- name: Run benchmarks
  run: |
    uv run beats-bench run-scenario --output-dir results ...

- name: Summarize and Push
  run: |
    uv run beats-bench summarize --results-dir results --output-dir _site ...
    git checkout bench-data
    cp -r _site/data .
    git add data/
    git commit -m "Update benchmarks"
    git push origin bench-data
```

### After (Benchkit pipeline)

```yaml
- name: Run benchmarks
  run: |
    uv run beats-bench run-scenario --output-dir results ...
    # Ensure summarize emits benchkit format
    uv run beats-bench summarize --results-dir results --output-format benchkit --output bench.json

- name: Stash results
  uses: strawgate/octo11y/actions/stash@main-dist
  with:
    results: bench.json

- name: Aggregate
  uses: strawgate/octo11y/actions/aggregate@main-dist

- name: Compare (PR only)
  if: github.event_name == 'pull_request'
  uses: strawgate/octo11y/actions/compare@main-dist
  with:
    results: bench.json
    fail-on-regression: true
```

---

## Dashboard Migration

The `beats-bench` dashboard can be replaced by a few lines of code using the `@benchkit/chart` library.

**Custom Implementation (Before):**
Manual fetching of `dashboard-data.json` and custom D3/Chart.js rendering.

**Benchkit Dashboard (After):**
```tsx
import { Dashboard } from "@benchkit/chart";

export function App() {
  return (
    <Dashboard
      source={{
        owner: "strawgate",
        repo: "beats-bench",
        branch: "bench-data"
      }}
    />
  );
}
```

---

## What stays in `beats-bench`?

Benchkit does **not** replace the core benchmarking logic of `beats-bench`. The following components remain in the `beats-bench` repository:

1. **Docker Orchestration**: Starting Filebeat and Mock-ES containers.
2. **Specialized Runners**: Logic for feeding data via TCP/UDP/Log-generator.
3. **Pprof Collection**: Generating and saving CPU/memory profiles from Filebeat.
4. **Log-generator**: The Go tool for high-speed log ingestion.
5. **Mock-ES**: The lightweight Go mock for Elasticsearch.
