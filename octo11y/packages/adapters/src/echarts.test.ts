import test from 'node:test';
import assert from 'node:assert/strict';

import type { SeriesEntry, SeriesFile } from '@benchkit/format';

import {
  comparisonBarOption,
  comparisonLineOption,
  trendLineOption,
} from './echarts.js';

test('trendLineOption returns basic line option object', () => {
  const entry: SeriesEntry = {
    points: [
      { timestamp: '2026-01-01T00:00:00.000Z', value: 1 },
      { timestamp: '2026-01-02T00:00:00.000Z', value: 2 },
    ],
  };

  const option = trendLineOption(entry, { metricName: 'latency_ms' }) as {
    xAxis: { data: string[] };
    series: Array<{ data: number[]; name: string }>;
  };

  assert.deepEqual(option.xAxis.data, [
    '2026-01-01T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
  ]);
  assert.equal(option.series[0].name, 'latency_ms');
  assert.deepEqual(option.series[0].data, [1, 2]);
});

test('comparisonLineOption aligns baseline/current arrays', () => {
  const option = comparisonLineOption(
    [{ x: '2026-01-01T00:00:00.000Z', y: 1 }],
    [{ x: '2026-01-02T00:00:00.000Z', y: 2 }],
  ) as {
    xAxis: { data: string[] };
    series: Array<{ data: Array<number | null> }>;
  };

  assert.deepEqual(option.xAxis.data, [
    '2026-01-01T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
  ]);
  assert.deepEqual(option.series[0].data, [1, null]);
  assert.deepEqual(option.series[1].data, [null, 2]);
});

test('comparisonBarOption maps latest series values', () => {
  const series: SeriesFile = {
    metric: 'latency_ms',
    series: {
      a: {
        points: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 4 }],
      },
      b: {
        points: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 2 }],
      },
    },
  };

  const option = comparisonBarOption(series) as {
    xAxis: { data: string[] };
    series: Array<{ data: number[] }>;
  };

  assert.deepEqual(option.xAxis.data, ['a', 'b']);
  assert.deepEqual(option.series[0].data, [4, 2]);
});