import type { SeriesFile, SeriesEntry } from "@benchkit/format";

export type DateRangePreset = "7d" | "30d" | "90d" | "all";

export interface DateRange {
  /** ISO timestamp string for the start of the range. Null means no lower bound. */
  start: string | null;
  /** ISO timestamp string for the end of the range. Null means no upper bound. */
  end: string | null;
}

const PRESET_DAYS: Record<DateRangePreset, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

/** Convert a preset to a concrete DateRange relative to now. */
export function presetToDateRange(preset: DateRangePreset, now = new Date()): DateRange {
  const days = PRESET_DAYS[preset];
  if (days === null || days === undefined) return { start: null, end: null };
  const start = new Date(now.getTime() - days * 86_400_000);
  return { start: start.toISOString(), end: null };
}

/** Filter a SeriesFile's data points to only those within the given date range. */
export function filterSeriesFileByDateRange(sf: SeriesFile, range: DateRange): SeriesFile {
  if (!range.start && !range.end) return sf;

  const startMs = range.start ? new Date(range.start).getTime() : -Infinity;
  const endMs = range.end ? new Date(range.end).getTime() : Infinity;

  const filtered: Record<string, SeriesEntry> = {};
  for (const [name, entry] of Object.entries(sf.series)) {
    const points = entry.points.filter((p) => {
      const t = new Date(p.timestamp).getTime();
      return t >= startMs && t <= endMs;
    });
    if (points.length > 0) {
      filtered[name] = { ...entry, points };
    }
  }

  return { ...sf, series: filtered };
}

export interface DateRangeFilterProps {
  value: DateRangePreset;
  onChange: (preset: DateRangePreset) => void;
  class?: string;
}

const PRESETS: DateRangePreset[] = ["7d", "30d", "90d", "all"];
const PRESET_LABELS: Record<DateRangePreset, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

export function DateRangeFilter({ value, onChange, class: className }: DateRangeFilterProps) {
  return (
    <div class={["bk-date-range", className].filter(Boolean).join(" ")} role="group" aria-label="Date range">
      {PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          class={`bk-date-range__btn${value === preset ? " bk-date-range__btn--active" : ""}`}
          aria-pressed={value === preset}
          onClick={() => onChange(preset)}
        >
          {PRESET_LABELS[preset]}
        </button>
      ))}
    </div>
  );
}
