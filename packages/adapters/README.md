# @otlpkit/adapters

Library-native adapters that project `@otlpkit/views` frames into chart-ready models.

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
- Recharts: row-model + `dataKey` composition
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
Recharts, Chart.js, ECharts, uPlot, Nivo, Visx, Observable Plot, Plotly, ApexCharts, Victory,
AG Charts, Highcharts, and Vega-Lite shapes. Package-backed entries mount the actual chart package
in the browser; entries without package renderers are explicitly labeled as adapter shapes only.

The gallery uses exported engine-backed adapters for every package-backed library. Tremor and
Recharts are the most polished component-level APIs; Chart.js, ECharts, uPlot, Nivo, Observable
Plot, Plotly, ApexCharts, Victory, AG Charts, Highcharts, Vega-Lite, and Visx expose first-pass
native model adapters. The gallery renders every package-backed entry with the real package; Visx is
exported as a low-level adapter shape while its package renderer waits for a dedicated React pass.

| Library | Engine-backed status | User-facing shape |
| --- | --- | --- |
| Tremor | implemented | component props |
| Recharts | implemented | rows plus `dataKey` descriptors |
| Chart.js | exported | config with parsing disabled |
| ECharts | exported | dataset and encode option |
| uPlot | exported | aligned arrays |
| Nivo, Observable Plot, Plotly, ApexCharts, Victory, AG Charts, Highcharts, Vega-Lite | exported, package-rendered gallery | library-native models |
| Visx | exported, adapter-shape gallery | accessors, series arrays, and scale hints |

## Ergonomics Audit

The engine path should feel better than starting from raw data sources because it removes the
repeated data-shaping chores without hiding the chart package's own API.

| Path | User input | User still owns | Where the engine helps |
| --- | --- | --- | --- |
| Raw REST, SQL, Prometheus, or OTLP data | Source-specific rows, samples, or frames | timestamp conversion, pivoting, sparse joins, latest-value extraction, label naming, and one-off null policy | nothing until the user writes glue |
| Chart-package native data | The exact props/config/spec/traces the chart package expects | source normalization and every library-specific reshaping step | chart package ergonomics only after data is already shaped |
| o11ykit engine adapters | `QueryResult` -> engine model -> library adapter | chart selection, styling, and optional package-specific overrides | stable series ids, sorted labels, null-safe sparse points, latest-value rows, histogram buckets, and max-point trimming |

The important design choice is that adapters do not return an o11ykit chart DTO. They return the
library's own dialect: Tremor props, Recharts rows plus `dataKey`s, uPlot aligned arrays, Plotly
traces, Vega-Lite specs, Observable Plot marks, AG Charts options, and so on. That keeps the happy
path short while preserving escape hatches for each package.

Most libraries are snapshot-first from the user's point of view. A single `toXxxModel(...)` API is
the default ergonomic surface. Libraries with efficient mutation APIs can add an optional update
helper later: uPlot `setData`, ECharts `setOption`, Plotly `extendTraces`, ApexCharts
`updateSeries`, AG Charts `update` / `updateDelta`, Highcharts `setData`, or Vega view changesets.
Those should be incremental helpers, not a second required API for everyone.

## Quick Example

```ts
import { toChartJsLineConfig } from "@otlpkit/adapters/chartjs";

const config = toChartJsLineConfig(timeSeriesFrame);
```

```ts
import { toUPlotTimeSeriesModel } from "@otlpkit/adapters/uplot";
import uPlot from "uplot";

const model = toUPlotTimeSeriesModel(timeSeriesFrame);

new uPlot(
  {
    width: 960,
    height: 480,
    title: model.options.title,
    scales: {
      x: { time: model.options.scales.x.time },
      y: { auto: model.options.scales.y.auto },
    },
    axes: model.options.axes.map((axis) => ({ ...axis })),
    series: model.options.series.map((series) => ({ ...series })),
  },
  model.data,
  element
);
```

## Engine-backed adapters

The engine layer converts `QueryResult`-shaped data into reusable chart models:

```ts
import { toEngineWideTableModel, toEngineLatestValueModel } from "@otlpkit/adapters/engine";

const wide = toEngineWideTableModel(result, {
  seriesLabel: (series) => series.labels.get("host") ?? "unknown",
});
const latest = toEngineLatestValueModel(result);
```

### Choosing a model

- `toEngineWideTableModel(result)`: line, area, stacked area, grouped bar, and any library that
  wants one row per timestamp.
- `toEngineLatestValueModel(result)`: donut, pie, bar list, KPI rows, and "current value" charts.
- `toEngineLineSeriesModel(result)`: custom marks, canvases, or libraries that prefer one array per
  series.

All engine models canonicalize series ids from sorted labels, turn non-finite values into `null`,
validate timestamp/value length alignment, and support `maxPoints` for dashboard previews.

### Adapter author checklist

New engine-backed adapters should keep the same user contract:

- Accept one of the engine models, not raw query results.
- Return the library's native shape: props, rows, config, dataset, traces, or aligned arrays.
- Preserve stable engine series ids in metadata even when the display label is shortened.
- Keep sparse points as `null` when the chart library can represent gaps.
- Filter `null` latest values for donut, pie, and bar-list charts.
- Add gallery coverage and tests that compare the gallery example with the exported adapter.

### Tremor

Tremor adapters then return native props:

```ts
import { toTremorLineChartProps, toTremorDonutChartProps } from "@otlpkit/adapters/tremor";

const line = toTremorLineChartProps(wide, {
  categoryLabel: (series) => series.labels.get("service") ?? series.label,
  connectNulls: false,
});
const donut = toTremorDonutChartProps(latest);
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
import { toEngineHistogramModel } from "@otlpkit/adapters/engine";
import {
  toRechartsEngineHistogramModel,
  toRechartsEngineScatterModel,
  toRechartsEngineTimeSeriesModel,
} from "@otlpkit/adapters/recharts";

const model = toRechartsEngineTimeSeriesModel(wide, { unit: "ms" });
const scatter = toRechartsEngineScatterModel(wide, { unit: "ms" });
const buckets = toEngineHistogramModel(wide);
const histogram = toRechartsEngineHistogramModel(buckets, { unit: "samples" });
```

```tsx
<LineChart data={model.data}>
  <XAxis dataKey={model.xAxisKey} />
  {model.series.map((series) => (
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
import { toUPlotLatestValuesModel } from "@otlpkit/adapters/uplot";

const latest = toUPlotLatestValuesModel(latestValuesFrame);
// latest.labels carries x-index -> row label mapping for tick formatting
```
