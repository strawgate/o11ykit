import type { HistogramFrame, TimeSeriesFrame } from "@otlpkit/views";

export interface PivotedRow {
  timeUnixNano: string | null;
  timeMs: number | null;
  isoTime: string | null;
  [key: string]: number | string | null;
}

export function pivotTimeSeriesFrame(frame: TimeSeriesFrame): {
  readonly dimensions: readonly string[];
  readonly rows: readonly PivotedRow[];
} {
  const rows = new Map<string, PivotedRow>();

  for (const series of frame.series) {
    for (const point of series.points) {
      const key = point.timeUnixNano;
      const row = rows.get(key) ?? {
        timeUnixNano: point.timeUnixNano,
        timeMs: point.timeMs,
        isoTime: point.isoTime,
      };
      row[series.key] = point.value;
      rows.set(key, row);
    }
  }

  return {
    dimensions: ["timeMs", "isoTime", ...frame.series.map((series) => series.key)],
    rows: [...rows.values()].sort((left, right) => Number(left.timeMs) - Number(right.timeMs)),
  };
}

export function histogramRows(frame: HistogramFrame): readonly {
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly count: number;
}[] {
  return frame.bins.map((bin) => ({
    label: bin.label,
    start: bin.start,
    end: bin.end,
    count: bin.count,
  }));
}
