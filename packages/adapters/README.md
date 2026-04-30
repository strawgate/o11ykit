# @otlpkit/adapters

Library-native adapters that turn engine query results into chart-library-native inputs.

The adapter rule is simple: keep the data engine shared, but make the final object feel native to
the chart library. Tremor users should spread props. Recharts users should map `dataKey`s. uPlot
users should get aligned arrays. ECharts users should get dataset/encode options.

## Adapter Modules

- `@otlpkit/adapters/chartjs`
- `@otlpkit/adapters/agcharts`
- `@otlpkit/adapters/apexcharts`
- `@otlpkit/adapters/engine`
- `@otlpkit/adapters/recharts`
- `@otlpkit/adapters/tremor`
- `@otlpkit/adapters/echarts`
- `@otlpkit/adapters/highcharts`
- `@otlpkit/adapters/nivo`
- `@otlpkit/adapters/observable`
- `@otlpkit/adapters/plotly`
- `@otlpkit/adapters/uplot`
- `@otlpkit/adapters/vegalite`
- `@otlpkit/adapters/victory`
- `@otlpkit/adapters/visx`
- `@otlpkit/adapters/waterfall`

The goal is to preserve each chart library's idioms:

- Chart.js: configuration-first datasets
- Recharts: rows plus `dataKey` composition
- ECharts: dataset/encode-first option trees
- uPlot: aligned columnar arrays + minimal option scaffolding
- Plotly: traces plus layout
- ApexCharts: options plus series arrays
- Nivo: nested series, bar keys, and pie data
- Observable Plot: tidy rows plus marks
- Victory: component-oriented data series
- AG Charts and Highcharts: option trees with explicit series keys
- Vega-Lite: tidy records and declarative encodings
- Visx: low-level series arrays, accessors, and scale hints

## Chart Gallery

The interactive gallery at `/o11ykit/charts/` shows the same engine result across Tremor,
Recharts, Chart.js, ECharts, uPlot, Nivo, Observable Plot, Plotly, ApexCharts, Victory, AG Charts,
Highcharts, and Vega-Lite. Every gallery entry starts by appending deterministic metric samples into
an `o11ytsdb` `RowGroupStore`, querying them with `ScanEngine`, and then mounting the actual chart
package in the browser.

The gallery uses exported engine-backed adapters for every package-backed library. Tremor and
Recharts are the most polished component-level APIs; Chart.js, ECharts, uPlot, Nivo, Observable
Plot, Plotly, ApexCharts, Victory, AG Charts, Highcharts, and Vega-Lite expose first-pass native
input adapters. Visx remains exported as a low-level compositional adapter, but it is intentionally
not in the gallery because it is not a native chart renderer with a React 19-clean package path.

| Library | Engine-backed status | User-facing shape |
| --- | --- | --- |
| Tremor | implemented | component props |
| Recharts | implemented | rows plus `dataKey` descriptors |
| Chart.js | exported | config with parsing disabled |
| ECharts | exported | dataset and encode option |
| uPlot | exported | aligned arrays |
| Nivo, Observable Plot, Plotly, ApexCharts, Victory, AG Charts, Highcharts, Vega-Lite | exported, package-rendered gallery | library-native inputs |
| Visx | exported, not gallery-mounted | low-level accessors, series arrays, and scale hints |

## Ergonomics Audit

The engine path should feel better than starting from raw data sources because it removes the
repeated data-shaping chores without hiding the chart package's own API.

| Path | User input | User still owns | Where the engine helps |
| --- | --- | --- | --- |
| Raw REST, SQL, Prometheus, or OTLP data | Source-specific rows, samples, or frames | timestamp conversion, pivoting, sparse joins, latest-value extraction, label naming, and one-off null policy | nothing until the user writes glue |
| Chart-package native data | The exact props/config/spec/traces the chart package expects | source normalization and every library-specific reshaping step | chart package ergonomics only after data is already shaped |
| o11ykit engine adapters | `QueryResult` -> library adapter | chart selection, styling, and optional package-specific overrides | stable series ids, sorted labels, null-safe sparse points, latest-value rows, histogram buckets, and max-point trimming |

The important design choice is that adapters do not return an o11ykit chart DTO. They return the
library's own dialect: Tremor props, Recharts rows plus `dataKey`s, uPlot aligned arrays, Plotly
traces, Vega-Lite specs, Observable Plot marks, AG Charts options, and so on. That keeps the happy
path short while preserving escape hatches for each package.

Most libraries are snapshot-first from the user's point of view. A single adapter call is the
default ergonomic surface. Libraries with efficient mutation APIs can add an optional update
helper later: uPlot `setData`, ECharts `setOption`, Plotly `extendTraces`, ApexCharts
`updateSeries`, AG Charts `update` / `updateDelta`, Highcharts `setData`, or Vega view changesets.
Those should be incremental helpers, not a second required API for everyone.

