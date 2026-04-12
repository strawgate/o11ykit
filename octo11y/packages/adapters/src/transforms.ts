import {
  SeriesFile,
  SeriesEntry,
  DataPoint,
} from '@benchkit/format';

/**
 * Options for filtering and transforming metrics.
 */
export interface TransformOptions {
  metricName?: string;
  tags?: Record<string, string>;
  limit?: number;
}

/**
 * Filter series entries to those with all specified tags.
 */
export function filterMetricsByTags(
  series: SeriesFile,
  tags: Record<string, string>,
): SeriesFile {
  if (!Object.keys(tags).length) return series;

  const filteredSeries: Record<string, SeriesEntry> = {};
  
  for (const [key, entry] of Object.entries(series.series)) {
    const entryTags = entry.tags ?? {};
    const matches = Object.entries(tags).every(
      ([k, v]) => entryTags[k] === v,
    );
    if (matches) {
      filteredSeries[key] = entry;
    }
  }

  return {
    ...series,
    series: filteredSeries,
  };
}

/**
 * Extract the most recent data point from a series entry.
 */
export function getLatestDataPoint(entry: SeriesEntry): DataPoint | null {
  if (!entry.points.length) return null;
  return entry.points[entry.points.length - 1];
}

/**
 * Get the N most recent data points from a series entry.
 */
export function getLatestNPoints(
  entry: SeriesEntry,
  n: number,
): DataPoint[] {
  const points = entry.points;
  return points.slice(Math.max(0, points.length - n));
}

/**
 * Get all unique tag keys and values across all series entries.
 */
export function getUniqueTags(series: SeriesFile): Record<string, Set<string>> {
  const tags: Record<string, Set<string>> = {};
  
  for (const entry of Object.values(series.series)) {
    const entryTags = entry.tags ?? {};
    for (const [k, v] of Object.entries(entryTags)) {
      if (!tags[k]) {
        tags[k] = new Set();
      }
      tags[k].add(v);
    }
  }

  return tags;
}

/**
 * Normalize metric values to 0-100 scale for comparison.
 */
export function normalizeValues(values: number[]): number[] {
  if (!values.length) return [];
  const min = values.reduce((a, b) => Math.min(a, b), Infinity);
  const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
  const range = max - min;
  if (range === 0) return values.map(() => 50);
  return values.map((v) => ((v - min) / range) * 100);
}
