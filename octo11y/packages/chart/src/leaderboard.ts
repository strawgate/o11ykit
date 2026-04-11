import type { SeriesFile, SeriesEntry } from "@octo11y/core";

/** A single ranked entry in the leaderboard. */
export interface RankedEntry {
  name: string;
  entry: SeriesEntry;
  latestValue: number;
  previousValue: number | undefined;
  /** latestValue - previousValue, undefined when no previous point exists */
  delta: number | undefined;
  /** 1-based rank */
  rank: number;
  isWinner: boolean;
}

/**
 * Rank all series in a SeriesFile by latest value, direction-aware.
 *
 * - `smaller_is_better`: rank 1 = lowest value
 * - `bigger_is_better`: rank 1 = highest value
 * - no direction: rank 1 = lowest value (neutral)
 *
 * Series with no data points are excluded from the ranking.
 */
export function rankSeries(sf: SeriesFile): RankedEntry[] {
  const entries: Array<{ name: string; entry: SeriesEntry; latestValue: number; previousValue: number | undefined }> = [];

  for (const [name, entry] of Object.entries(sf.series)) {
    const pts = entry.points;
    if (pts.length === 0) continue;
    const latestValue = pts[pts.length - 1].value;
    const previousValue = pts.length >= 2 ? pts[pts.length - 2].value : undefined;
    entries.push({ name, entry, latestValue, previousValue });
  }

  const descending = sf.direction === "bigger_is_better";
  entries.sort((a, b) => descending ? b.latestValue - a.latestValue : a.latestValue - b.latestValue);

  return entries.map((e, idx) => ({
    name: e.name,
    entry: e.entry,
    latestValue: e.latestValue,
    previousValue: e.previousValue,
    delta: e.previousValue !== undefined ? e.latestValue - e.previousValue : undefined,
    rank: idx + 1,
    isWinner: idx === 0,
  }));
}

/**
 * Return the name of the winning series (rank 1), or undefined when there are
 * no series with data points.
 */
export function getWinner(sf: SeriesFile): string | undefined {
  const ranked = rankSeries(sf);
  return ranked.length > 0 ? ranked[0].name : undefined;
}
