# Benchkit Ingest CI Runs

Discover completed GitHub Actions workflow runs that should be parsed into
bench data.

Use a published dist ref (`@main-dist` or a version tag). Do not use `@main`
for JS actions, because `@main` does not include compiled action bundles.

This action does discovery only. Pair it with
`strawgate/o11ykit/actions/parse-results@main-dist` in a matrix job, then run
`strawgate/o11ykit/octo11y/actions/aggregate@main-dist`.

## Behavior

- Scans all workflows by default.
- Uses `data/state/benchkit-ci-run-ingest.cursor.json` on the data branch as a cursor.
- If no cursor (and no explicit `since`) exists, applies a bounded first-run
  lookback window (`lookback-hours`, default `72`).
- Supports optional workflow/event/conclusion filters.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | yes | `${{ github.token }}` | Token with `actions:read` and `contents:write` (when `commit-cursor=true`). |
| `repository` | no | `${{ github.repository }}` | Repository to inspect (`owner/repo`). |
| `data-branch` | no | `bench-data` | Data branch containing the cursor file. |
| `cursor-path` | no | `data/state/benchkit-ci-run-ingest.cursor.json` | Cursor JSON path on the data branch. |
| `commit-cursor` | no | `true` | Persist the updated cursor to `data-branch` after discovery. |
| `since` | no | — | Explicit ISO lower-bound timestamp for `created_at` filtering. |
| `lookback-hours` | no | `72` | Fallback lookback when no `since`/cursor is available. |
| `max-runs` | no | `50` | Maximum candidate runs returned after filtering. |
| `workflows` | no | `` | Comma-separated workflow filters (name, filename, or workflow id). Empty scans all workflows. |
| `events` | no | `push,pull_request,workflow_dispatch,schedule` | Comma-separated event filters. Empty means all events. |
| `conclusions` | no | `success` | Comma-separated conclusion filters. Empty means all conclusions. |

## Outputs

| Output | Description |
|---|---|
| `run-count` | Number of selected candidate runs. |
| `runs-json` | JSON array of run objects (`id`, `run_attempt`, `workflow_name`, `event`, `created_at`, `html_url`). |
| `run-ids-json` | JSON array of selected run ids. |
| `since` | Effective timestamp lower bound used. |
| `latest-created-at` | Latest selected `created_at` (or `since` when none selected). |
| `cursor-json` | Cursor payload to persist to `bench-data` for the next ingest run. |

## Nightly Ingest Example

```yaml
name: Benchkit Ingest
on:
  schedule:
    - cron: "17 4 * * *"
  workflow_dispatch:
permissions:
  actions: read
  contents: write
jobs:
  discover:
    runs-on: ubuntu-latest
    outputs:
      runs: ${{ steps.discover.outputs.runs-json }}
      cursor: ${{ steps.discover.outputs.cursor-json }}
      run-count: ${{ steps.discover.outputs.run-count }}
    steps:
      - uses: actions/checkout@v4
      - id: discover
        uses: strawgate/o11ykit/octo11y/actions/ingest-ci-runs@main-dist
        with:
          github-token: ${{ github.token }}
          lookback-hours: 72
          max-runs: 40

  parse:
    needs: discover
    if: ${{ needs.discover.outputs.run-count != '0' }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        run: ${{ fromJson(needs.discover.outputs.runs) }}
    steps:
      - uses: actions/checkout@v4
      - name: Parse source run logs
        uses: strawgate/o11ykit/actions/parse-results@main-dist
        with:
          mode: auto
          format: auto
          github-token: ${{ github.token }}
          source-run-id: ${{ matrix.run.id }}
          source-run-attempt: ${{ matrix.run.run_attempt }}
          run-id: ${{ matrix.run.id }}-${{ matrix.run.run_attempt }}

  aggregate:
    needs: [discover, parse]
    if: ${{ always() && needs.discover.result == 'success' && (needs.parse.result == 'success' || needs.parse.result == 'skipped') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: strawgate/o11ykit/octo11y/actions/aggregate@main-dist
        with:
          github-token: ${{ github.token }}
```

Use the `workflows` input when you want to scope ingest to specific workflows
instead of scanning all completed runs.
