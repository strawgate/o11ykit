# @benchkit/chart

Preact components for rendering [benchkit](../../README.md) benchmark dashboards. Fetches pre-aggregated JSON from a `bench-data` branch and renders interactive trend charts, comparison bars, leaderboards, tag filters, and runner-metrics panels — all client-side with no backend.

## Installation

> **Note:** `@benchkit/chart` is not yet published to the npm registry.
> Until the first release, install from source as described below.

Clone the repository, install dependencies, and build the packages:

```bash
git clone https://github.com/strawgate/octo11y.git
cd benchkit
npm ci
npm run build
```

Then, from your project directory, link the local packages (adjust the path
to where you cloned benchkit):

```bash
npm link <path-to-benchkit>/packages/chart <path-to-benchkit>/packages/format
npm install preact
```

Or use `file:` references in your project's `package.json`:

```jsonc
{
  "dependencies": {
    "@benchkit/chart": "file:<path-to-benchkit>/packages/chart",
    "@benchkit/format": "file:<path-to-benchkit>/packages/format",
    "preact": "^10.0.0"
  }
}
```

Once published, you will be able to install directly:

```bash
npm install @benchkit/chart preact
```

## Quick start

```tsx
import "@benchkit/chart/css";
import { Dashboard } from "@benchkit/chart";

export function App() {
  return (
    <Dashboard
      source={{
        owner: "your-org",
        repo: "your-repo",
        branch: "bench-data",   // optional, this is the default
      }}
    />
  );
}
```

The `Dashboard` component fetches `data/index.json` and `data/series/*.json` from `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/…` and renders all charts automatically.

---

## Components

### `Dashboard`

The top-level ready-made dashboard. Automatically fetches data, partitions metrics into user benchmarks and `_monitor/` system metrics, detects regressions, and renders all sub-components.

```tsx
import "@benchkit/chart/css";
import { Dashboard } from "@benchkit/chart";

<Dashboard
  source={{ owner: "your-org", repo: "your-repo" }}
  metricLabelFormatter={(m) => m.replace(/_/g, " ")}
  seriesNameFormatter={(name) => name.replace(/^Benchmark/, "")}
  commitHref={(sha, run) => `https://github.com/your-org/your-repo/commit/${sha}`}
  regressionThreshold={10}
  regressionWindow={5}
/>
```

#### `DashboardProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `source` | `DataSource` | — | **Required.** Where to fetch data from. |
| `class` | `string` | — | CSS class applied to the root element. |
| `maxPoints` | `number` | `20` | Max data points per sparkline. |
| `maxRuns` | `number` | `20` | Max rows in the recent-runs table. |
| `metricLabelFormatter` | `(metric: string) => string` | — | Custom metric name renderer. |
| `seriesNameFormatter` | `(name: string, entry: SeriesEntry) => string` | — | Custom series name renderer. |
| `commitHref` | `(commit: string, run: RunEntry) => string \| undefined` | — | Builds a URL for each commit SHA in the run table. |
| `regressionThreshold` | `number` | `10` | Percentage change that triggers a regression warning. |
| `regressionWindow` | `number` | `5` | Number of preceding data points averaged for regression detection. |

---

### `TrendChart`

Renders a time-series line chart for a single metric. Optionally highlights regressed series with a red dot on their latest point.

```tsx
import "@benchkit/chart/css";
import { TrendChart } from "@benchkit/chart";
import type { SeriesFile } from "@benchkit/format";

<TrendChart
  series={seriesFile}
  title="ns/op"
  height={300}
  lineWidth={1.5}
  maxPoints={20}
  seriesNameFormatter={(name) => name.replace(/^Benchmark/, "")}
  regressions={regressionResults}
/>
```

#### `TrendChartProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `series` | `SeriesFile` | — | **Required.** Pre-aggregated series data. |
| `title` | `string` | — | Chart heading. |
| `height` | `number` | `300` | Canvas height in pixels. |
| `lineWidth` | `number` | `1.75` (`1.5` in compact mode) | Stroke width for trend lines. |
| `maxPoints` | `number` | — | Truncate each series to the most recent N points. |
| `seriesNameFormatter` | `(name: string, entry: SeriesEntry) => string` | — | Custom legend label renderer. |
| `class` | `string` | — | CSS class applied to the wrapper `<div>`. |
| `regressions` | `RegressionResult[]` | — | Regression results; affected series get a red dot on their last point. |

