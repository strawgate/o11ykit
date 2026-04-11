# @benchkit/adapters

Data transforms for converting benchkit metric data into chart-library-friendly shapes.

`@benchkit/adapters` keeps metric shaping logic separate from rendering. You can use:

- Shared contract and coordinate helpers
- Chart.js transforms
- Recharts transforms
- ECharts option builders
- Visx helpers

## Installation

```bash
npm install @benchkit/adapters
```

Install your charting library separately as needed (`chart.js`, `recharts`, `echarts`, `@visx/*`).

## Shared foundation

```ts
import {
  normalizeMaxPoints,
  validateTagFilters,
  seriesEntryToCoordinates,
  alignComparisonCoordinates,
  getLatestValueRows,
} from '@benchkit/adapters';
```

Core exports:

- `@benchkit/adapters/shared-contract`
- `@benchkit/adapters/coordinate-transforms`

## Chart.js

```typescript
import { trendChartDataset } from '@benchkit/adapters/chartjs';

const result = trendChartDataset('latency_ms', entry, {
  threshold: 10,
  window: 5,
});

console.log(result.labels, result.dataset);
```

## Recharts

```typescript
import {
  trendLineData,
  comparisonLineData,
  comparisonBarData,
} from '@benchkit/adapters/recharts';

const trend = trendLineData(entry, { maxPoints: 100 });
const comparison = comparisonLineData(baselinePoints, currentPoints);
const bars = comparisonBarData(seriesFile);
```

## ECharts

```typescript
import {
  trendLineOption,
  comparisonLineOption,
  comparisonBarOption,
} from '@benchkit/adapters/echarts';

const trendOption = trendLineOption(entry, {
  metricName: 'latency_ms',
  title: 'Latency trend',
});

const compareOption = comparisonLineOption(baselinePoints, currentPoints);
const barOption = comparisonBarOption(seriesFile);
```

## Visx

```typescript
import {
  trendLineSeries,
  comparisonLineSeries,
  comparisonBarSeries,
} from '@benchkit/adapters/visx';

const trend = trendLineSeries(entry);
const compare = comparisonLineSeries(baselinePoints, currentPoints);
const bars = comparisonBarSeries(seriesFile);
```

## Supported modules

| Library | Module | Status |
|---|---|---|
| Shared contract | `@benchkit/adapters/shared-contract` | ✅ Stable |
| Coordinate transforms | `@benchkit/adapters/coordinate-transforms` | ✅ Stable |
| Chart.js | `@benchkit/adapters/chartjs` | ✅ Stable |
| Recharts | `@benchkit/adapters/recharts` | ✅ Stable |
| ECharts | `@benchkit/adapters/echarts` | ✅ Stable |
| Visx | `@benchkit/adapters/visx` | ✅ Stable |

## Adapter intents

Each library adapter targets the same three intents:

1. Trend
2. Comparison line
3. Comparison bar

This keeps cross-library migration low-friction.

## Testing

```bash
npm run build --workspace=packages/adapters
npm run test --workspace=packages/adapters
npm run lint --workspace=packages/adapters
```

## Contributing

When adding a new adapter module:

1. Reuse shared contract and coordinate helpers first
2. Export the module in `packages/adapters/package.json`
3. Add basic-usecase tests (trend, comparison line, comparison bar)
4. Update this README with a copy-paste usage snippet

Keep transforms pure and deterministic; avoid embedding rendering-layer concerns in adapter logic.
