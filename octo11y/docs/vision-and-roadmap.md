# Octo11y Vision and Roadmap

Source of truth for product direction and roadmap status.

Operational agent sequencing belongs in
[`docs/internal/agent-handoff.md`](internal/agent-handoff.md).

## Product vision

Benchkit is the simplest way to publish, compare, and investigate benchmark
results from GitHub workflows.

Public-facing product surfaces are intentionally split:

- `octo11y` main site teaches the generic Actions-to-metrics pipeline with live repo metrics
- `benchkit-demo` showcases deep benchmark extraction, telemetry, and regression workflows
- `benchkit-playground` hosts fast-moving and playful metric experiments

See [`product-surface-strategy.md`](product-surface-strategy.md) for the surface definitions and boundaries.

Supported benchmark types:

- **Code benchmarks** — `go test -bench`, Rust bench, Hyperfine, pytest-benchmark
- **Workflow benchmarks** — HTTP endpoints, page loads, metric scraping, dataset ingestion
- **Hybrid benchmarks** — custom result metrics plus runner/process telemetry from `actions/monitor`

Core design principles:

- **Metrics are the primitive** — everything is an OTLP metric
- **Runs and scenarios are the primary UX surfaces**
- **OTLP JSON is the only data format** — no intermediate types

## User journeys

1. **Custom metric exploration** — explore arbitrary metrics over time
2. **Competitive benchmarking** — compare implementations, track rank, explain changes
3. **PR and run benchmarking** — compare a PR against baseline, detect regressions

## Architecture

OTLP JSON flows through every layer:

```
parsers → OtlpMetricsDocument → stash → bench-data → aggregate → views → charts
```

Key components:

- **`@octo11y/core`** — generic OTLP metric types, parsing, retry, and data structures
- **`@benchkit/format`** — parsers, `MetricsBatch`, `buildOtlpResult()`, OTLP types and semantic conventions
- **`@benchkit/chart`** — React/Preact dashboard surfaces (`RunDashboard`, `RunDetail`, trend/comparison charts)
- **`@benchkit/adapters`** — library-agnostic data transforms (filters, regressions) + Chart.js adapter
- **`actions/stash`** — writes run data to the `bench-data` branch
- **`actions/aggregate`** — produces index, series, view artifacts, and Shields.io badge JSON
- **`actions/compare`** — compares runs, posts PR comments
- **`actions/monitor`** — captures runner telemetry during benchmark jobs
- **`actions/emit-metric`** — emits custom OTLP metrics from workflow steps
- **`actions/actions-common`** — shared git helpers (configureGit, checkoutDataBranch, pushWithRetry)

Semantic conventions: [`otlp-semantic-conventions.md`](otlp-semantic-conventions.md)

## Shipped

- All parsers produce `OtlpMetricsDocument` directly (Go, Rust, Hyperfine, pytest-benchmark, benchmark-action)
- `MetricsBatch` ergonomic wrapper for OTLP data traversal
- `buildOtlpResult()` canonical document builder
- OTLP semantic conventions and validation
- `@octo11y/core` — generic OTLP types extracted from format; published to npm
- `@benchkit/adapters` — library-agnostic data transforms + Chart.js adapter
- `actions/compare` — `compareRuns()`, `formatComparisonMarkdown()`, PR comments
- `actions/stash` — job summaries, data branch writes, PR run support
- `actions/aggregate` — index, series, run-detail view artifacts, Shields.io badge JSON
- `actions/monitor` — OTel Collector v0.149.0, OTLP telemetry sidecars
- `actions/emit-metric` — reference OTLP producer with retry and exponential backoff
- `actions/actions-common` — shared git helpers across actions
- `@benchkit/chart` — `RunDashboard`, `RunDetail`, trend charts, comparison charts
- Release automation (npm trusted publishing + GitHub releases)
- Single-file workflow pattern (stash + aggregate + compare in one job)
- Producer/aggregate workflow separation with collision-proof run naming
- OTLP parsing, traversal, and validation helpers
- Stricter eslint (eqeqeq, no-throw-literal, prefer-const, no-var)

## Roadmap

### Phase 1 — Action migration to OTLP ✅

All actions now operate on `OtlpMetricsDocument` end-to-end:

| Issue | Task | Status |
|---|---|---|
| #251 | Stash: write `.otlp.json`, merge monitor OTLP | Done |
| #253 | Compare: accept `OtlpMetricsDocument` input | Done |
| #252 | Aggregate: read `.otlp.json`, build views from OTLP | Done |
| #254 | Remove `BenchmarkResult` type and all legacy code | Done |

Exit criteria met: zero references to `BenchmarkResult` in production code.

### Phase 2 — Docs and product clarity ✅

| Issue | Task | Status |
|---|---|---|
| #159 | Define current-truth docs and deprecation policy | Done |
| #160 | Clarify `packages/dashboard` role | Done (PR #260) |
| #161 | Migration-readiness and example coverage matrix | Done (PR #262) |
| #162 | Fix public dashboard accessibility | Done (PR #261) |
| #163 | Align chart docs with shipped surfaces | Done (PR #260) |
| — | Reposition the main site as Octo11y | Done (`product-surface-strategy.md`) |
| — | Define Playground as a separate fun-data recipe surface | Done (`product-surface-strategy.md`) |

### Phase 3 — Workflow benchmark ergonomics

Make it easy for new users to benchmark anything:

| Issue | Task |
|---|---|
| #79 | Workflow benchmark starter kit |
| #81 | JSON and Prometheus collector helpers |
| #7 | Integration examples and benchmark recipes |
| #93 | Dataset-local transform layer for chart views |

Exit criteria: a new user can copy a minimal recipe to benchmark an HTTP API,
a stats endpoint, a Prometheus target, or a browser workflow.

### Phase 4 — Dashboard evolution

| Issue | Task |
|---|---|
| #83 | `CompetitiveDashboard` |
| #56 | Export/embed mode for chart components |

Build on `RunDashboard`/`RunDetail` to create scenario-first and
competitive-first experiences.

### Phase 5 — MetricsKit split ✅ (core extraction complete)

`@octo11y/core` extracted as a generic OTLP metrics layer:

| Issue | Task | Status |
|---|---|---|
| #179 | Extract `@octo11y/core` package | Done (PR #264) |
| #180 | Explicit core imports across actions + chart | Done (PR #265) |
| #189–#193 | OtlpKit boundary plan and compatibility shims | Done (PR #263) |
| #182 | Release, docs, and demo migration | In progress |
| #183 | Epic umbrella | Open (closes when #182 ships) |

`@benchkit/format` re-exports core types for backward compatibility.

### Phase 6 — Advanced query

Optional DuckDB-Wasm analysis mode for power users. Not the default dashboard
dependency.

## Design constraints

- No frontend cross-file joins — aggregate produces view-shaped artifacts
- Monitor/diagnostic metrics belong in run detail, not in overviews
- Avoid over-fitting to only Go microbenchmarks
- Keep the semantic contract small and explicit
