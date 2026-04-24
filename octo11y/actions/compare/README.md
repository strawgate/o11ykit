# Benchkit Compare

Compare the current benchmark results against a rolling baseline stored on the
data branch and report regressions. Optionally fails the step and posts the
comparison report as a PR comment. When you provide a matrix policy, the action
also evaluates expected lane completeness and required vs probe lane outcomes.

## What it does

- parses the current benchmark result files using the specified (or
  auto-detected) format
- loads the most recent baseline runs from the data branch and averages their
  metric values
- computes the percentage change for every shared lane+metric pair and flags
  those that exceed the threshold as regressions
- optionally evaluates matrix completeness and classifies lanes as `required`
  or `probe`
- writes a Markdown comparison table to `GITHUB_STEP_SUMMARY`
- optionally posts (or updates) a PR comment with the same report
- optionally fails the step when at least one regression is detected, or when a
  matrix policy marks required lanes as failed or missing

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

### Matrix policy example

Pass `matrix-policy` as inline JSON or as the path to a JSON file in your
workspace. Unmatched lanes default to `required`.

```yaml
      - name: Compare matrix lanes
        id: compare
        uses: strawgate/octo11y/actions/compare@main-dist
        with:
          results: results/*.json
          format: otlp
          fail-on-regression: true
          matrix-policy: >-
            {
              "dimensions": {
                "collector": ["otelcol", "vector"],
                "target_eps": [10, 1000, 10000, "max"]
              },
              "excludes": [
                { "collector": "vector", "target_eps": "max" }
              ],
              "required": [
                { "target_eps": { "lte": 1000 } }
              ],
              "probe": [
                { "target_eps": { "gte": 10000 } },
                { "target_eps": "max" }
              ]
            }

      - name: Gate on required lanes only
        run: |
          echo "required failures: ${{ steps.compare.outputs.required-failed-count }}"
          echo "missing lanes: ${{ steps.compare.outputs.missing-result-count }}"
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `results` | **yes** | — | Path or glob pattern to benchmark result file(s) for the current run. |
| `format` | no | `auto` | Input format: `auto`, `go`, `rust`, `hyperfine`, `pytest-benchmark`, `benchmark-action`, or `otlp`. |
| `data-branch` | no | `bench-data` | Branch used for benchmark data storage. |
| `baseline-runs` | no | `5` | Number of most recent baseline runs to average. |
| `threshold` | no | `5` | Percentage change threshold for regression detection. |
| `matrix-policy` | no | — | JSON string or path to a JSON file describing expected dimensions, exclusions, and `required`/`probe` lane matchers. |
| `fail-on-regression` | no | `false` | Fail on any regression by default. When `matrix-policy` is set, fail only when a required lane regresses or an expected required lane is missing. |
| `comment-on-pr` | no | `true` | Post comparison results as a PR comment. The comment is updated on subsequent runs rather than duplicated. |
| `github-token` | no | `${{ github.token }}` | Token with read access to the data branch and PR comment permissions. |

## Outputs

| Output | Description |
|--------|-------------|
| `has-regression` | `'true'` if any benchmark regressed beyond the threshold, `'false'` otherwise. |
| `has-required-failure` | `'true'` if any required matrix lane failed or is missing, `'false'` otherwise. |
| `missing-result-count` | Number of expected matrix lanes with no current result. |
| `required-passed-count` | Number of required matrix lanes that passed. |
| `required-failed-count` | Number of required matrix lanes that failed. |
| `probe-failed-count` | Number of probe matrix lanes that failed. |
| `matrix-summary-json` | JSON-encoded matrix summary for downstream workflow logic. |
| `summary` | Markdown-formatted comparison report. |

## Notes

- If the data branch does not exist the action skips comparison, emits the
  zero-value form of the matrix outputs, and logs a warning.
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
   change against each current lane+metric pair; flag metrics that exceed
   `threshold` as regressions
4. **Evaluate matrix** *(optional)*: expand the configured matrix dimensions,
   apply exclusions, mark `required` vs `probe` lanes, and count missing and
   failed lanes
5. **Report**: write the Markdown comparison table to `GITHUB_STEP_SUMMARY` and
   set the `summary` output
6. **Comment** *(optional)*: when running on a pull request and `comment-on-pr`
   is `true`, create or update a single PR comment with the comparison report
7. **Fail** *(optional)*: when `fail-on-regression` is `true`, fail on any
   regression by default, or on required-lane failures/missing results when a
   matrix policy is present

## Relationship to stash and aggregate

- `actions/stash` writes the run files that serve as the baseline for this
  action
- `actions/aggregate` rebuilds the derived indexes from those run files
- `actions/compare` reads the raw run files directly and does not depend on the
  aggregated indexes
