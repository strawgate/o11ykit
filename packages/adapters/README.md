# @otlpkit/adapters

Library-native adapters that project `@otlpkit/views` frames into chart-ready models.

The adapter rule is simple: keep the data engine shared, but make the final object feel native to
the chart library. Tremor users should spread props. Recharts users should map `dataKey`s. uPlot
users should get aligned arrays. ECharts users should get dataset/encode options.

## Adapter Modules

- `@otlpkit/adapters/chartjs`
- `@otlpkit/adapters/engine`
- `@otlpkit/adapters/recharts`
- `@otlpkit/adapters/tremor`
- `@otlpkit/adapters/echarts`
- `@otlpkit/adapters/uplot`
- `@otlpkit/adapters/waterfall`

The goal is to preserve each chart library's idioms:

- Chart.js: configuration-first datasets
- Recharts: row-model + `dataKey` composition
- ECharts: dataset/encode-first option trees
- uPlot: aligned columnar arrays + minimal option scaffolding

## Chart Gallery

The interactive gallery at `/o11ykit/charts/` shows the same engine result rendered as Tremor,
Recharts, Chart.js, ECharts, uPlot, Nivo, Visx, Observable Plot, and Plotly shapes.

Tremor and Recharts are implemented engine-backed adapters today. The other gallery entries are
the design target for future first-class adapters: they show the native shape we want, not a generic
cross-library DTO.

| Library | Engine-backed status | User-facing shape |
| --- | --- | --- |
| Tremor | implemented | component props |
| Recharts | implemented | rows plus `dataKey` descriptors |
| Chart.js | planned | config with parsing disabled |
| ECharts | planned | dataset and encode option |
| uPlot | planned | aligned arrays |
| Nivo, Visx, Observable Plot, Plotly | research | library-native sketches |

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
import { toRechartsEngineTimeSeriesModel } from "@otlpkit/adapters/recharts";

const model = toRechartsEngineTimeSeriesModel(wide, { unit: "ms" });
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
engine series id on each descriptor.

### Existing view-frame adapters

```ts
import { toUPlotLatestValuesModel } from "@otlpkit/adapters/uplot";

const latest = toUPlotLatestValuesModel(latestValuesFrame);
// latest.labels carries x-index -> row label mapping for tick formatting
```
