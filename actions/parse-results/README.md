# Parse Results Action

Parses benchmark output into OTLP metrics JSON and stashes it to a data branch.

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
- `monitor-results`: optional OTLP JSON file path to merge into output
- `commit-results`: whether to push to data branch (default `true`)
- `summary`: write step summary (default `true`)

## Example

```yaml
permissions:
  actions: read
  contents: write

steps:
  - uses: actions/checkout@v4
  - run: go test -bench=. -benchmem ./...
  - uses: ./actions/parse-results
    with:
      mode: auto
      format: go
      github-token: ${{ github.token }}
```

