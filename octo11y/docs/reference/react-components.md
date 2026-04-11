# React and Preact component guide

Benchkit's UI package is [`@benchkit/chart`](../../packages/chart/README.md). This page is a guide to the main surfaces and when to use them. For full prop tables and API details, use the package README.

## Shipped-surface matrix

All components below are exported from `@benchkit/chart` and are the supported public API.

| Component | Category | Typical use |
|---|---|---|
| `Dashboard` | Ready-made surface | Metric-first overview with trend charts, regressions, and monitor panels |
| `RunDashboard` | Ready-made surface | PR- or run-oriented entry point with baseline comparison |
| `RunDetail` | Ready-made surface | Deep-dive page for a single run's metrics and diagnostics |
| `TrendChart` | Chart primitive | Time-series history of one metric |
| `ComparisonBar` | Chart primitive | Latest-value comparison across series within one metric |
| `Leaderboard` | Chart primitive | Ranked, direction-aware latest-value comparison |
| `RunTable` | Chart primitive | Recent-run browsing and selection |
| `MonitorSection` | Chart primitive | `_monitor` diagnostics from benchkit monitoring flows |
| `TagFilter` | Filter | Lightweight series filtering by tag |
| `DateRangeFilter` | Filter | Preset or custom time-window selection |

> **Note:** Some documentation (including the chart README) shows `CompetitiveDashboard` and `EvolutionDashboard` as illustrative usage patterns. These are **not** exported components — they demonstrate how to compose the primitives above into custom layouts.

## Start with the ready-made surfaces

### `Dashboard`

Use `Dashboard` when you want the default metric-oriented experience with minimal setup.

It fetches benchkit data directly from a `bench-data` branch and renders:

- trend charts
- comparison bars
- a recent-runs table
- monitor metrics when present

Reference: [`../../packages/chart/README.md`](../../packages/chart/README.md)

### `RunDashboard`

Use `RunDashboard` when you want a run- or PR-oriented entry point rather than a single metric-first page.

Typical fit:

- browsing runs by ref or PR
- linking users into run-level detail
- building a benchmark homepage around recent runs

### `RunDetail`

Use `RunDetail` when you already know the run ID and want a detail page for one run.

Typical fit:

- viewing all metrics for one run
- pairing outcome metrics with diagnostics
- linking from PR or run lists into a focused drilldown page

## Chart primitives

These are the building blocks used by the higher-level surfaces.

### `TrendChart`

Use for time-series history of one metric.

### `ComparisonBar`

Use for latest-value comparison across series within one metric.

### `Leaderboard`

Use for ranked, direction-aware latest-value comparisons.

### `RunTable`

Use for recent-run browsing and selection.

### `MonitorSection`

Use for `_monitor` diagnostics captured by benchkit monitoring flows.

## Filtering and view helpers

### `TagFilter`

Use when series carry tags and users need lightweight filtering.

### `DateRangeFilter`

Use when you want preset or custom time windows for one dataset.

### Dataset-local transforms

Benchkit includes dataset-local transform helpers for reshaping one already-fetched dataset without introducing browser-side cross-file joins.

These are useful for:

- filtering one dataset
- grouping within one dataset
- aggregating visible series
- sorting or limiting visible series

## Formatting and label helpers

When you are composing your own UI around benchkit data, prefer the package-root
helpers that are intentionally shared across dashboard surfaces:

- `formatValue()`
- `formatFixedValue()`
- `formatRef()`
- `formatPct()`
- `formatTimestamp()`
- `shortCommit()`
- `formatDirection()`
- `defaultMetricLabel()`
- `defaultMonitorMetricLabel()`
- `isMonitorMetric()`

These are the supported formatting/label helpers to depend on. Lower-level
component internals such as comparison-row sorting or icon-selection helpers are
not part of the documented public surface.

## Data-fetch helpers

The chart package also exports fetch helpers such as:

- `fetchIndex()`
- `fetchSeries()`
- `fetchRun()`
- `fetchRefIndex()`
- `fetchPrIndex()`
- `fetchMetricSummary()`
- `fetchRunDetail()`
- `compareRuns()`

Use them when you are composing your own UI instead of using the ready-made surfaces.

## Recommended reading

- Full package reference: [`../../packages/chart/README.md`](../../packages/chart/README.md)
- Getting started: [`../getting-started.md`](../getting-started.md)
- Data layout: [`../artifact-layout.md`](../artifact-layout.md)
