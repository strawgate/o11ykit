# Getting started with Octo11y

Copy one workflow file, push it, and you have benchmark tracking with trend
charts, PR comparisons, and README badges — no servers, no databases.

## Quick start: one workflow file

Create `.github/workflows/benchmark.yml` in your repository:

```yaml
name: Benchmark
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: write

jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run benchmarks
        run: go test -bench=. -benchmem ./... | tee bench.txt

      - name: Stash results
        uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: bench.txt

      - name: Aggregate indexes
        if: github.ref == 'refs/heads/main'
        uses: strawgate/octo11y/actions/aggregate@main-dist

      - name: Compare to baseline
        if: github.event_name == 'pull_request'
        uses: strawgate/octo11y/actions/compare@main-dist
        with:
          results: bench.txt
```

That's it. After the first push to `main`:

- **Stash** parses your benchmark output, stores it as OTLP JSON on the
  `bench-data` branch, and writes a summary table to the job log.
- **Aggregate** rebuilds indexes, series files, and Shields.io badge JSON
  from all stored runs.
- **Compare** (on PRs) compares the current run against recent baselines,
  posts a PR comment with deltas and a regression verdict.

### Add a README badge

After the first aggregate run, add a badge for any metric:

```markdown
![ns/op](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/bench-data/data/badges/ns_per_op.json)
```

Replace `OWNER/REPO` with your repository and `ns_per_op` with the metric
name. Badge color is direction-aware: green on improvement, red on regression,
blue when stable.

### Supported formats

The `format` input defaults to `auto` which detects the format from file
contents. You can also set it explicitly:

| Format | Example command |
|--------|----------------|
| `go` | `go test -bench=. -benchmem ./...` |
| `rust` | `cargo bench` |
| `hyperfine` | `hyperfine --export-json bench.json 'fd pattern' 'find . -name pattern'` |
| `pytest-benchmark` | `pytest --benchmark-json bench.json` |
| `benchmark-action` | benchmark-action JSON output |
| `otlp` | Raw OTLP metrics JSON |

### Adapt for your language

Replace the "Run benchmarks" step with whatever produces your output file.
The rest of the workflow stays identical:

**Rust:**
```yaml
      - name: Run benchmarks
        run: cargo bench -- --output-format=json | tee bench.json
```

**Hyperfine:**
```yaml
      - name: Run benchmarks
        run: hyperfine --export-json bench.json 'fd pattern' 'find . -name pattern'
```

**pytest-benchmark:**
```yaml
      - name: Run benchmarks
        run: pytest --benchmark-json bench.json tests/bench/
```

### Matrix builds

For matrix builds, add a custom `run-id` so each variant writes a distinct
file:

```yaml
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      # ...
      - uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: bench.txt
          run-id: ${{ github.run_id }}-${{ matrix.os }}
```

## Going deeper

The quick-start workflow covers the most common case. The sections below
describe additional features you can layer on.

### Compare options

```yaml
      - name: Compare to baseline
        uses: strawgate/octo11y/actions/compare@main-dist
        with:
          results: bench.txt
          baseline-runs: 5         # average over last N runs
          threshold: 5             # % change to flag as regression
          fail-on-regression: true # fail the workflow step
          comment-on-pr: true      # post/update a PR comment
```

### Telemetry with monitor and emit-metric

If you want host metrics or custom OTLP metrics, start the monitor once near the top of the job:

```yaml
      - name: Start monitor
        id: monitor
        uses: strawgate/octo11y/actions/monitor@main-dist
        with:
          scrape-interval: 5s
          metric-sets: cpu,memory,load,process
```

Then point benchmark code at the OTLP endpoint:

```yaml
      - name: Run benchmarks
        env:
          OTEL_EXPORTER_OTLP_ENDPOINT: ${{ steps.monitor.outputs.otlp-http-endpoint }}
        run: go test -bench=. -benchmem ./... | tee bench.txt
```

To record a one-off workflow metric without wiring up a full OTLP SDK:

```yaml
      - name: Emit score metric
        uses: strawgate/octo11y/actions/emit-metric@main-dist
        with:
          otlp-http-endpoint: ${{ steps.monitor.outputs.otlp-http-endpoint }}
          name: test_score
          value: 74
          unit: points
          scenario: search-relevance
          series: baseline
          direction: bigger_is_better
          attributes: |
            dataset=wiki
            variant=bm25
```

The monitor action stores raw OTLP telemetry at `data/telemetry/{run-id}.otlp.jsonl.gz`.

### Custom workflow metrics (non-benchmark)

You do not need a benchmark tool to use Octo11y. Any numeric value you can
compute in a workflow step can become a tracked metric with `emit-metric`:

```yaml
      - name: Track bundle size
        run: echo "BUNDLE_SIZE=$(du -sb dist/ | cut -f1)" >> "$GITHUB_ENV"

      - uses: strawgate/octo11y/actions/emit-metric@main-dist
        with:
          otlp-http-endpoint: ${{ steps.monitor.outputs.otlp-http-endpoint }}
          name: bundle_size_bytes
          value: ${{ env.BUNDLE_SIZE }}
          unit: bytes
          direction: smaller_is_better
```

Other ideas: Docker image size, test count, build duration, dependency count,
Lighthouse scores, API latency — anything you can `echo` as a number.

### Track repo health metrics

Use `actions/repo-stats` to automatically collect GitHub repository statistics —
no shell scripting required:

```yaml
      - uses: strawgate/octo11y/actions/repo-stats@main-dist
        id: stats
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: ${{ steps.stats.outputs.results-file }}
          format: otlp
```

Collects stars, forks, issues, PRs, contributors, releases, repo size, watchers,
workflow success rate, code velocity, and language breakdown out of the box. With
additional token permissions, also tracks traffic (views/clones) and security
alert counts. See [`actions/repo-stats/README.md`](../actions/repo-stats/README.md)
for the full metric list.

### Render a dashboard

Install the chart packages:

```bash
npm install @benchkit/chart @benchkit/format @octo11y/core preact
```

Mount the default dashboard:

```tsx
import "@benchkit/chart/css";
import { Dashboard } from "@benchkit/chart";

export function App() {
  return (
    <Dashboard
      source={{
        owner: "your-org",
        repo: "your-repo",
        branch: "bench-data",
      }}
    />
  );
}
```

`Dashboard` fetches `index.json` and series files from your `bench-data`
branch and renders trend charts, comparison bars, leaderboards, and tag
filters automatically. See [`../packages/chart/README.md`](../packages/chart/README.md)
for the full props reference and alternative surfaces (`RunDashboard`,
`RunDetail`).

### Split workflows (advanced)

For high-traffic repositories, you may want aggregate to run as a separate
workflow instead of inline. See [`workflow-architecture.md`](workflow-architecture.md)
for guidance on splitting stash and aggregate into separate workflow files
with `workflow_dispatch` or `push` triggers.

## Where to go next

- Recipes for every language and use case: [`recipes.md`](recipes.md)
- Action-by-action reference: [`reference/actions.md`](reference/actions.md)
- Migration readiness and example coverage: [`migration-readiness.md`](migration-readiness.md)
- Data contracts and schemas: [`../schema/README.md`](../schema/README.md)
- Format APIs and parsers: [`../packages/format/README.md`](../packages/format/README.md)
- Workflow architecture guidance: [`workflow-architecture.md`](workflow-architecture.md)
- Playground setup: [`playground-setup.md`](playground-setup.md)
