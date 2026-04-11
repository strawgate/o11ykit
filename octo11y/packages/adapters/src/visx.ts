import { SeriesEntry, SeriesFile } from '@benchkit/format';

import {
  getLatestValueRows,
  seriesEntryToCoordinates,
} from './coordinate-transforms.js';

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

export interface VisxTrendOptions {
  maxPoints?: number;
  color?: string;
}

export interface VisxComparisonOptions {
  baselineLabel?: string;
  currentLabel?: string;
  palette?: [string, string];
}

function toVisxPoints(points: Array<{ x: string; y: number }>): VisxPoint[] {
  return [...points]
    .sort((left, right) => left.x.localeCompare(right.x))
    .map((point) => ({
      x: new Date(point.x),
      y: point.y,
    }));
}

export function trendLineSeries(
  entry: SeriesEntry,
  options: VisxTrendOptions = {},
): VisxSeries {
  return {
    key: 'series',
    color: options.color ?? '#2563eb',
    points: toVisxPoints(
      seriesEntryToCoordinates(entry, {
        maxPoints: options.maxPoints,
      }).map((point) => ({
        x: point.x,
        y: point.y,
      })),
    ),
  };
}

export function comparisonLineSeries(
  baseline: Array<{ x: string; y: number }>,
  current: Array<{ x: string; y: number }>,
  options: VisxComparisonOptions = {},
): VisxSeries[] {
  const [baselineColor = '#64748b', currentColor = '#2563eb'] = options.palette ?? [];

  return [
    {
      key: options.baselineLabel ?? 'Baseline',
      color: baselineColor,
      points: toVisxPoints(baseline),
    },
    {
      key: options.currentLabel ?? 'Current',
      color: currentColor,
      points: toVisxPoints(current),
    },
  ];
}

export function comparisonBarSeries(
  series: SeriesFile,
  options: { maxPoints?: number } = {},
): VisxBarDatum[] {
  return getLatestValueRows(series, {
    maxPoints: options.maxPoints,
  }).map((row) => ({
    label: row.label,
    value: row.value,
  }));
}