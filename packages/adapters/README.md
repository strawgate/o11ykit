# @otlpkit/adapters

Library-native adapters that project `@otlpkit/views` frames into chart-ready models.

## Adapter Modules

- `@otlpkit/adapters/chartjs`
- `@otlpkit/adapters/recharts`
- `@otlpkit/adapters/echarts`
- `@otlpkit/adapters/uplot`
- `@otlpkit/adapters/waterfall`

The goal is to preserve each chart library's idioms:

- Chart.js: configuration-first datasets
- Recharts: row-model + `dataKey` composition
- ECharts: dataset/encode-first option trees
- uPlot: aligned columnar arrays + minimal option scaffolding

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

```ts
import { toUPlotLatestValuesModel } from "@otlpkit/adapters/uplot";

const latest = toUPlotLatestValuesModel(latestValuesFrame);
// latest.labels carries x-index -> row label mapping for tick formatting
```
