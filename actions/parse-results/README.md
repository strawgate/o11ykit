# Parse Results Action

Parses benchmark output into OTLP metrics JSON and stashes it to a data branch.

Use a published dist ref (`@main-dist` or a version tag). Do not use `@main`
for JS actions, because `@main` does not include compiled action bundles.

## Modes

- `mode: auto` (default): downloads current run logs via GitHub Actions API using `github-token`.
- `mode: file`: parses benchmark output from an explicit `results` file/glob.

## Inputs

- `mode`: `auto` or `file` (default `auto`)
- `results`: file/glob, required for `mode=file`
- `format`: `auto|go|rust|hyperfine|pytest-benchmark|benchmark-action|otlp` (default `auto`)
- `data-branch`: branch to write run documents to (default `bench-data`)
- `github-token`: required for `auto` and for `commit-results=true`
- `run-id`: optional custom run id
- `source-run-id`: optional workflow run id to read logs from when using `auto`
- `source-run-attempt`: optional run attempt for `source-run-id`
- `source-job`: optional job name to target when `auto` run logs are unavailable
- `monitor-results`: optional OTLP JSON file path to merge into output
- `commit-results`: whether to push to data branch (default `true`)
- `fail-on-zero-datapoints`: fail action if parsed datapoints is zero (default `false`)
- `min-datapoints`: minimum datapoints required for success (default `0`)
- `summary`: write step summary (default `true`)

Guardrails are evaluated before committing results. If thresholds are not met,
the action fails and no stash commit is pushed.

## Outputs

- `run-id`: resolved run identifier
- `file-path`: stashed path (`data/runs/...`) or temp output path
- `source`: resolved source mode (`auto` or `file`)
- `datapoint-count`: total datapoints in normalized OTLP
- `resource-metrics-count`: total `resourceMetrics` entries
- `has-metrics`: `true` when datapoints are present, otherwise `false`
- `normalized-otlp-path`: local path to normalized OTLP JSON for downstream steps

## Example

```yaml
permissions:
  actions: read
  contents: write

steps:
  - uses: actions/checkout@v4
  - run: go test -bench=. -benchmem ./...
  - uses: strawgate/o11ykit/actions/parse-results@main-dist
    with:
      mode: auto
      format: go
      github-token: ${{ github.token }}
```
