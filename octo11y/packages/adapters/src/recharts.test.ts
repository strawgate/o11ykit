import test from 'node:test';
import assert from 'node:assert/strict';

import type { SeriesEntry, SeriesFile } from '@benchkit/format';

import {
  comparisonBarData,
  comparisonLineData,
  trendLineData,
} from './recharts.js';

test('trendLineData returns timestamp/value rows', () => {
  const entry: SeriesEntry = {
    points: [
      { timestamp: '2026-01-01T00:00:00.000Z', value: 1 },
      { timestamp: '2026-01-02T00:00:00.000Z', value: 2 },
    ],
  };

  assert.deepEqual(trendLineData(entry), [
    { timestamp: '2026-01-01T00:00:00.000Z', value: 1 },
    { timestamp: '2026-01-02T00:00:00.000Z', value: 2 },
  ]);
});

test('comparisonLineData merges sparse x values', () => {
  assert.deepEqual(
    comparisonLineData(
      [
        { x: '2026-01-01T00:00:00.000Z', y: 1 },
        { x: '2026-01-03T00:00:00.000Z', y: 3 },
      ],
      [
        { x: '2026-01-02T00:00:00.000Z', y: 2 },
        { x: '2026-01-03T00:00:00.000Z', y: 4 },
      ],
    ),
    [
      { x: '2026-01-01T00:00:00.000Z', baseline: 1 },
      { x: '2026-01-02T00:00:00.000Z', current: 2 },
      { x: '2026-01-03T00:00:00.000Z', baseline: 3, current: 4 },
    ],
  );
});

test('comparisonBarData returns sorted latest values', () => {
  const series: SeriesFile = {
    metric: 'latency_ms',
    series: {
      a: {
        points: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 2 }],
      },
      b: {
        points: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 5 }],
      },
    },
  };

  assert.deepEqual(comparisonBarData(series), [
    { label: 'b', value: 5 },
    { label: 'a', value: 2 },
  ]);
});