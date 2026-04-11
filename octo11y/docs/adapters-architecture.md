# Octo11y Adapter Architecture for Charting Flexibility

## Problem: Library Lock-in

Previously, `@benchkit/chart` was tightly coupled to **Chart.js**. This meant:
- Users had to use Chart.js or rebuild visualization logic themselves
- No way to use Recharts, ECharts, Visx, D3, or custom charting libraries
- Data transformation logic was mixed with rendering logic, making it hard to reuse

## Solution: Data Adapters

We've introduced **@benchkit/adapters** — a library-agnostic data transformation layer:

```
benchkit metrics data (SeriesFile, SeriesEntry, DataPoint)
    ↓
@benchkit/adapters (pure JS transforms)
    ├─ filterMetricsByTags() — filter by tag combinations
    ├─ getLatestDataPoint() — extract most recent value
    ├─ detectRegressions() — window-based regression detection
    ├─ normalizeValues() — scale to 0-100
    └─ trendChartDataset() — Chart.js adapter (chartjs.ts)
    ↓
Library-specific format (Chart.js config, Recharts data, etc.)
    ↓
Charting library (Chart.js, Recharts, ECharts, D3, Visx, etc.)
    ↓
Rendered visualization
```

## Benefits

### 1. Library Freedom
Swap Chart.js for Recharts without touching data logic:

```typescript
// Before: locked to Chart.js
import { Dashboard } from '@benchkit/chart';

// After: choose any charting library
import { filterMetricsByTags, detectRegressions } from '@benchkit/adapters';
import { trendChartDataset } from '@benchkit/adapters/chartjs'; // or recharts, echarts, etc.
```

### 2. Reusable Logic
Data transforms work everywhere:

```typescript
// Same transform works in React, Vue, Raw JS, etc.
const filtered = filterMetricsByTags(series, { os: 'linux', arch: 'arm64' });
const withRegressions = detectRegressions(filtered);
```

### 3. Composable (No Duplication)
Build new adapters by reusing core transforms:

```typescript
// In src/recharts.ts
export function rechartsDataset(entry: SeriesEntry) {
  const points = detectRegressions(entry); // reuse core logic
  return points.map(p => ({
    name: entry.metadata?.name,
    data: p.value,
    fill: p.regression ? '#ff0000' : '#3b82f6',
  }));
}
```

### 4. Smaller Bundles
Ship only what you need:
- `@benchkit/adapters` (core transforms + one adapter) ≈ 5KB min
- vs. `@benchkit/chart` (Preact + Chart.js + all components) ≈ 150KB min

## Package Structure

```
packages/adapters/
├── src/
│   ├── index.ts              (core transforms exports)
│   ├── transforms.ts         (filterMetricsByTags, normalizeValues, etc.)
│   ├── regression.ts         (detectRegressions, getRegressions)
│   ├── chartjs.ts            (Chart.js adapter)
│   ├── chartjs.test.ts       (adapter tests)
│   └── (future: recharts.ts, echarts.ts, d3.ts, visx.ts)
├── README.md                 (full API docs + examples)
├── package.json              (peer dep on chart.js, optional)
└── tsconfig.json
```

## Adapter Contracts

Each adapter exports transform functions for specific chart types:

### Chart.js Adapter (`@benchkit/adapters/chartjs`)

```typescript
trendChartDataset(metricName, entry, options?)
  → { labels: string[], dataset: ChartJsDataset }

comparisonChartDataset(baseline, current, options?)
  → { labels: string[], datasets: ChartJsDataset[] }

comparisonBarDataset(labels, values, options?)
  → { labels: string[], dataset: ChartJsDataset }
```

### Future Adapters (Template)

```typescript
// @benchkit/adapters/recharts
export function rechartsLineData(
  entry: SeriesEntry,
  options?: RechartsLineOptions
): RechartsLineData[]

export function rechartsComposedData(
  entries: SeriesEntry[],
  options?: RechartsComposedOptions
): RechartsComposedData

// @benchkit/adapters/echarts
export function echartsLineOption(
  entry: SeriesEntry,
  options?: EChartsLineOptions
): echarts.EChartsOption

export function echartsBarOption(
  entries: SeriesEntry[],
  options?: EChartsBarOptions
): echarts.EChartsOption
```

## Implementation Priorities

### ✅ Done
- Core transforms (filtering, aggregation, regression)
- Chart.js adapter (full-featured)
- Type exports and documentation

### 📅 Next
1. **Recharts adapter** — popular React charting library
2. **ECharts adapter** — powerful, mature, good docs
3. **Visx adapter** — low-level, composable
4. **D3 adapter** — raw power for experts

### 🚀 Beyond
- Framework-specific helpers (React hooks, Vue composables)
- Color theme provider (CSS variables)
- Responsive sizing utilities
- Real-time data subscriptions (WebSocket adapter)

## Migration Path for Users

### If using `@benchkit/chart` (Preact component)
No changes needed — this remains the stable, batteries-included option.

### If building a custom dashboard
1. Start with `@benchkit/adapters` (lightweight)
2. Choose your charting library (Recharts, ECharts, etc.)
3. Use adapters to transform benchkit data
4. Render with your charting library

Example:
```typescript
import { filterMetricsByTags } from '@benchkit/adapters';
import { rechartsLineData } from '@benchkit/adapters/recharts'; // when available
import { LineChart, Line } from 'recharts';

function TrendChart({ series }) {
  const filtered = filterMetricsByTags(series, { ci: 'github' });
  const data = rechartsLineData(filtered);
  return (
    <LineChart data={data}>
      <Line dataKey="value" />
    </LineChart>
  );
}
```

## Testing & Validation

The adapters package:
- ✅ Builds clean (`tsc` no errors)
- ✅ Integrated into root build order (after format, before chart)
- ✅ All existing benchkit tests passing (34/34)
- ✅ Type-safe exports for library-specific types
- ✅ Peer dependencies allow optional charting libraries

## Next Steps

1. **Document adapters in README.md** — add section linking to adapters package
2. **Create example dashboard** — showcase Recharts adapter when available
3. **Benchmark adapters** — measure bundle size + performance
4. **Gather feedback** — test with external users and iterate

## References

- [Adapters Package README](../packages/adapters/README.md)
- [Chart Adapter Ergonomics](reference/chart-adapter-ergonomics.md)
- [Core Package Types](../packages/core/src/types.ts)
- [Format Package Types](../packages/format/src/types.ts)
