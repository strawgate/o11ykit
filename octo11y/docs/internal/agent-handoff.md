# Agent Handoff

Current operational handoff for agents working in `benchkit`.

Keep this file short and execution-focused. Product direction lives in
[`../vision-and-roadmap.md`](../vision-and-roadmap.md).

## Read order

1. [`../../AGENTS.md`](../../AGENTS.md)
2. [`../../README.md`](../../README.md)
3. [`../../DEVELOPING.md`](../../DEVELOPING.md)
4. [`../../CODE_STYLE.md`](../../CODE_STYLE.md)
5. [`../README.md`](../README.md)
6. [`../vision-and-roadmap.md`](../vision-and-roadmap.md)

Then read the package or action you are about to change.

## Architecture context

OTLP JSON is the only data format. Every component operates on
`OtlpMetricsDocument`. See [`../otlp-semantic-conventions.md`](../otlp-semantic-conventions.md).

### Package dependency graph

```
@octo11y/core (generic OTLP types, parsing, retry)
    ↑
@benchkit/format (benchmark types, parsers, MetricsBatch, compare)
    ↑
actions/* + @benchkit/chart
```

Key types in `@octo11y/core`:

- `OtlpMetricsDocument` — the wire format, used everywhere
- `parseOtlp()` — parse and validate OTLP JSON
- `SeriesFile`, `IndexFile`, `RunEntry`, `DataPoint` — generic data view types

Key types in `@benchkit/format`:

- `MetricsBatch` — ergonomic wrapper with `fromOtlp()`, `filter()`, `groupBy*()`, `toOtlp()`
- `MetricPoint` — flat tuple: `{scenario, series, metric, value, unit, direction, role, tags, timestamp}`
- `buildOtlpResult()` — canonical helper for constructing `OtlpMetricsDocument` from parsed benchmarks

All parsers produce `OtlpMetricsDocument` via `buildOtlpResult()`.

## Current execution queue

### Completed: MetricsKit split (Phases 1–4)

- **Phase 1** — Boundary plan and ownership matrix (PR #263)
- **Phase 2** — Extract `@octo11y/core` with generic types, parsing, retry (PR #264)
- **Phase 3** — Explicit `@octo11y/core` imports across actions + chart (PR #265)
- **Phase 4** — Aggregation layering inventory and documentation (#196, #198)

### Blocked: Phase 5 — release and migration

- `#174` — First npm release blocked on publish-capable npm auth (`NPM_TOKEN` or local auth must satisfy npm publish 2FA or bypass-2FA token policy)
- `#182` — Release, docs, demo migration (depends on #174)
- `#183` — Epic umbrella (stays open until Phase 5 completes)

### Backlog: product features

- `#93` — dataset-local transform layer
- `#83` — `CompetitiveDashboard`
- `#56` — export/embed mode for chart components
- `#79`, `#81`, `#7` — workflow benchmark ergonomics

### FastMCP benchmark showcase (#308)

External showcase proving octo11y on a real Python project (`strawgate/fastmcp` fork).

**Current state**: `benchmarks` branch pushed to fork, 15 tests passing locally, workflow ready.  
**Next step**: #309 — merge to fork main and enable workflow.

Remaining issues:
- `#309` — Merge branch, enable workflow, verify first run
- `#310` — Add HTTP transport benchmarks
- `#311` — Add OpenAPI parsing benchmark
- `#312` — Switch import metrics from raw OTLP to emit-metric action
- `#313` — Add badges/embed to fork README
- `#314` — Propose benchmarks upstream to PrefectHQ/fastmcp

## Cross-repo context

- `strawgate/octo11y-demo` uses `@benchkit/chart` and `@benchkit/format`
- Demo repo CI clones benchkit, builds packages, then builds dashboard
- Demo issue `#4` tracks switching from `file:` deps to published npm packages
- `strawgate/fastmcp` fork — benchmark showcase, branch `benchmarks` (#308)

## Guardrails

1. Do not commit `dist/` bundles. CI builds and pushes them to `main-dist`.
2. All parsers must produce `OtlpMetricsDocument`. Do not reintroduce `BenchmarkResult` in new code.
3. Use `MetricsBatch` for data traversal in actions, not raw OTLP iteration.
4. Add tests for behavior changes.
