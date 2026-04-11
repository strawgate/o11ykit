# Benchkit Compare

Compare the current benchmark results against a rolling baseline stored on the
data branch and report regressions. Optionally fails the step and posts the
comparison report as a PR comment.

## What it does

- parses the current benchmark result files using the specified (or
  auto-detected) format
- loads the most recent baseline runs from the data branch and averages their
  metric values
- computes the percentage change for every shared metric and flags those that
  exceed the threshold as regressions
- writes a Markdown comparison table to `GITHUB_STEP_SUMMARY`
- optionally posts (or updates) a PR comment with the same report
- optionally fails the step when at least one regression is detected

## Usage

```yaml
jobs:
  bench:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - name: Run benchmarks
        run: go test -bench=. -benchmem -count=3 ./... | tee bench.txt

      - name: Compare benchmark results
        id: compare
        uses: strawgate/octo11y/actions/compare@main-dist
        with:
          results: bench.txt
          format: go
          threshold: 5
          fail-on-regression: true
          comment-on-pr: true

      - name: Show regression status
        run: echo "Regression detected: ${{ steps.compare.outputs.has-regression }}"
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `results` | **yes** | — | Path or glob pattern to benchmark result file(s) for the current run. |
| `format` | no | `auto` | Input format: `auto`, `go`, `rust`, `hyperfine`, `pytest-benchmark`, `benchmark-action`, or `otlp`. |
| `data-branch` | no | `bench-data` | Branch used for benchmark data storage. |
| `baseline-runs` | no | `5` | Number of most recent baseline runs to average. |
| `threshold` | no | `5` | Percentage change threshold for regression detection. |
| `fail-on-regression` | no | `false` | Fail the action step when a regression is detected. |
| `comment-on-pr` | no | `true` | Post comparison results as a PR comment. The comment is updated on subsequent runs rather than duplicated. |
| `github-token` | no | `${{ github.token }}` | Token with read access to the data branch and PR comment permissions. |

## Outputs

| Output | Description |
|--------|-------------|
| `has-regression` | `'true'` if any benchmark regressed beyond the threshold, `'false'` otherwise. |
| `summary` | Markdown-formatted comparison report. |

## Notes

- If the data branch does not exist the action skips the comparison, sets
  `has-regression` to `'false'`, and logs a warning instead of failing.
- `comment-on-pr` only posts a comment when the workflow is triggered by a pull
  request event. On push and other events the comment step is skipped.
- The action requires `contents: read` to fetch the data branch and
  `pull-requests: write` when `comment-on-pr` is `true`.

## How it works

1. **Parse**: glob-expand `results` and parse every matched file using the
   requested (or auto-detected) format
2. **Fetch baseline**: fetch the data branch into a temporary git worktree and
   load the `baseline-runs` most recent run files
3. **Compare**: average the baseline metric values and compute the percentage
   change against each current metric; flag metrics that exceed `threshold` as
   regressions
4. **Report**: write the Markdown comparison table to `GITHUB_STEP_SUMMARY` and
   set the `summary` output
5. **Comment** *(optional)*: when running on a pull request and `comment-on-pr`
   is `true`, create or update a single PR comment with the comparison report
6. **Fail** *(optional)*: when `fail-on-regression` is `true` and at least one
   regression was detected, mark the step as failed

## Relationship to stash and aggregate

- `actions/stash` writes the run files that serve as the baseline for this
  action
- `actions/aggregate` rebuilds the derived indexes from those run files
- `actions/compare` reads the raw run files directly and does not depend on the
  aggregated indexes
