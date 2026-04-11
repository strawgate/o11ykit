import test from 'node:test';
import assert from 'node:assert/strict';

import type { SeriesEntry, SeriesFile } from '@benchkit/format';

import {
  alignComparisonCoordinates,
  getLatestValueRows,
  seriesEntryToCoordinates,
} from './coordinate-transforms.js';

const entry: SeriesEntry = {
  tags: { branch: 'main', os: 'linux' },
  points: [
    { timestamp: '2026-01-03T00:00:00.000Z', value: 3 },
    { timestamp: '2026-01-01T00:00:00.000Z', value: 1 },
    { timestamp: '2026-01-02T00:00:00.000Z', value: 2 },
  ],
};

test('seriesEntryToCoordinates sorts by timestamp', () => {
  assert.deepEqual(seriesEntryToCoordinates(entry), [
    { x: '2026-01-01T00:00:00.000Z', y: 1, tags: { branch: 'main', os: 'linux' } },
    { x: '2026-01-02T00:00:00.000Z', y: 2, tags: { branch: 'main', os: 'linux' } },
    { x: '2026-01-03T00:00:00.000Z', y: 3, tags: { branch: 'main', os: 'linux' } },
  ]);
});

test('seriesEntryToCoordinates honors tag filters', () => {
  assert.deepEqual(seriesEntryToCoordinates(entry, { tags: { branch: 'other' } }), []);
});

test('alignComparisonCoordinates merges sparse series by x', () => {
  assert.deepEqual(
    alignComparisonCoordinates(
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

test('getLatestValueRows extracts latest values and sorts descending', () => {
  const series: SeriesFile = {
    metric: 'latency_ms',
    series: {
      fast: {
        points: [
          { timestamp: '2026-01-01T00:00:00.000Z', value: 1 },
          { timestamp: '2026-01-02T00:00:00.000Z', value: 2 },
        ],
      },
      slow: {
        tags: { branch: 'main' },
        points: [
          { timestamp: '2026-01-01T00:00:00.000Z', value: 4 },
          { timestamp: '2026-01-02T00:00:00.000Z', value: 6 },
        ],
      },
    },
  };

  assert.deepEqual(getLatestValueRows(series), [
    { label: 'slow', value: 6, tags: { branch: 'main' } },
    { label: 'fast', value: 2, tags: undefined },
  ]);
});