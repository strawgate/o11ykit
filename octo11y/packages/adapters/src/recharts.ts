import { SeriesEntry, SeriesFile } from '@benchkit/format';

import {
  alignComparisonCoordinates,
  getLatestValueRows,
  seriesEntryToCoordinates,
} from './coordinate-transforms.js';
import { AdapterBaseOptions } from './shared-contract.js';

export type RechartsTrendOptions = AdapterBaseOptions;

export interface RechartsComparisonOptions {
  baselineLabel?: string;
  currentLabel?: string;
  palette?: [string, string];
}

export interface RechartsComparisonRow {
  x: string;
  baseline?: number;
  current?: number;
}

export interface RechartsBarRow {
  label: string;
  value: number;
}

export function trendLineData(
  entry: SeriesEntry,
  options: RechartsTrendOptions = {},
): Array<{ timestamp: string; value: number }> {
  return seriesEntryToCoordinates(entry, {
    maxPoints: options.maxPoints,
    tags: options.tags,
  }).map((point) => ({
    timestamp: point.x,
    value: point.y,
  }));
}

export function comparisonLineData(
  baseline: Array<{ x: string; y: number }>,
  current: Array<{ x: string; y: number }>,
  _options: RechartsComparisonOptions = {},
): RechartsComparisonRow[] {
  const aligned = alignComparisonCoordinates(
    baseline.map((point) => ({ x: point.x, y: point.y })),
    current.map((point) => ({ x: point.x, y: point.y })),
  );

  return aligned.map((point) => {
    const row: RechartsComparisonRow = { x: point.x };
    if (point.baseline !== undefined) {
      row.baseline = point.baseline;
    }
    if (point.current !== undefined) {
      row.current = point.current;
    }
    return row;
  });
}

export function comparisonBarData(
  series: SeriesFile,
  options: RechartsTrendOptions = {},
): RechartsBarRow[] {
  return getLatestValueRows(series, {
    maxPoints: options.maxPoints,
    tags: options.tags,
  }).map((row) => ({
    label: row.label,
    value: row.value,
  }));
}