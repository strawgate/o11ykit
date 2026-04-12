# Benchmark and Metric Recipes

Copy-paste workflow examples for common use cases. Each recipe is a complete
workflow file — create it at `.github/workflows/benchmark.yml` and push.

## Code benchmarks

### Go

```yaml
name: Benchmark
on:
  push: { branches: [main] }
  pull_request:
permissions: { contents: write }
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: stable }
      - run: go test -bench=. -benchmem -count=5 ./... | tee bench.txt
      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { results: bench.txt }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
        if: github.ref == 'refs/heads/main'
      - uses: strawgate/octo11y/actions/compare@main-dist
        if: github.event_name == 'pull_request'
        with: { results: bench.txt }
```

`-count=5` runs each benchmark 5 times. The aggregate action averages the
samples and records the range, giving you variance data in the dashboard.

### Rust (Criterion)

```yaml
name: Benchmark
on:
  push: { branches: [main] }
  pull_request:
permissions: { contents: write }
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo bench -- --output-format=json | tee bench.json
      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { results: bench.json, format: rust }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
        if: github.ref == 'refs/heads/main'
      - uses: strawgate/octo11y/actions/compare@main-dist
        if: github.event_name == 'pull_request'
        with: { results: bench.json, format: rust }
```

### Hyperfine (CLI tool comparison)

```yaml
name: Benchmark
on:
  push: { branches: [main] }
  pull_request:
permissions: { contents: write }
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          sudo apt-get install -y hyperfine fd-find
          hyperfine --warmup 3 --export-json bench.json \
            'fd pattern' \
            'find . -name pattern'
      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { results: bench.json, format: hyperfine }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
        if: github.ref == 'refs/heads/main'
      - uses: strawgate/octo11y/actions/compare@main-dist
        if: github.event_name == 'pull_request'
        with: { results: bench.json, format: hyperfine }
```

### pytest-benchmark

```yaml
name: Benchmark
on:
  push: { branches: [main] }
  pull_request:
permissions: { contents: write }
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install pytest pytest-benchmark
      - run: pytest --benchmark-json bench.json tests/bench/
      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { results: bench.json, format: pytest-benchmark }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
        if: github.ref == 'refs/heads/main'
      - uses: strawgate/octo11y/actions/compare@main-dist
        if: github.event_name == 'pull_request'
        with: { results: bench.json, format: pytest-benchmark }
```

## Workflow metrics (non-benchmark)

These recipes use `benchkit-emit` to track any numeric value over time.
They require `actions/monitor` to provide an OTLP collector endpoint.

### Scheduled ingest from existing CI runs

Backfill and continuously ingest benchmark output from completed workflow runs.
This scans all workflows by default, then only new runs after the first pass.

```yaml
name: Ingest benchmark runs
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
      - uses: strawgate/o11ykit/actions/parse-results@main-dist
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
```

### Bundle size

Track JavaScript bundle size and fail on bloat:

```yaml
name: Track bundle size
on:
  push: { branches: [main] }
  pull_request:
permissions: { contents: write }
jobs:
  bundle:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build

      - uses: strawgate/octo11y/actions/monitor@main-dist
        id: monitor

      - name: Measure bundle
        run: |
          TOTAL=$(du -sb dist/ | cut -f1)
          JS=$(find dist/ -name '*.js' -exec du -cb {} + | tail -1 | cut -f1)
          CSS=$(find dist/ -name '*.css' -exec du -cb {} + | tail -1 | cut -f1)
          echo "TOTAL=$TOTAL" >> "$GITHUB_ENV"
          echo "JS=$JS" >> "$GITHUB_ENV"
          echo "CSS=$CSS" >> "$GITHUB_ENV"

      - run: |
          benchkit-emit --name bundle_total_bytes --value "${{ env.TOTAL }}" \
            --unit bytes --direction down --scenario bundle

      - run: |
          benchkit-emit --name bundle_js_bytes --value "${{ env.JS }}" \
            --unit bytes --direction down --scenario bundle

      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { metrics-dir: ${{ steps.monitor.outputs.metrics-dir }} }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
        if: github.ref == 'refs/heads/main'
```

### Docker image size

```yaml
name: Track image size
on:
  push: { branches: [main] }
permissions: { contents: write }
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t myapp:latest .

      - uses: strawgate/octo11y/actions/monitor@main-dist
        id: monitor

      - name: Measure image
        run: |
          SIZE=$(docker inspect myapp:latest --format '{{.Size}}')
          echo "IMAGE_SIZE=$SIZE" >> "$GITHUB_ENV"

      - run: |
          benchkit-emit --name image_size_bytes --value "${{ env.IMAGE_SIZE }}" \
            --unit bytes --direction down --scenario docker

      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { metrics-dir: ${{ steps.monitor.outputs.metrics-dir }} }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
```

### Build and test duration

