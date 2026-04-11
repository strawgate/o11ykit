# Metrickit / Benchkit boundary plan

This document defines the ownership boundary between the generic metric
platform (**metrickit**) and the benchmark-specific product layer
(**benchkit**). It is the output of Phase 1 (#178) of the split epic (#183).

## Guiding principles

1. **One-way dependency**: benchkit may depend on metrickit, never the reverse.
2. **No flag day**: existing `@benchkit/*` imports and `strawgate/octo11y/actions/*`
   references continue to work. New `@metrickit/*` packages are additive.
3. **Data contract stability**: existing `bench-data` branch files remain valid.
   Schema evolution is append-only or explicitly versioned.
4. **Incremental extraction**: each phase produces a working, testable state.

---

## Ownership matrix

### Packages

| Surface | Owner | Rationale |
|---|---|---|
| OTLP types (`OtlpMetricsDocument`, etc.) | metrickit | Standard OpenTelemetry protocol encoding. |
| OTLP parsing (`parseOtlp`, helpers) | metrickit | Pure OTLP deserialization, no benchmark logic. |
| `MetricsBatch` (core: filter, groupBy, merge) | metrickit | Generic metric aggregation operations. |
| `buildOtlpResult()` | benchkit | Translates benchmark structures into OTLP with `benchkit.*` attributes. |
| Benchmark parsers (Go, Rust, Hyperfine, pytest, benchmark-action) | benchkit | Format-specific parsing for benchmark tools. |
| Semantic conventions (`ATTR_*`, `VALID_DIRECTIONS`, etc.) | benchkit | Benchmark-specific OTLP attribute vocabulary. |
| `compareRuns()`, `ComparisonResult` | benchkit | Regression/improvement detection for benchmarks. |
| `formatComparisonMarkdown()` | benchkit | Benchmark comparison reporting. |
| `inferDirection()`, `validateRunKind()` | benchkit | Benchmark convention validation. |

### Chart components

| Surface | Owner | Rationale |
|---|---|---|
| `TrendChart`, `ComparisonChart`, `SampleChart`, `ComparisonBar` | metrickit | Generic time-series/comparison visualization. |
| `TagFilter`, `DateRangeFilter` | metrickit | Generic series filtering. |
| Fetch helpers (`fetchIndex`, `fetchSeries`, `fetchRun`, etc.) | metrickit | Generic HTTP data fetching. |
| Data transforms (`dataPointsToComparisonData`, `samplesToDataPoints`) | metrickit | Generic data reshaping. |
| `Dashboard` | benchkit | Benchmark-focused UI with monitor partitioning, regression detection. |
| `RunDashboard`, `RunDetail` | benchkit | Benchmark run comparison and detail views. |
| `RunTable`, `Leaderboard` | mixed | Core logic is generic; label defaults are benchmark-specific. |
| Label helpers (`defaultMetricLabel`, `isMonitorMetric`) | benchkit | Hardcoded `_monitor/` prefix and benchmark metric names. |

### Actions

| Surface | Owner | Rationale |
|---|---|---|
| `actions/monitor` | metrickit | Generic OTel Collector download, start/stop, host metrics. |
| `actions/emit-metric` | metrickit | Generic OTLP HTTP metric emission. |
| `actions/stash` | benchkit | Benchmark file parsing, result assembly, data-branch push. |
| `actions/aggregate` | mixed | Generic aggregation logic, but series key computation and `_monitor/` prefix are benchmark-specific. |
| `actions/compare` | benchkit | Benchmark regression detection and PR commenting. |

### Schemas

| Schema | Owner | Rationale |
|---|---|---|
| `index.schema.json` | metrickit | Generic run index structure. |
| `series.schema.json` | metrickit | Generic time-series structure. |
| `index-refs.schema.json` | metrickit | Generic ref-based grouping. |
| `index-prs.schema.json` | metrickit | Generic PR-based grouping. |
| `index-metrics.schema.json` | metrickit | Generic metric navigation. |
| `comparison-result.schema.json` | benchkit | Benchmark comparison output. |
| `view-run-detail.schema.json` | benchkit | Benchmark detail view with metric snapshots. |

---

## Mixed-scope seams to resolve

These are the coupling points that must be cleanly split before extraction:

1. **`MetricsBatch` scenario/series key logic** — Currently encodes `benchkit.scenario`
   and tag-based series keying. The generic `MetricsBatch` should support configurable
   grouping keys, with benchkit providing the scenario+tags default.

2. **`resolveMetricName()` and `_monitor/` prefix** — Hardcoded in aggregate and chart
   label logic. Must become a configurable partitioning function, with `_monitor/` as
   the benchkit default.

3. **`buildOtlpResult()`** — Benchmark-to-OTLP translator lives in `@benchkit/format`.
   Should move to benchkit-only scope; metrickit should only consume and emit raw OTLP.

4. **Label defaults in chart** — `defaultMetricLabel` converts `ns_per_op` → "Throughput",
   assumes `_monitor/` partitioning. These should be injectable, not hardcoded.

5. **Aggregate series key computation** — Currently reads `benchkit.scenario` + sorted
   tags to build composite series keys. Metrickit should use a generic key strategy
   (e.g., resource attributes), with benchkit providing the scenario-aware override.

---

## Public name compatibility rules

### What stays unchanged

| Name | Reason |
|---|---|
| `strawgate/octo11y/actions/stash@main-dist` | Existing workflows reference this. |
| `strawgate/octo11y/actions/aggregate@main-dist` | Existing workflows reference this. |
| `strawgate/octo11y/actions/compare@main-dist` | Existing workflows reference this. |
| `@benchkit/chart` | Published npm package, consumers import this. |
| `@benchkit/format` | Published npm package, consumers import this. |
| `benchkit.*` OTLP attributes | Existing data files on `bench-data` branches use these. |
| `bench-data` branch convention | Default for all actions. |
| `data/runs/`, `data/series/`, `data/index.json` paths | Consumed by dashboards. |

### New packages (additive)

| New name | Contents |
|---|---|
| `@metrickit/core` | OTLP types, `MetricsBatch` (generic), OTLP parsing. |
| `@metrickit/ui` | Chart primitives, fetch helpers, filters, data transforms. |

### Re-export strategy

`@benchkit/format` and `@benchkit/chart` become thin re-export shims:
- `@benchkit/format` re-exports `@metrickit/core` plus benchmark parsers, conventions, compare.
- `@benchkit/chart` re-exports `@metrickit/ui` plus Dashboard, RunDashboard, RunDetail, labels.

This means `import { MetricsBatch } from "@benchkit/format"` continues to work.

### Action re-export

`actions/monitor` and `actions/emit-metric` stay in the benchkit repo for now.
If a `metrickit` repo is created later, these actions can be published there and
the benchkit versions become thin wrappers or aliases.

---

## Data contract compatibility

### Existing files are valid forever

Run files (`data/runs/*.json`) contain OTLP with `benchkit.*` attributes. These
attributes are part of the published data contract and will not be renamed.
Metrickit will read OTLP generically (ignoring attribute names it doesn't
know) while benchkit will continue to interpret `benchkit.*` attributes.

### Schema evolution

New schemas use a `"version"` field. Existing schemas without version are
treated as version 1 and remain backward-compatible.

---

## Extraction sequence

```
Phase 2 (#179): Extract @metrickit/core from @benchkit/format
  ├── OTLP types → @metrickit/core
  ├── MetricsBatch (generic) → @metrickit/core
  ├── OTLP parsing → @metrickit/core
  └── @benchkit/format re-exports @metrickit/core

Phase 3 (#180): Extract @metrickit/ui from @benchkit/chart
  ├── Chart primitives → @metrickit/ui
  ├── Fetch helpers → @metrickit/ui
  ├── Filters → @metrickit/ui
  └── @benchkit/chart re-exports @metrickit/ui

Phase 4 (#181): Decouple aggregation
  ├── Generic aggregation → @metrickit/core
  ├── Benchmark aggregation defaults → @benchkit/format
  └── actions/aggregate uses composition

Phase 5 (#182): Release and migration
  ├── Publish @metrickit/* packages
  ├── Update docs and demo repo
  └── Announce migration path
```

---

## Decision log

| Decision | Rationale |
|---|---|
| Re-export shim, not rename | Zero breaking changes for existing consumers. |
| `benchkit.*` attributes stay forever | Existing data files depend on them. |
| Label defaults become injectable | Allows metrickit UI to be domain-agnostic. |
| `actions/monitor` stays in benchkit repo | Simpler than creating a new repo now. |
| Aggregate gets composition, not fork | One codebase with pluggable keys, not two copies. |
