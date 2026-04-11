import { SeriesEntry, SeriesFile } from '@benchkit/format';

import {
  AdapterTagFilters,
  ComparisonCoordinatePoint,
  CoordinatePoint,
  LatestValueRow,
  normalizeMaxPoints,
  validateTagFilters,
} from './shared-contract.js';

function hasMatchingTags(
  entryTags: AdapterTagFilters | undefined,
  expectedTags: AdapterTagFilters | undefined,
): boolean {
  if (!expectedTags || !Object.keys(expectedTags).length) {
    return true;
  }

  const tags = entryTags ?? {};
  return Object.entries(expectedTags).every(([key, value]) => tags[key] === value);
}

export function seriesEntryToCoordinates(
  entry: SeriesEntry,
  options: { maxPoints?: number; tags?: AdapterTagFilters } = {},
): CoordinatePoint[] {
  const tags = validateTagFilters(options.tags);
  if (!hasMatchingTags(entry.tags, tags)) {
    return [];
  }

  const coordinates = entry.points
    .filter((point) => Number.isFinite(point.value))
    .map((point) => ({
      x: point.timestamp,
      y: point.value,
      tags: entry.tags,
    }))
    .sort((left, right) => left.x.localeCompare(right.x));

  const maxPoints = normalizeMaxPoints(options.maxPoints);
  if (coordinates.length <= maxPoints) {
    return coordinates;
  }

  const step = coordinates.length / maxPoints;
  const sampled: CoordinatePoint[] = [];

  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(coordinates[Math.floor(index * step)]);
  }

  const lastPoint = coordinates[coordinates.length - 1];
  sampled[sampled.length - 1] = lastPoint;
  return sampled;
}

export function alignComparisonCoordinates(
  baseline: CoordinatePoint[],
  current: CoordinatePoint[],
): ComparisonCoordinatePoint[] {
  const merged = new Map<string, ComparisonCoordinatePoint>();

  for (const point of baseline) {
    merged.set(point.x, {
      x: point.x,
      baseline: point.y,
    });
  }

  for (const point of current) {
    const existing = merged.get(point.x);
    const next: ComparisonCoordinatePoint = {
      x: point.x,
      current: point.y,
    };

    if (existing?.baseline !== undefined) {
      next.baseline = existing.baseline;
    }

    merged.set(point.x, next);
  }

  return Array.from(merged.values()).sort((left, right) => left.x.localeCompare(right.x));
}

export function getLatestValueRows(
  series: SeriesFile,
  options: { maxPoints?: number; tags?: AdapterTagFilters } = {},
): LatestValueRow[] {
  const tags = validateTagFilters(options.tags);

  const rows: LatestValueRow[] = [];

  for (const [label, entry] of Object.entries(series.series)) {
    if (!hasMatchingTags(entry.tags, tags)) {
      continue;
    }

    const lastPoint = [...entry.points]
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .pop();

    if (!lastPoint || !Number.isFinite(lastPoint.value)) {
      continue;
    }

    rows.push({
      label,
      value: lastPoint.value,
      tags: entry.tags,
    });
  }

  rows
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));

  const maxPoints = normalizeMaxPoints(options.maxPoints);
  return rows.slice(0, maxPoints);
}