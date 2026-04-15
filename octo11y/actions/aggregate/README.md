# Benchkit Aggregate

Rebuild `index.json` and series files from run artifacts on the data branch.
Run this action after benchmark and/or monitor writes to keep the query indexes
that charts and dashboards rely on up to date.

## What it does

- reads per-run OTLP artifacts under `data/runs/{run-id}/`, including:
  - `*.otlp.json`
  - `*.otlp.jsonl`
  - `*.otlp.jsonl.gz`
- still supports legacy flat files under `data/runs/*.json`
- sorts runs chronologically and prunes the oldest ones when `max-runs` is set
- builds `data/index.json` — a summary of all runs with their metrics
- builds `data/series/{metric}.json` — time-series data for each metric
- builds `data/index/refs.json`, `data/index/prs.json`, and
  `data/index/metrics.json` — navigation indexes grouped by ref, PR, and metric
- builds `data/views/runs/{id}/detail.json` — per-run detail views
- commits and pushes the updated files to the data branch (skips the commit
  when nothing changed)
- retries from a fresh checkout when a concurrent stash updates `bench-data`
  between the aggregate fetch and push

## Usage

```yaml
jobs:
  aggregate:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Aggregate benchmark results
        id: aggregate
        uses: strawgate/octo11y/actions/aggregate@main-dist
        with:
          max-runs: 100
```

Typically this job runs after the benchmark job has finished, either as a
dependent job in the same workflow or in a dedicated workflow triggered by a
push to the data branch.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `data-branch` | no | `bench-data` | Branch used for benchmark data storage. |
| `github-token` | no | `${{ github.token }}` | Token with push access to the repository. |
| `max-runs` | no | `0` | Maximum number of runs to keep. `0` means unlimited. |
| `badges` | no | `true` | Generate Shields.io endpoint badge JSON files. Set to `false` to disable. |

## Outputs

| Output | Description |
|--------|-------------|
| `run-count` | Number of runs in the index after aggregation. |
| `metrics` | Comma-separated list of metric names found across all runs. |

## Stored output

The action writes (or overwrites) the following files on the data branch:

| Path | Description |
|------|-------------|
| `data/index.json` | Summary of all runs with metric list. |
| `data/series/{metric}.json` | Time-series data points for each metric. |
| `data/index/refs.json` | Runs grouped by git ref. |
| `data/index/prs.json` | Runs grouped by pull request. |
| `data/index/metrics.json` | Metric summary across all runs. |
| `data/views/runs/{id}/detail.json` | Detail view for each individual run. |
| `data/badges/{metric}.json` | Shields.io endpoint badge for each metric (when `badges` is enabled). |

Stale series and index files from runs that were pruned are removed before the
new files are written.

### README badges

When `badges` is enabled (the default), the aggregate action writes a
[Shields.io endpoint badge](https://shields.io/badges/endpoint-badge) JSON
file for each non-monitor metric. Add a badge to your README like this:

```markdown
![ns/op](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/bench-data/data/badges/ns_per_op.json)
```

Badge color reflects the trend: green when the metric improved relative to the
previous run, red when it regressed, and blue when stable or when there is no
baseline.

## How it works

1. **Fetch**: clone the data branch into a temporary git worktree
2. **Read**: load all OTLP run artifacts from `data/runs/` and sort them chronologically
3. **Prune** *(optional)*: when `max-runs > 0`, delete the oldest run files
   that exceed the limit
4. **Build**: compute the index, series, navigation indexes, and run detail
   views from the remaining runs
5. **Push**: stage all changes, commit if anything changed, and push to the
   data branch — retrying from a fresh checkout with a jittered delay if a
   concurrent update causes a non-fast-forward rejection

## Relationship to stash and chart

- `actions/stash` / `actions/parse-results` can write benchmark OTLP run files
- `actions/monitor` can write telemetry sidecars consumed directly by this action
- `actions/aggregate` rebuilds the derived indexes from those run files
- chart and dashboard tooling reads `index.json` and the series files produced
  here