---

### `ComparisonBar`

Renders a horizontal (or vertical) bar chart comparing the **latest value** of each series within a metric, with optional error bars.

```tsx
import "@benchkit/chart/css";
import { ComparisonBar } from "@benchkit/chart";

<ComparisonBar
  series={seriesFile}
  title="Latest throughput"
  height={250}
  seriesNameFormatter={(name) => name.replace(/^Benchmark/, "")}
/>
```

#### `ComparisonBarProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `series` | `SeriesFile` | — | **Required.** Pre-aggregated series data. |
| `title` | `string` | — | Chart heading. |
| `height` | `number` | `250` | Canvas height in pixels. |
| `seriesNameFormatter` | `(name: string, entry: SeriesEntry) => string` | — | Custom bar label renderer. |
| `class` | `string` | — | CSS class applied to the wrapper `<div>`. |

---

### `Leaderboard`

Renders a ranked table of series sorted by their latest value, direction-aware. Highlights the winner with a ★ badge and colors delta arrows green/red.

```tsx
import "@benchkit/chart/css";
import { Leaderboard } from "@benchkit/chart";

<Leaderboard
  series={seriesFile}
  seriesNameFormatter={(name) => name.replace(/^Benchmark/, "")}
/>
```

#### `LeaderboardProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `series` | `SeriesFile` | — | **Required.** Pre-aggregated series data. |
| `seriesNameFormatter` | `(name: string, entry: SeriesEntry) => string` | — | Custom name renderer for each row. |
| `class` | `string` | — | CSS class applied to the wrapper `<div>`. |

The component renders `null` when there are no series with data, and a plain text label when only one series is present (no table needed).

---

### `TagFilter`

Renders a row of pill buttons for filtering series by their `tags`. Only rendered when at least one series carries tags; returns `null` otherwise.

```tsx
import "@benchkit/chart/css";
import { TagFilter, filterSeriesFile } from "@benchkit/chart";
import { useState } from "preact/hooks";

function MyDashboard({ seriesMap }: { seriesMap: Map<string, SeriesFile> }) {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});

  return (
    <>
      <TagFilter
        seriesMap={seriesMap}
        activeFilters={activeFilters}
        onFilterChange={setActiveFilters}
      />
      {/* pass filtered series to charts */}
      {[...seriesMap.entries()].map(([metric, sf]) => (
        <TrendChart key={metric} series={filterSeriesFile(sf, activeFilters)} title={metric} />
      ))}
    </>
  );
}
```

#### `TagFilterProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `seriesMap` | `Map<string, SeriesFile>` | — | **Required.** All series for the current view; tags are extracted from this map. |
| `activeFilters` | `Record<string, string>` | — | **Required.** Currently active `{ tagKey: tagValue }` pairs. |
| `onFilterChange` | `(filters: Record<string, string>) => void` | — | **Required.** Called with a new filter map whenever the user toggles a pill. |

Each tag key is rendered as a group of pill buttons. Clicking an active pill deactivates it; clicking an inactive pill activates it (one active value per key at a time). A **Clear filters** button appears when any filter is active.

---

### `MonitorSection`

Renders the **Runner Metrics** section for `_monitor/` prefixed metrics produced by the [Benchkit Monitor action](../../actions/monitor). Displays a runner-context card (OS, CPU, memory, poll interval) and a grid of sparklines — one per monitor metric.

```tsx
import "@benchkit/chart/css";
import { MonitorSection } from "@benchkit/chart";

<MonitorSection
  monitorSeriesMap={monitorSeriesMap}
  index={indexFile}
  maxPoints={20}
  metricLabelFormatter={(m) => m.replace(/^_monitor\//, "")}
  seriesNameFormatter={(name) => name}
  onMetricClick={(metric) => setSelected(metric)}
  selectedMetric={selectedMetric}
/>
```

