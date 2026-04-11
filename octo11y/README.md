# Octo11y

[![CI](https://github.com/strawgate/octo11y/actions/workflows/ci.yml/badge.svg)](https://github.com/strawgate/octo11y/actions/workflows/ci.yml)
[![npm @octo11y/core](https://img.shields.io/npm/v/%40octo11y%2Fcore?label=%40octo11y%2Fcore)](https://www.npmjs.com/package/@octo11y/core)
[![npm @benchkit/format](https://img.shields.io/npm/v/%40benchkit%2Fformat?label=%40benchkit%2Fformat)](https://www.npmjs.com/package/@benchkit/format)
[![npm @benchkit/chart](https://img.shields.io/npm/v/%40benchkit%2Fchart?label=%40benchkit%2Fchart)](https://www.npmjs.com/package/@benchkit/chart)

**Observability for GitHub Actions — track metrics over time with static hosting, no servers required.**

Octo11y helps you collect benchmark results and operational metrics in CI, store them on a `bench-data` branch, compare them in pull requests, and render dashboards from static JSON.

See the live dashboard at **[strawgate.github.io/octo11y](https://strawgate.github.io/octo11y/)**.

## What Octo11y gives you

- **GitHub Actions for benchmark workflows**: stash raw runs, aggregate derived files, compare PRs, collect monitor telemetry, and emit one-off OTLP metrics.
- **Format and schema tooling**: normalize Go, Rust, Hyperfine, pytest-benchmark, benchmark-action, and OTLP JSON into a common shape.
- **Preact chart components**: render dashboards and drilldowns from static files on a `bench-data` branch.
- **No backend to run**: data is stored in Git and served through GitHub's raw-content/CDN paths.

## Good fits

- **Code benchmarks** such as `go test -bench`, Rust benches, Hyperfine, or pytest-benchmark.
- **Workflow benchmarks** such as HTTP checks, JSON stats, Prometheus scrapes, and pipeline throughput metrics.
- **Hybrid runs** that combine outcome metrics with runner or process telemetry via `actions/monitor`.

## Quick taste

One workflow file gets you benchmark tracking, PR comparisons, and README badges:

```yaml
# .github/workflows/benchmark.yml
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
      - run: go test -bench=. -benchmem ./... | tee bench.txt
      - uses: strawgate/octo11y/actions/stash@main-dist
        with: { results: bench.txt }
      - uses: strawgate/octo11y/actions/aggregate@main-dist
        if: github.ref == 'refs/heads/main'
      - uses: strawgate/octo11y/actions/compare@main-dist
        if: github.event_name == 'pull_request'
        with: { results: bench.txt }
```

Works with Go, Rust, Hyperfine, pytest-benchmark, and more — see
[`docs/getting-started.md`](docs/getting-started.md) for the full guide.

## Packages and actions

| Surface | What it is | Reference |
|---|---|---|
| `@octo11y/core` | Generic OTLP metric types, parsing, and data structures | [`packages/core`](packages/core) |
| `@benchkit/format` | Parsers, types, compare helpers, OTLP result builders | [`packages/format/README.md`](packages/format/README.md) |
| `@benchkit/adapters` | Library-agnostic data transforms (filters, regressions) + Chart.js adapter | [`packages/adapters/README.md`](packages/adapters/README.md) |
| `@benchkit/chart` | Preact dashboards, charts, and fetch helpers | [`packages/chart/README.md`](packages/chart/README.md) |
| `actions/parse-results` | Parse benchmark output from logs/files and stash by default | [`actions/parse-results/README.md`](actions/parse-results/README.md) |
| `actions/stash` | Store raw run results on the data branch | [`actions/stash/README.md`](actions/stash/README.md) |
| `actions/aggregate` | Build derived indexes, series, and run views | [`actions/aggregate/README.md`](actions/aggregate/README.md) |
| `actions/compare` | Compare current results to a baseline and comment on PRs | [`actions/compare/README.md`](actions/compare/README.md) |
| `actions/monitor` | Collect OTLP host and custom telemetry | [`actions/monitor/README.md`](actions/monitor/README.md) |
| `actions/emit-metric` | Emit a one-off OTLP metric to the monitor collector | [`actions/emit-metric/README.md`](actions/emit-metric/README.md) |
| `actions/repo-stats` | Collect GitHub repo statistics as benchkit metrics | [`actions/repo-stats/README.md`](actions/repo-stats/README.md) |

## Documentation

- **Start here**: [`docs/README.md`](docs/README.md)
- **Getting started**: [`docs/getting-started.md`](docs/getting-started.md)
- **Action reference**: [`docs/reference/actions.md`](docs/reference/actions.md)
- **React component guide**: [`docs/reference/react-components.md`](docs/reference/react-components.md)
- **Workflow architecture**: [`docs/workflow-architecture.md`](docs/workflow-architecture.md)
- **Schemas and data contracts**: [`schema/README.md`](schema/README.md)
- **Contributing**: [`DEVELOPING.md`](DEVELOPING.md)
