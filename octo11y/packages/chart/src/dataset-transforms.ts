import type { DataPoint, SeriesFile, SeriesEntry } from "@octo11y/core";
import type { RunDetailMetricSnapshot } from "@benchkit/format";
import { detectRegressions, type RegressionResult } from "./utils.js";
import { filterSeriesFileByDateRange, type DateRange } from "./components/DateRangeFilter.js";

export type DatasetAggregate = "sum" | "avg" | "max";

export interface DatasetFilter {
  key: string;
  values: string[];
  exclude?: boolean;
}

export interface TransformSeriesDatasetOptions {
  metric?: string;
  filters?: DatasetFilter[];
  groupByTag?: string;
  aggregate?: DatasetAggregate;
  sortByLatest?: "asc" | "desc";
  limit?: number;
}

function latestValue(entry: SeriesEntry): number {
  return entry.points[entry.points.length - 1]?.value ?? Number.NaN;
}

function filterEntry(entry: SeriesEntry, filters: DatasetFilter[]): boolean {
  if (filters.length === 0) return true;
  const tags = entry.tags ?? {};
  return filters.every((filter) => {
    const tagValue = tags[filter.key];
    const matches = tagValue !== undefined && filter.values.includes(tagValue);
    return filter.exclude ? !matches : matches;
  });
}

function aggregatePoints(entries: SeriesEntry[], aggregate: DatasetAggregate): DataPoint[] {
  const byTimestamp = new Map<string, number[]>();
  for (const entry of entries) {
    for (const point of entry.points) {
      const values = byTimestamp.get(point.timestamp);
      if (values) values.push(point.value);
      else byTimestamp.set(point.timestamp, [point.value]);
    }
  }

  return [...byTimestamp.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([timestamp, values]) => {
      const value = aggregate === "sum"
        ? values.reduce((sum, current) => sum + current, 0)
        : aggregate === "max"
          ? Math.max(...values)
          : values.reduce((sum, current) => sum + current, 0) / values.length;
      return { timestamp, value };
    });
}

export function transformSeriesDataset(
  series: SeriesFile,
  options: TransformSeriesDatasetOptions = {},
): SeriesFile {
  const filters = options.filters ?? [];
  const aggregate = options.aggregate ?? "sum";
  let entries = Object.entries(series.series)
    .filter(([, entry]) => filterEntry(entry, filters));

  if (options.groupByTag) {
    const groupByTag = options.groupByTag;
    const groups = new Map<string, SeriesEntry[]>();
    for (const [, entry] of entries) {
      const groupKey = entry.tags?.[groupByTag] ?? "__missing__";
      const existing = groups.get(groupKey);
      if (existing) existing.push(entry);
      else groups.set(groupKey, [entry]);
    }

    entries = [...groups.entries()].map(([groupKey, groupEntries]) => [
      `${groupByTag}=${groupKey}`,
      {
        tags: { [groupByTag]: groupKey },
        points: aggregatePoints(groupEntries, aggregate),
      },
    ]);
  }

  if (options.sortByLatest) {
    entries.sort((left, right) => {
      const leftValue = latestValue(left[1]);
      const rightValue = latestValue(right[1]);
      return options.sortByLatest === "asc"
        ? leftValue - rightValue
        : rightValue - leftValue;
    });
  }

  if (options.limit && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }

  return {
    ...series,
    metric: options.metric ?? series.metric,
    series: Object.fromEntries(entries),
  };
}

// ── Map-level transforms ─────────────────────────────────────────────

/**
 * Split a series map into two parts using a predicate on the metric name.
 * Returns `[matching, rest]`.
 */
export function partitionSeriesMap(
  map: Map<string, SeriesFile>,
  predicate: (metric: string) => boolean,
): [Map<string, SeriesFile>, Map<string, SeriesFile>] {
  const matching = new Map<string, SeriesFile>();
  const rest = new Map<string, SeriesFile>();
  for (const [metric, sf] of map) {
    (predicate(metric) ? matching : rest).set(metric, sf);
  }
  return [matching, rest];
}

/**
 * Apply a date range filter to every series file in the map.
 * Returns a new map with filtered series (empty series files are preserved
 * so metrics remain discoverable).
 */
export function applyDateRangeToMap(
  map: Map<string, SeriesFile>,
  range: DateRange,
): Map<string, SeriesFile> {
  if (!range.start && !range.end) return map;
  const filtered = new Map<string, SeriesFile>();
  for (const [metric, sf] of map) {
    filtered.set(metric, filterSeriesFileByDateRange(sf, range));
  }
  return filtered;
}

/**
 * Run regression detection across every metric in the map.
 * Returns only metrics that have at least one regression.
 */
export function detectAllRegressions(
  map: Map<string, SeriesFile>,
  threshold = 10,
  window = 5,
): Map<string, RegressionResult[]> {
  const result = new Map<string, RegressionResult[]>();
  for (const [metric, sf] of map) {
    const regressions = detectRegressions(sf, threshold, window);
    if (regressions.length > 0) result.set(metric, regressions);
  }
  return result;
}

/**
 * Partition metric snapshots (from a RunDetailView) into two arrays using
 * a predicate on the metric name. Returns `[matching, rest]`.
 */
export function partitionSnapshots(
  snapshots: RunDetailMetricSnapshot[],
  predicate: (metric: string) => boolean,
): [RunDetailMetricSnapshot[], RunDetailMetricSnapshot[]] {
  const matching: RunDetailMetricSnapshot[] = [];
  const rest: RunDetailMetricSnapshot[] = [];
  for (const s of snapshots) {
    (predicate(s.metric) ? matching : rest).push(s);
  }
  return [matching, rest];
}
