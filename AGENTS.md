# Project Guidance

## Chart Adapter Virtue

o11ykit has a fast in-memory TSDB for metrics. Chart adapters exist to make that TSDB easy to use
with the chart library a user already wants.

The adapter goal is a thin, ergonomic shim:

- Query metrics with the TSDB engine.
- Convert the engine result into the chart library's native input shape.
- Let the chart package render the chart.

Do not add an o11ykit chart abstraction, generic chart DTO, preview-only data shape, hand-drawn chart,
or fake adapter layer to make a gallery look more complete. That defeats the product goal. If a chart
library cannot be rendered through its real package in the current app/runtime, do not put it in the
gallery.

## Gallery Contract

The chart gallery is proof that the adapters are useful and ergonomic. Every gallery entry must:

- Start from real `o11ytsdb` storage plus `ScanEngine.query(...)`.
- Prefer the optimized `RowGroupStore`/tiered store paths for gallery and product demos. Do not use
  `FlatStore` in the gallery unless the example is explicitly comparing storage backends.
- Use exported `@otlpkit/adapters/*` functions for engine-to-library conversion.
- Render with the actual chart library package named in the UI.
- Show code that a user could adapt directly.
- Have tests that lock the gallery to the exported adapter and native package renderer.

The gallery may use deterministic sample metrics so visual comparisons are stable, but those samples
must be appended into the TSDB and queried through the engine before adapters see them.

## Adapter API Design

Prefer the chart library's idioms over a shared o11ykit object model:

- Tremor should receive props users can spread onto Tremor components.
- Recharts should receive rows and `dataKey` descriptors.
- Chart.js should receive chart configuration/data.
- ECharts should receive option trees with dataset/encode where appropriate.
- uPlot should receive aligned arrays and minimal options.
- Plotly should receive traces/layout.

Keep the user's happy path short, but preserve library-native escape hatches. Add update helpers only
when they match the library's real update API.
