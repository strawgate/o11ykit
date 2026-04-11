# Benchkit Stash

Parse benchmark result files and commit them to a persistent data branch so
that later aggregation and comparison steps have a stable history to work with.

## What it does

- accepts benchmark results in Go, Rust, Hyperfine, pytest-benchmark,
  benchmark-action, OTLP, or auto-detected format
- parses every matched file and merges the benchmarks into a single
  OTLP metrics document
- optionally merges monitor context produced by `actions/monitor` into the
  stored result
- writes the result to `data/runs/{run-id}.json` on the data branch
- retries the push with an automatic rebase so concurrent matrix jobs do not
  race each other
- optionally writes a parsed benchmark summary to `GITHUB_STEP_SUMMARY`

## Usage

```yaml
jobs:
  bench:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Run benchmarks
        run: go test -bench=. -benchmem -count=3 ./... | tee bench.txt

      - name: Stash benchmark results
        id: stash
        uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: bench.txt
          format: go
          monitor-results: monitor.json
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `results` | **yes** | — | Path or glob pattern to benchmark result file(s). |
| `format` | no | `auto` | Input format: `auto`, `go`, `rust`, `hyperfine`, `pytest-benchmark`, `benchmark-action`, or `otlp`. |
| `data-branch` | no | `bench-data` | Branch used for benchmark data storage. |
| `github-token` | no | `${{ github.token }}` | Token with push access to the repository. |
| `run-id` | no | `{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}--{GITHUB_JOB}` | Custom run identifier. Defaults to a value that is collision-proof across concurrent jobs. For matrix jobs, supply a value that includes the matrix key so each variant writes a distinct file. |
| `monitor-results` | no | — | Path to `monitor.json` produced by `actions/monitor`. When provided, monitor benchmarks and context are merged into the stored result. |
| `commit-results` | no | `true` | When `false`, parse and output the result JSON but do not commit it to the data branch. |
| `summary` | no | `true` | When `true`, write a parsed benchmark summary to `GITHUB_STEP_SUMMARY`. |

## Outputs

| Output | Description |
|--------|-------------|
| `run-id` | The run identifier used for this stash. |
| `file-path` | Path to the stored JSON file on the data branch, or to the temporary output file when `commit-results` is `false`. |

## Stored output

Each stash call writes one JSON file to the data branch:

```
data/runs/{run-id}.json
```

`run-id` paths are immutable. If `data/runs/{run-id}.json` already exists on
the data branch, stash fails instead of overwriting it.

The file contains OTLP metrics JSON including benchmark names, metric values,
units, and resource attributes (commit SHA, ref, runner OS, source format).
When a monitor path is supplied the monitor benchmarks and resource
attributes are merged in before writing.

## How it works

1. **Parse**: glob-expand `results`, parse every matched file using the
   requested (or auto-detected) format, and merge into a single result document
2. **Merge** *(optional)*: if `monitor-results` is set, read the monitor output and
   merge its benchmarks and context into the result
3. **Push**: checkout (or create) the data branch in a temporary git worktree,
   write the result file, commit, and push — retrying up to five times with a
   randomized backoff and automatic rebase on conflict

## Relationship to aggregate and monitor

- `actions/stash` stores the parsed benchmark result at
  `data/runs/{run-id}.json`
- `actions/monitor` stores raw OTLP telemetry separately at
  `data/telemetry/{run-id}.otlp.jsonl.gz`
- `actions/aggregate` reads all run files written by stash and rebuilds the
  query indexes used by charts and dashboards
