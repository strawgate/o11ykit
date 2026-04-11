# Phase #180: Benchkit Product Surface Inventory

This inventory identifies which product surfaces should remain clearly Benchkit-owned versus which can be extracted into a generic visualization or metric platform.

> **See also:** [`history/inventory-phase-180.md`](history/inventory-phase-180.md) — archived deep-dive into benchmark-specific vocabulary and codebase assumptions that informed this inventory.

## Benchkit-owned Product Surfaces (Benchmark-oriented)

These surfaces are tightly coupled to the benchmark domain: tracking performance over time, comparing runs/PRs, and correlating results with the runner environment.

### Dashboards & Views

- **`Dashboard`** (`packages/chart/src/Dashboard.tsx`): The central entry point for a project's benchmarks, integrating trends, regression detection, and system metrics.
- **`RunDashboard`** (`packages/chart/src/RunDashboard.tsx`): Optimized for PR reviews and comparing specific branches/refs; handles baseline resolution.
- **`RunDetail`** (`packages/chart/src/RunDetail.tsx`): A deep dive into a single execution, correlating benchmark results with the `Runner environment` (OS, CPU, Memory).

### Comparison & Verdicts

- **`VerdictBanner`** (`packages/chart/src/components/VerdictBanner.tsx`): The regression/improvement summary for a run or comparison.
- **`ComparisonSummaryTable`** (`packages/chart/src/components/ComparisonSummaryTable.tsx`): Detailed delta view between two benchmark runs.
- **`RunSelector`** (`packages/chart/src/components/RunSelector.tsx`): UI for choosing baseline and current runs for comparison.

### Benchmark History & Telemetry

- **`RunTable`** (`packages/chart/src/components/RunTable.tsx`): Browsing the history of stashed benchmark runs.
- **`MonitorSection`** (`packages/chart/src/components/MonitorSection.tsx`): Visualizing system metrics (CPU, Memory, etc.) collected during a benchmark run.
- **`RunnerContextPanel`** (inside `RunDetail.tsx`): Detail view of the host/environment where the benchmark was executed.

## Reusable Generic Visualization Primitives

These components are domain-agnostic and could live in a generic metric visualization library.

- **`TrendChart`** (`packages/chart/src/components/TrendChart.tsx`): Time-series line chart.
- **`ComparisonBar`** (`packages/chart/src/components/ComparisonBar.tsx`): Simple bar chart comparing multiple series.
- **`Leaderboard`** (`packages/chart/src/components/Leaderboard.tsx`): Ranked list with "winner" indication (generic ranked data).
- ~~`MetricCard`~~ (`packages/chart/src/components/MetricCard.tsx`): Internal — used by `Dashboard` but **not exported** from the package public API.
- ~~`OverviewGrid`~~ (`packages/chart/src/components/OverviewGrid.tsx`): Internal — used by `Dashboard` but **not exported** from the package public API.
- **`TagFilter`** (`packages/chart/src/components/TagFilter.tsx`): UI for filtering datasets by labels/tags.
- **`DateRangeFilter`** (`packages/chart/src/components/DateRangeFilter.tsx`): Preset and custom time window selection.

## Benchkit-specific Documentation & Examples

These materials define the "Benchkit story" and should remain in the Benchkit layer even after a split.

- **`README.md`**: Core value proposition and setup overview.
- **`docs/getting-started.md`**: The end-to-end guide for tracking benchmarks in CI.
- **`docs/reference/react-components.md`**: Documentation explaining how to use the high-level benchmark surfaces.
- **`packages/chart/README.md`**: Technical reference for the chart package and its components.
- **`packages/dashboard`**: The reference implementation of a Benchkit-powered dashboard (currently dogfooding Benchkit's own benchmarks).
