# Benchkit Parse Results

Parse benchmark output from either GitHub Actions logs or explicit files, then
stash the normalized OTLP JSON by default.

Use a published dist ref (`@main-dist` or a version tag). Do not use `@main`
for JS actions, because `@main` does not include compiled action bundles.

## Modes

- `mode=auto` (default): downloads the current workflow run attempt logs through
  the GitHub Actions API using `github-token`, then parses benchmark output.
- `mode=file`: parses files matched by the `results` glob.

## Usage

### Auto mode (default)

```yaml
permissions:
  actions: read
  contents: write

steps:
  - uses: actions/checkout@v4
  - name: Run benchmarks
    run: go test -bench=. -benchmem ./...
  - name: Parse and stash from logs
    uses: strawgate/octo11y/actions/parse-results@main-dist
    with:
      mode: auto
      format: go
      github-token: ${{ github.token }}
```

### File mode

```yaml
permissions:
  contents: write

steps:
  - uses: actions/checkout@v4
  - name: Run benchmarks
    run: go test -bench=. -benchmem ./... | tee bench.txt
  - name: Parse and stash from file
    uses: strawgate/octo11y/actions/parse-results@main-dist
    with:
      mode: file
      results: bench.txt
      format: go
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `mode` | no | `auto` | Source mode: `auto` or `file`. |
| `results` | in `file` mode | — | Path or glob pattern to benchmark result file(s). |
| `format` | no | `auto` | Input format: `auto`, `go`, `rust`, `hyperfine`, `pytest-benchmark`, `benchmark-action`, or `otlp`. |
| `data-branch` | no | `bench-data` | Branch used for benchmark data storage. |
| `github-token` | recommended | `${{ github.token }}` | Required for `mode=auto` and for pushing when `commit-results=true`. |
| `run-id` | no | `{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}--{GITHUB_JOB}` | Custom run identifier. |
| `monitor-results` | no | — | Path to OTLP JSON from `actions/monitor` to merge before writing. |
| `commit-results` | no | `true` | When `false`, parse and output OTLP JSON but do not commit to the data branch. |
| `summary` | no | `true` | When `true`, write a summary to `GITHUB_STEP_SUMMARY`. |

## Outputs

| Output | Description |
|---|---|
| `run-id` | The run identifier used for this result. |
| `file-path` | Path to stored JSON on the data branch, or temp output path when `commit-results=false`. |
| `source` | Resolved source mode used by this run (`auto` or `file`). |

## Run ID uniqueness

When `commit-results=true`, parse-results treats `data/runs/{run-id}.json` as
immutable. If that path already exists on the data branch, the action fails
instead of overwriting it.