## Quick Example

```ts
import { toChartJsViewLineConfig } from "@otlpkit/adapters/chartjs";

const config = toChartJsViewLineConfig(timeSeriesFrame);
```

```ts
import { toUPlotViewTimeSeriesArgs } from "@otlpkit/adapters/uplot";
import uPlot from "uplot";

const args = toUPlotViewTimeSeriesArgs(timeSeriesFrame);

new uPlot(
  {
    width: 960,
    height: 480,
    title: args.options.title,
    scales: {
      x: { time: args.options.scales.x.time },
      y: { auto: args.options.scales.y.auto },
    },
    axes: args.options.axes.map((axis) => ({ ...axis })),
    series: args.options.series.map((series) => ({ ...series })),
  },
  args.data,
  element
);
```

## Engine-backed adapters

Chart-library adapters accept `QueryResult`-shaped data directly and return the native shape for
that package:

```ts
import { toChartJsTimeSeriesConfig } from "@otlpkit/adapters/chartjs";
import { toRechartsTimeSeriesData } from "@otlpkit/adapters/recharts";
import { toTremorLineChartProps } from "@otlpkit/adapters/tremor";

const seriesLabel = (series) => series.labels.get("host") ?? "unknown";

const tremor = toTremorLineChartProps(result, { seriesLabel });
const recharts = toRechartsTimeSeriesData(result, { seriesLabel, unit: "ms" });
const chartjs = toChartJsTimeSeriesConfig(result, { seriesLabel });
```

The reusable engine normalization helpers still exist in `@otlpkit/adapters/engine` for advanced
cases where an application wants to normalize once and feed many adapters:

- `toEngineWideTableModel(...)`: line, area, stacked area, grouped bar, and any library that
  wants one row per timestamp.
- `toEngineLatestValueModel(...)`: donut, pie, bar list, KPI rows, and "current value" charts.
- `toEngineLineSeriesModel(...)`: custom marks, canvases, or libraries that prefer one array per
  series.

The public happy path should stay direct: `result -> published adapter -> native input`.
The internal engine models canonicalize series ids from sorted labels, turn non-finite values into
`null`, validate timestamp/value length alignment, and support `maxPoints` for dashboard previews.

### Adapter author checklist

New engine-backed adapters should keep the same user contract:

- Accept raw engine query results directly; optionally also accept reusable engine models.
- Return the library's native shape: props, rows, config, dataset, traces, or aligned arrays.
- Preserve stable engine series ids in metadata even when the display label is shortened.
- Keep sparse points as `null` when the chart library can represent gaps.
- Filter `null` latest values for donut, pie, and bar-list charts.
- Add gallery coverage and tests that compare the gallery example with the exported adapter.

### Tremor

Tremor adapters then return native props:

```ts
import { toTremorLineChartProps, toTremorDonutChartProps } from "@otlpkit/adapters/tremor";

const line = toTremorLineChartProps(result, {
  seriesLabel: (series) => series.labels.get("service") ?? series.label,
  connectNulls: false,
});
const donut = toTremorDonutChartProps(result);
```

```tsx
<LineChart {...line} />
<DonutChart {...donut} />
```

Tremor uses category names as object keys, so duplicate labels are de-duped and the original engine
series ids stay available in `line.meta.series`.

### Recharts

Recharts adapters expose the same engine substrate as row data plus `dataKey` metadata:

```ts
import {
  toRechartsHistogramData,
  toRechartsLatestValuesData,
  toRechartsScatterData,
  toRechartsTimeSeriesData,
} from "@otlpkit/adapters/recharts";

const data = toRechartsTimeSeriesData(result, { seriesLabel, unit: "ms" });
const scatter = toRechartsScatterData(result, { seriesLabel, unit: "ms" });
const histogram = toRechartsHistogramData(result, { seriesLabel, unit: "samples" });
const donut = toRechartsLatestValuesData(result, { seriesLabel, unit: "ms" });
```

```tsx
<LineChart data={data.data}>
  <XAxis dataKey={data.xAxisKey} />
  {data.series.map((series) => (
    <Line key={series.id} dataKey={series.dataKey} name={series.name} />
  ))}
</LineChart>
```

Recharts data keys are collision-safe with the x-axis and tooltip keys, while keeping the stable
engine series id on each descriptor. The scatter adapter returns one flat row per series point plus
`xAxisKey`, `yAxisKey`, and `seriesKey`; the histogram adapter returns the same `categoryKey` /
`valueKey` shape as the view-frame histogram adapter.

### Existing view-frame adapters

```ts
import { toUPlotViewLatestValuesArgs } from "@otlpkit/adapters/uplot";

const latest = toUPlotViewLatestValuesArgs(latestValuesFrame);
// latest.labels carries x-index -> row label mapping for tick formatting
```