#### `MonitorSectionProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `monitorSeriesMap` | `Map<string, SeriesFile>` | — | **Required.** Map of `_monitor/…` metric names to their series files. |
| `index` | `IndexFile` | — | **Required.** Full index; used to surface the latest runner context card. |
| `maxPoints` | `number` | `20` | Max data points per sparkline. |
| `metricLabelFormatter` | `(metric: string) => string` | — | Custom label renderer; defaults to stripping the `_monitor/` prefix. |
| `seriesNameFormatter` | `(name: string, entry: SeriesEntry) => string` | — | Custom series name renderer. |
| `onMetricClick` | `(metric: string) => void` | — | Called when the user clicks a monitor metric card. |
| `selectedMetric` | `string \| null` | — | Highlights the card with a matching metric name. |

The component renders `null` when `monitorSeriesMap` is empty.

---

### `RunTable`

Renders a paginated table of recent benchmark runs with columns for run ID, timestamp, commit SHA, Git ref, benchmark count, and metrics list.

```tsx
import "@benchkit/chart/css";
import { RunTable } from "@benchkit/chart";

<RunTable
  index={indexFile}
  maxRows={20}
  commitHref={(sha, run) => `https://github.com/your-org/your-repo/commit/${sha}`}
/>
```

#### `RunTableProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `index` | `IndexFile` | — | **Required.** Full index file. |
| `maxRows` | `number` | — | Limit the number of rows shown. |
| `onSelectRun` | `(runId: string) => void` | — | Called when a row is clicked. |
| `commitHref` | `(commit: string, run: RunEntry) => string \| undefined` | — | Builds a URL for each commit SHA. |
| `class` | `string` | — | CSS class applied to the `<table>` element. |

---

### `RunDetail`

Renders a deep-dive view of a single benchmark run, including metadata, metric snapshots partitioned into user and monitor metrics, and optional comparison results. Can fetch data on demand or accept a preloaded detail object.

```tsx
import "@benchkit/chart/css";
import { RunDetail } from "@benchkit/chart";

<RunDetail
  source={{ owner: "your-org", repo: "your-repo" }}
  runId="123456789-1"
  commitHref={(sha) => `https://github.com/your-org/your-repo/commit/${sha}`}
  metricLabelFormatter={(m) => m.replace(/_/g, " ")}
/>
```

#### `RunDetailProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `detail` | `RunDetailView` | — | Preloaded run detail. When provided, `source` and `runId` are ignored. |
| `source` | `DataSource` | — | **Required when `detail` is not set.** Data source for on-demand fetching. |
| `runId` | `string` | — | **Required when `detail` is not set.** Run ID to fetch. |
| `comparison` | `ComparisonResult \| null` | — | Optional comparison result to show a verdict banner + comparison table. |
| `currentLabel` | `string` | — | Label for the current run in comparison context. |
| `baselineLabel` | `string` | — | Label for the baseline run in comparison context. |
| `commitHref` | `(commit: string) => string \| undefined` | — | Builds a URL for a commit hash. |
| `metricLabelFormatter` | `(metric: string) => string` | `defaultMetricLabel` | Custom metric label renderer. |
| `class` | `string` | — | CSS class applied to the root element. |

---

### `RunDashboard`

A PR-oriented dashboard that auto-selects the latest run, resolves a baseline from the default branch, and renders run selectors, comparison verdict, and a summary table.

```tsx
import "@benchkit/chart/css";
import { RunDashboard } from "@benchkit/chart";

<RunDashboard
  source={{ owner: "your-org", repo: "your-repo" }}
  defaultBranch="main"
  regressionThreshold={5}
  commitHref={(sha) => `https://github.com/your-org/your-repo/commit/${sha}`}
