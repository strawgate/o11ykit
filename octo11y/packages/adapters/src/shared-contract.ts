export const DEFAULT_MAX_POINTS = 100;
export const MAX_ALLOWED_POINTS = 1000;

export type AxisValueFormatter = (value: string | number | Date) => string;

export type AdapterTagFilters = Record<string, string>;

export type AdapterChartIntent =
  | 'trend'
  | 'comparison-line'
  | 'comparison-bar';

export interface AdapterBaseOptions {
  metricName?: string;
  maxPoints?: number;
  tags?: AdapterTagFilters;
  palette?: string[];
  xFormatter?: AxisValueFormatter;
  yFormatter?: AxisValueFormatter;
}

export interface CoordinatePoint {
  x: string;
  y: number;
  tags?: AdapterTagFilters;
}

export interface ComparisonCoordinatePoint {
  x: string;
  baseline?: number;
  current?: number;
}

export interface LatestValueRow {
  label: string;
  value: number;
  tags?: AdapterTagFilters;
}

export function normalizeMaxPoints(
  value: number | undefined,
  defaultValue = DEFAULT_MAX_POINTS,
): number {
  if (value === undefined || Number.isNaN(value)) {
    return defaultValue;
  }

  const normalized = Math.floor(value);
  if (normalized < 1) {
    return 1;
  }

  return Math.min(normalized, MAX_ALLOWED_POINTS);
}

export function validateTagFilters(
  tags: unknown,
): AdapterTagFilters | undefined {
  if (tags === undefined) {
    return undefined;
  }

  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new TypeError('tags must be a record of string values');
  }

  const result: AdapterTagFilters = {};
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value !== 'string') {
      throw new TypeError(`tag "${key}" must have a string value`);
    }
    result[key] = value;
  }

  return result;
}