```yaml
name: Track CI timing
on:
  push: { branches: [main] }
permissions: { contents: write }
jobs:
  timing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - uses: strawgate/octo11y/actions/monitor@main-dist
        id: monitor

      - name: Install
        run: |
          START=$(date +%s%N)
          npm ci
          END=$(date +%s%N)
          echo "INSTALL_MS=$(( (END - START) / 1000000 ))" >> "$GITHUB_ENV"

      - name: Build
        run: |
          START=$(date +%s%N)
          npm run build
          END=$(date +%s%N)
          echo "BUILD_MS=$(( (END - START) / 1000000 ))" >> "$GITHUB_ENV"

      - name: Test
        run: |
          START=$(date +%s%N)
          npm test
          END=$(date +%s%N)
          echo "TEST_MS=$(( (END - START) / 1000000 ))" >> "$GITHUB_ENV"

      - run: |
          benchkit-emit --name install_duration_ms --value "${{ env.INSTALL_MS }}" \
            --unit ms --direction down --scenario ci-timing

      - run: |
          benchkit-emit --name build_duration_ms --value "${{ env.BUILD_MS }}" \
            --unit ms --direction down --scenario ci-timing

      - run: |
          benchkit-emit --name test_duration_ms --value "${{ env.TEST_MS }}" \
            --unit ms --direction down --scenario ci-timing

      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { metrics-dir: ${{ steps.monitor.outputs.metrics-dir }} }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
```

### Test count and coverage

```yaml
name: Track test health
on:
  push: { branches: [main] }
permissions: { contents: write }
jobs:
  test-health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: stable }

      - uses: strawgate/octo11y/actions/monitor@main-dist
        id: monitor

      - name: Run tests with coverage
        run: |
          go test -cover -count=1 ./... 2>&1 | tee test-output.txt
          TOTAL=$(grep -c '^ok\|^FAIL' test-output.txt || echo 0)
          COVER=$(grep -oP 'coverage: \K[0-9.]+' test-output.txt | awk '{s+=$1;n++} END{if(n>0) printf "%.1f", s/n; else print 0}')
          echo "TEST_COUNT=$TOTAL" >> "$GITHUB_ENV"
          echo "COVERAGE=$COVER" >> "$GITHUB_ENV"

      - run: |
          benchkit-emit --name test_count --value "${{ env.TEST_COUNT }}" \
            --unit tests --direction up --scenario test-health

      - run: |
          benchkit-emit --name coverage_pct --value "${{ env.COVERAGE }}" \
            --unit "%" --direction up --scenario test-health

      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { metrics-dir: ${{ steps.monitor.outputs.metrics-dir }} }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
```

### API latency

```yaml
name: Track API latency
on:
  schedule:
    - cron: "0 */6 * * *"   # every 6 hours
  workflow_dispatch:
permissions: { contents: write }
jobs:
  latency:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: strawgate/octo11y/actions/monitor@main-dist
        id: monitor

      - name: Measure endpoints
        run: |
          HEALTH=$(curl -o /dev/null -s -w '%{time_total}' https://api.example.com/health)
          HEALTH_MS=$(echo "$HEALTH * 1000" | bc | cut -d. -f1)
          echo "HEALTH_MS=$HEALTH_MS" >> "$GITHUB_ENV"

      - run: |
          benchkit-emit --name health_latency_ms --value "${{ env.HEALTH_MS }}" \
            --unit ms --direction down --scenario api-latency

      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { metrics-dir: ${{ steps.monitor.outputs.metrics-dir }} }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
```

## Repo health metrics

Track repository activity over time (stars, issues, PRs, velocity, languages, and more):

```yaml
name: Collect Repo Stats
on:
  schedule:
    - cron: "0 6 * * *"   # daily at 06:00 UTC
  workflow_dispatch:
permissions:
  contents: write
  actions: read
  issues: read
  pull-requests: read
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: strawgate/octo11y/actions/repo-stats@main-dist
        id: stats
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: ${{ steps.stats.outputs.results-file }}
          format: otlp

      - uses: strawgate/octo11y/actions/aggregate@main-dist
```

The action collects 24 metrics by default — community stats, velocity, code
frequency, and language breakdown. Traffic and security metrics are available
with additional token permissions. See
[`actions/repo-stats/README.md`](../actions/repo-stats/README.md) for details.

## With runner telemetry

Add `actions/monitor` to any benchmark recipe for CPU, memory, and process
metrics alongside your benchmark results:

```yaml
      - uses: strawgate/octo11y/actions/monitor@main-dist
        id: monitor
        with:
          scrape-interval: 5s
          metric-sets: cpu,memory,load,process

      # ... run your benchmark here ...

      - uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: bench.txt
          metrics-dir: ${{ steps.monitor.outputs.metrics-dir }}
```

The monitor data appears in the run detail view alongside your benchmark
metrics.

## Adding a README badge

After aggregate runs, badge JSON is available for each metric. Add to your
`README.md`:

```markdown
![ns/op](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/bench-data/data/badges/ns_per_op.json)
![bundle size](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/bench-data/data/badges/bundle_total_bytes.json)
```

Replace `OWNER/REPO` with your repository. The metric name in the URL
matches whatever you named your metric (`ns_per_op`, `bundle_total_bytes`, etc.).