/>
```

#### `RunDashboardProps`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `source` | `DataSource` | — | **Required.** Where to fetch data from. |
| `defaultBranch` | `string` | `"main"` | Branch used for baseline resolution. |
| `regressionThreshold` | `number` | `5` | Percentage change threshold for regressions. |
| `commitHref` | `(commit: string) => string \| undefined` | — | Link builder for commit hashes. |
| `metricLabelFormatter` | `(metric: string) => string` | — | Custom metric label renderer. |
| `class` | `string` | — | CSS class applied to the root element. |

---

## Formatting and label helpers

The package root intentionally exports a small set of reusable formatting and
label helpers for custom dashboards:

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

These are the stable helpers to build on when you need benchkit-flavored
display logic in your own UI. Component-local implementation helpers such as
comparison-table sorting or icon selection are not part of the package-root API.

---

## Data fetching

### `DataSource`

Describes where to fetch benchmark data from.

```ts
interface DataSource {
  owner?: string;     // GitHub repository owner
  repo?: string;      // GitHub repository name
  branch?: string;    // Data branch (default: "bench-data")
  baseUrl?: string;   // Absolute URL override — owner/repo/branch are ignored when set
}
```

When `baseUrl` is provided, files are resolved relative to that URL. Otherwise data is fetched from `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/`.

### `fetchIndex(source, signal?)`

Fetches `data/index.json` and returns an `IndexFile`.

```ts
import { fetchIndex } from "@benchkit/chart";

const index = await fetchIndex({ owner: "your-org", repo: "your-repo" });
```

### `fetchSeries(source, metric, signal?)`

Fetches `data/series/{metric}.json` and returns a `SeriesFile`.

```ts
import { fetchSeries } from "@benchkit/chart";

const series = await fetchSeries(
  { owner: "your-org", repo: "your-repo" },
  "ns_per_op",
);
```

### `fetchRun(source, runId, signal?)`

Fetches `data/runs/{runId}.json` and returns an `OtlpMetricsDocument`.

```ts
import { fetchRun } from "@benchkit/chart";

const run = await fetchRun(
  { owner: "your-org", repo: "your-repo" },
  "123456789-1",
);
```

---

## Ranking utilities

### `rankSeries(sf)`

Ranks all series in a `SeriesFile` by latest value, direction-aware. Returns a `RankedEntry[]` sorted by rank ascending (rank 1 = best).

```ts
import { rankSeries } from "@benchkit/chart";

const ranked = rankSeries(seriesFile);
ranked.forEach((r) => {
  console.log(`${r.rank}. ${r.name}: ${r.latestValue} (winner: ${r.isWinner})`);
});
```

#### `RankedEntry`

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Series name (key in `SeriesFile.series`). |
| `entry` | `SeriesEntry` | The original series entry. |
| `latestValue` | `number` | Most recent data-point value. |
| `previousValue` | `number \| undefined` | Second-most-recent value, if available. |
| `delta` | `number \| undefined` | `latestValue − previousValue`. |
| `rank` | `number` | 1-based rank. |
| `isWinner` | `boolean` | `true` for the first-ranked entry. |

Ranking direction:

| `SeriesFile.direction` | Rank 1 |
|------------------------|--------|
| `smaller_is_better` | Lowest value |
| `bigger_is_better` | Highest value |
| *(unset)* | Lowest value |

### `getWinner(sf)`

Returns the `name` of the rank-1 series, or `undefined` when there are no series with data points.

```ts
import { getWinner } from "@benchkit/chart";

const winner = getWinner(seriesFile);
if (winner) console.log(`Winner: ${winner}`);
```

---

## Regression detection

### `detectRegressions(series, threshold?, window?)`

Scans each series in a `SeriesFile` for a regression on the most recent data point relative to the rolling mean of the previous `window` points. Returns a `RegressionResult[]` (empty array when there are insufficient data points or no regressions are found).

```ts
import { detectRegressions } from "@benchkit/chart";

const regressions = detectRegressions(
  seriesFile,
  10,  // threshold: flag when change exceeds 10 %
  5,   // window: average the previous 5 data points
);
```

A regression is detected when:

| `SeriesFile.direction` | Condition |
|------------------------|-----------|
| `smaller_is_better` | Latest value **increased** by more than `threshold`% vs the rolling mean |
| `bigger_is_better` | Latest value **decreased** by more than `threshold`% vs the rolling mean |

Returns `[]` when any series has fewer than `window + 1` data points (not enough history).

#### `RegressionResult`

| Field | Type | Description |
|-------|------|-------------|
| `seriesName` | `string` | Series name (key in `SeriesFile.series`). |
| `latestValue` | `number` | The most recent data-point value. |
| `previousMean` | `number` | Mean of the previous `window` data points. |
| `percentChange` | `number` | Percentage change from `previousMean` to `latestValue` (positive = increase). |
| `window` | `number` | Actual number of preceding points that were averaged. |

### `regressionTooltip(metric, result, metricLabelFormatter?)`

Builds a human-readable tooltip string for a single `RegressionResult`.

```ts
import { regressionTooltip } from "@benchkit/chart";

