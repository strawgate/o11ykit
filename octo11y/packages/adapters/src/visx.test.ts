import test from 'node:test';
import assert from 'node:assert/strict';

import type { SeriesEntry, SeriesFile } from '@benchkit/format';

import {
  comparisonBarSeries,
  comparisonLineSeries,
  trendLineSeries,
} from './visx.js';

test('trendLineSeries returns Date x points', () => {
  const entry: SeriesEntry = {
    points: [
      { timestamp: '2026-01-01T00:00:00.000Z', value: 1 },
      { timestamp: '2026-01-02T00:00:00.000Z', value: 2 },
    ],
  };

  const result = trendLineSeries(entry);

  assert.equal(result.key, 'series');
  assert.ok(result.points[0].x instanceof Date);
  assert.equal(result.points[0].y, 1);
});

test('comparisonLineSeries creates two keyed series', () => {
  const result = comparisonLineSeries(
    [{ x: '2026-01-01T00:00:00.000Z', y: 1 }],
    [{ x: '2026-01-02T00:00:00.000Z', y: 2 }],
    { baselineLabel: 'Base', currentLabel: 'Head' },
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].key, 'Base');
  assert.equal(result[1].key, 'Head');
});

test('comparisonBarSeries maps latest values', () => {
  const series: SeriesFile = {
    metric: 'latency_ms',
    series: {
      a: {
        points: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 3 }],
      },
      b: {
        points: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 1 }],
      },
    },
  };

  assert.deepEqual(comparisonBarSeries(series), [
    { label: 'a', value: 3 },
    { label: 'b', value: 1 },
  ]);
});