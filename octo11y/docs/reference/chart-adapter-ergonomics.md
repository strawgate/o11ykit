# Chart Adapter Ergonomics: Recharts, ECharts, and Visx

This document defines a concrete, developer-friendly API shape for the first three adapter targets in `@benchkit/adapters`.

Scope for this phase:
- Prioritize quick onboarding and day-1 usefulness
- Keep APIs consistent across libraries
- Skip advanced regression visual treatment for now

## Product Goal

A user should be able to go from benchkit series data to a rendered chart in under five minutes, while still having a clean path to customization.

## Shared Ergonomics Contract

All adapter modules should share these concepts and names:

- `metricName`: metric to visualize
- `maxPoints`: cap for chart readability and performance
- `tags`: optional tag filter
- `palette`: optional color overrides
- `xFormatter` and `yFormatter`: label/value formatting hooks

Shared foundation helpers live in:

- `@benchkit/adapters` root exports for common types and helpers
- `@benchkit/adapters/shared-contract` for contract-specific types/defaults
- `@benchkit/adapters/coordinate-transforms` for reusable x/y mapping and alignment helpers

All modules should provide the same three chart intents:

1. Trend line chart
2. Baseline vs current comparison line chart
3. Comparison bar chart (leaderboard/latest)

## 1) Recharts Ergonomics

### What Recharts users expect

- Flat row data objects with `dataKey` references
- JSX composition with `LineChart`, `BarChart`, `XAxis`, `YAxis`, `Tooltip`, `Legend`
- `ResponsiveContainer` for layout

### Adapter API surface

```ts
// @benchkit/adapters/recharts
import { SeriesEntry, SeriesFile } from '@benchkit/format';

export interface RechartsTrendOptions {
  metricName?: string;
  maxPoints?: number;
  tags?: Record<string, string>;
  palette?: string[];
}

export interface RechartsComparisonOptions {
  baselineLabel?: string;
  currentLabel?: string;
  palette?: [string, string];
}

export function trendLineData(
  entry: SeriesEntry,
  options?: RechartsTrendOptions,
): Array<{ timestamp: string; value: number }>;

export function comparisonLineData(
  baseline: Array<{ x: string; y: number }>,
  current: Array<{ x: string; y: number }>,
  options?: RechartsComparisonOptions,
): Array<{ x: string; baseline?: number; current?: number }>;

export function comparisonBarData(
  series: SeriesFile,
  options?: RechartsTrendOptions,
): Array<{ label: string; value: number }>;
```

### Lovable defaults

- Output data keys are always predictable: `x`, `value`, `baseline`, `current`
- Date strings are ISO and ready for `XAxis` formatters
- Default point cap: `maxPoints = 100`
- Empty input returns empty arrays (never throws)

### Minimal user experience

```tsx
const data = trendLineData(entry);

<ResponsiveContainer width="100%" height={320}>
  <LineChart data={data}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="timestamp" />
    <YAxis />
    <Tooltip />
    <Line type="monotone" dataKey="value" stroke="#2563eb" dot={false} />
  </LineChart>
</ResponsiveContainer>
```

## 2) ECharts Ergonomics

### What ECharts users expect

- A full `EChartsOption` object they can pass directly to `setOption`
- Strong default tooltip/legend/grid behavior
- Easy merging with local overrides

### Adapter API surface

```ts
// @benchkit/adapters/echarts
import { SeriesEntry, SeriesFile } from '@benchkit/format';
import type { EChartsOption } from 'echarts';

export interface EchartsBaseOptions {
  metricName?: string;
  maxPoints?: number;
  tags?: Record<string, string>;
  palette?: string[];
  title?: string;
}

export function trendLineOption(
  entry: SeriesEntry,
  options?: EchartsBaseOptions,
): EChartsOption;

export function comparisonLineOption(
  baseline: Array<{ x: string; y: number }>,
  current: Array<{ x: string; y: number }>,
  options?: EchartsBaseOptions & {
    baselineLabel?: string;
    currentLabel?: string;
  },
): EChartsOption;

export function comparisonBarOption(
  series: SeriesFile,
  options?: EchartsBaseOptions,
): EChartsOption;
```

### Lovable defaults

- Ready-to-render options with `tooltip`, `legend`, `grid`, `xAxis`, `yAxis`, and `series`
- Axis label formatters included for common timestamp/value display
- Safe defaults for large data sets with sampling + `maxPoints = 100`
- User overrides can be merged on top without rebuilding transform logic

### Minimal user experience

```ts
const option = trendLineOption(entry, { title: 'Latency trend' });
chart.setOption(option);
```

## 3) Visx Ergonomics

### What Visx users expect

- Data and accessors that fit `XYChart`, `LineSeries`, and `BarSeries`
- Control over scales and layout while avoiding boilerplate mapping
- Small, composable helpers rather than one giant opinionated component

### Adapter API surface

```ts
// @benchkit/adapters/visx
import { SeriesEntry, SeriesFile } from '@benchkit/format';

export interface VisxPoint {
  x: Date;
  y: number;
}

export interface VisxSeries {
  key: string;
  color: string;
  points: VisxPoint[];
}

export interface VisxBarDatum {
  label: string;
  value: number;
}

export function trendLineSeries(
  entry: SeriesEntry,
  options?: { maxPoints?: number; color?: string },
): VisxSeries;

export function comparisonLineSeries(
  baseline: Array<{ x: string; y: number }>,
  current: Array<{ x: string; y: number }>,
  options?: { baselineLabel?: string; currentLabel?: string; palette?: [string, string] },
): VisxSeries[];

export function comparisonBarSeries(
  series: SeriesFile,
  options?: { maxPoints?: number; palette?: string[] },
): VisxBarDatum[];
```

### Lovable defaults

- `x` is always a `Date` object for time scales
- `points` are already sorted by timestamp
- Accessor helpers are included:
  - `getX(d) => d.x`
  - `getY(d) => d.y`
- Default colors are consistent with Recharts and ECharts adapters

### Minimal user experience

```tsx
const line = trendLineSeries(entry);

<XYChart height={320} xScale={{ type: 'time' }} yScale={{ type: 'linear' }}>
  <AnimatedAxis orientation="bottom" />
  <AnimatedAxis orientation="left" />
  <AnimatedGrid columns={false} />
  <LineSeries dataKey={line.key} data={line.points} xAccessor={(d) => d.x} yAccessor={(d) => d.y} />
</XYChart>
```

## Cross-Library Consistency Rules

1. All adapters expose trend/comparison-line/comparison-bar
2. All adapters cap points with the same `maxPoints` default
3. All adapters handle empty or sparse input gracefully
4. All adapters keep transform behavior deterministic and side-effect free
5. All adapters publish small focused APIs instead of component frameworks

## Rollout Plan

Current delivery status:

- ✅ `@benchkit/adapters/recharts`
- ✅ `@benchkit/adapters/echarts`
- ✅ `@benchkit/adapters/visx`

Implementation order used:

1. Shared foundation contract + coordinate helpers
2. Recharts adapter
3. ECharts adapter
4. Visx adapter

Each rollout should include:

- Adapter source module
- One test file per chart intent (trend/comparison line/comparison bar)
- README examples for copy/paste starts
- Dashboard dogfood example in `packages/dashboard`

## Non-goals for this phase

- Advanced regression overlays and annotations
- Streaming/subscription helpers
- Theme runtime systems

These can be layered later without changing the core ergonomic contract.