const tip = regressionTooltip("ns_per_op", regressionResult);
// e.g. "ns_per_op increased 15.3% vs 5-run average (320 → 368)"
```

---

## Tag filtering utilities

### `extractTags(seriesMap)`

Extracts all unique tag keys and their possible values from a collection of `SeriesFile`s. Returns `Record<string, string[]>` with values sorted alphabetically.

```ts
import { extractTags } from "@benchkit/chart";

const tags = extractTags(seriesMap);
// e.g. { arch: ["arm64", "x86_64"], runtime: ["go1.22", "go1.23"] }
```

### `filterSeriesFile(sf, activeFilters)`

Returns a copy of a `SeriesFile` with only the series entries that match **all** active filters. When `activeFilters` is empty the original object is returned unchanged.

```ts
import { filterSeriesFile } from "@benchkit/chart";

const filtered = filterSeriesFile(seriesFile, { arch: "arm64" });
```

---

## Usage patterns

> **Note:** The functions below (`CompetitiveDashboard`, `EvolutionDashboard`) are **illustrative usage patterns**, not exported components. They show how to compose the exported primitives for common scenarios. See [issue #83](https://github.com/strawgate/octo11y/issues/83) for the status of a real `CompetitiveDashboard` component.

### Competitive benchmarking

Use this pattern when you want to compare multiple implementations (series) for the same metric. `Leaderboard` and `ComparisonBar` are the primary components here.

```tsx
import { TrendChart, ComparisonBar, Leaderboard, TagFilter, filterSeriesFile } from "@benchkit/chart";
import { useState } from "preact/hooks";

// Example pattern — not an exported component
function CompetitiveDashboard({ seriesMap }: { seriesMap: Map<string, SeriesFile> }) {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});

  return (
    <>
      {/* Filter pills — only shown when series carry tags */}
      <TagFilter
        seriesMap={seriesMap}
        activeFilters={activeFilters}
        onFilterChange={setActiveFilters}
      />

      {[...seriesMap.entries()].map(([metric, sf]) => {
        const filtered = filterSeriesFile(sf, activeFilters);
        return (
          <div key={metric} style={{ marginBottom: "32px" }}>
            <h2>{metric}</h2>

            {/* Trend lines for every implementation */}
            <TrendChart series={filtered} title="Over time" />

            {/* Side-by-side latest-value comparison */}
            <ComparisonBar series={filtered} title="Latest comparison" />

            {/* Ranked table with winner badge */}
            <Leaderboard series={filtered} />
          </div>
        );
      })}
    </>
  );
}
```

### Evolution tracking

Use this pattern when you have a single implementation and want to track how it changes over time across commits. `TrendChart` with `regressions` highlighting is the primary component here.

```tsx
import { TrendChart, detectRegressions, regressionTooltip } from "@benchkit/chart";

// Example pattern — not an exported component
function EvolutionDashboard({ seriesMap }: { seriesMap: Map<string, SeriesFile> }) {
  return (
    <>
      {[...seriesMap.entries()].map(([metric, sf]) => {
        const regressions = detectRegressions(sf, 10, 5);
        const hasRegression = regressions.length > 0;

        return (
          <div
            key={metric}
            style={{ border: hasRegression ? "1px solid #fca5a5" : "1px solid #e5e7eb" }}
            title={regressions.map((r) => regressionTooltip(metric, r)).join("\n")}
          >
            {hasRegression && <span>⚠ regression detected</span>}
            <TrendChart
              series={sf}
              title={metric}
              regressions={regressions}
            />
          </div>
        );
      })}
    </>
  );
}
```

---

## License

MIT
