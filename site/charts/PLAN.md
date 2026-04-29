# Chart Adapter Gallery Plan

Goal: build a site section that shows how the o11ykit engine feeds every supported chart library in its native idiom.

Public route: `/o11ykit/charts/`

## Product Shape

The chart gallery should be a developer-facing library of runnable examples:

1. Pick a chart library.
2. See the engine query that produced the model.
3. See the adapter call.
4. See the chart-library-native code users would write.
5. Compare snapshot and live/update behavior where the library supports it.

The gallery should make the adapter story obvious:

```ts
const result = engine.query(store, query);
const wide = toEngineWideTableModel(result);
const props = toTremorLineChartProps(wide);
```

Then:

```tsx
<LineChart {...props} />
```

## Demo Data

Use one generated TSDB dataset across every page:

- metric: `http.server.duration`
- split labels: `service`, `route`, `status_class`
- query modes:
  - raw multi-series
  - aggregate by service
  - latest by route
  - histogram-ish bucket output for non-TS charts where useful

Keep the data fixed enough that every library page is visually comparable.

## Site Structure

```text
site/charts/
  index.html                 # overview and support matrix
  PLAN.md                    # this plan
  js/
    engine-demo-data.js      # shared deterministic data/query fixture
    chart-gallery.js         # shared page state and code snippet helpers
  tremor/
    index.html
  recharts/
    index.html
  chartjs/
    index.html
  echarts/
    index.html
  uplot/
    index.html
  nivo/
    index.html
  visx/
    index.html
  observable-plot/
    index.html
  plotly/
    index.html
```

## Coverage Matrix

| Library | Time series | Area | Bar/latest | Donut/pie | Histogram | Live/update | Demo stance |
|---|---:|---:|---:|---:|---:|---|---|
| Tremor | yes | yes | yes | yes | recipe | React data updates | first wave |
| Recharts | yes | yes | yes | pie via recipe | yes | React data updates | first wave |
| Chart.js | yes | yes | yes | doughnut | yes | controller + `update('none')` | second wave |
| ECharts | yes | yes | yes | pie | yes | `setOption` plan, append spike | second wave |
| uPlot | yes | no native area focus | latest recipe | no | no | live controller + `setData` | second wave |
| Nivo | yes | yes | yes | pie | recipe | React data updates | third wave |
| Visx | yes | yes | yes | recipe | recipe | caller state updates | third wave |
| Observable Plot | yes | area mark | bar mark | no | bin transform | rebuild plot | third wave |
| Plotly | yes | filled scatter | bar | pie | histogram | `extendTraces` patch | third wave |

## Page Template

Each library page should include:

- Native chart component/config in the first viewport.
- A compact code panel with three tabs:
  - `query`
  - `adapter`
  - `library`
- A chart-type switcher limited to the library's natural chart types.
- A "live" toggle only where the adapter has a first-class update story.
- Notes for caveats that users actually hit:
  - Tremor/Recharts: client component and React state updates
  - Chart.js: time adapter, `parsing: false`, decimation
  - ECharts: `dataset` vs `appendData`
  - uPlot: aligned data, point budgets, reset scales
  - Plotly: bundle size and `scattergl`

## Implementation Phases

### Phase 1: Static Gallery Shell

- Add `/o11ykit/charts/` overview page.
- Link it from the home nav.
- Include support matrix and canonical snippets.

### Phase 2: Tremor + Recharts Live Examples

- Add React/Vite example pages or iframe from workspace examples.
- Show line, area, bar, donut/barlist for Tremor.
- Show line, area, bar, composed chart for Recharts.

### Phase 3: Existing Adapter Libraries

- Chart.js: snapshot + live append demo.
- ECharts: dataset/encode snapshot + `setOption` update plan demo.
- uPlot: aligned snapshot + streaming controller demo.

### Phase 4: Ecosystem Libraries

- Nivo, Visx, Observable Plot, Plotly pages.
- Keep modules lazily loaded so the gallery shell does not pay every chart library cost.

## Validation

- Build examples with the repo task runner.
- Add screenshot/e2e checks once pages become interactive.
- Keep every snippet copy-pasteable and backed by a test or example source file.
