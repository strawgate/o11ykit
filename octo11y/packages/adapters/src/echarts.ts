import { SeriesEntry, SeriesFile } from '@benchkit/format';

import {
  alignComparisonCoordinates,
  getLatestValueRows,
  seriesEntryToCoordinates,
} from './coordinate-transforms.js';
import { AdapterBaseOptions } from './shared-contract.js';

export type EchartsOption = Record<string, unknown>;

export interface EchartsBaseOptions extends AdapterBaseOptions {
  title?: string;
}

export interface EchartsComparisonOptions extends EchartsBaseOptions {
  baselineLabel?: string;
  currentLabel?: string;
}

function baseOption(title?: string): EchartsOption {
  return {
    title: title ? { text: title } : undefined,
    tooltip: { trigger: 'axis' },
    legend: { show: true },
    grid: { left: 48, right: 24, top: 40, bottom: 40 },
  };
}

export function trendLineOption(
  entry: SeriesEntry,
  options: EchartsBaseOptions = {},
): EchartsOption {
  const points = seriesEntryToCoordinates(entry, {
    maxPoints: options.maxPoints,
    tags: options.tags,
  });

  return {
    ...baseOption(options.title),
    xAxis: {
      type: 'category',
      data: points.map((point) => point.x),
    },
    yAxis: {
      type: 'value',
    },
    series: [
      {
        type: 'line',
        name: options.metricName ?? 'Value',
        data: points.map((point) => point.y),
        showSymbol: false,
      },
    ],
  };
}

export function comparisonLineOption(
  baseline: Array<{ x: string; y: number }>,
  current: Array<{ x: string; y: number }>,
  options: EchartsComparisonOptions = {},
): EchartsOption {
  const rows = alignComparisonCoordinates(
    baseline.map((point) => ({ x: point.x, y: point.y })),
    current.map((point) => ({ x: point.x, y: point.y })),
  );

  return {
    ...baseOption(options.title),
    xAxis: {
      type: 'category',
      data: rows.map((row) => row.x),
    },
    yAxis: {
      type: 'value',
    },
    series: [
      {
        type: 'line',
        name: options.baselineLabel ?? 'Baseline',
        data: rows.map((row) => row.baseline ?? null),
      },
      {
        type: 'line',
        name: options.currentLabel ?? 'Current',
        data: rows.map((row) => row.current ?? null),
      },
    ],
  };
}

export function comparisonBarOption(
  series: SeriesFile,
  options: EchartsBaseOptions = {},
): EchartsOption {
  const rows = getLatestValueRows(series, {
    maxPoints: options.maxPoints,
    tags: options.tags,
  });

  return {
    ...baseOption(options.title),
    xAxis: {
      type: 'category',
      data: rows.map((row) => row.label),
    },
    yAxis: {
      type: 'value',
    },
    series: [
      {
        type: 'bar',
        name: options.metricName ?? 'Value',
        data: rows.map((row) => row.value),
      },
    ],
  };
}