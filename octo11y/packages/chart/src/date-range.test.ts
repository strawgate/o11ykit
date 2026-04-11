import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  presetToDateRange,
  filterSeriesFileByDateRange,
  type DateRange,
} from "./components/DateRangeFilter.js";
import type { SeriesFile } from "@octo11y/core";

function makeSeries(timestamps: string[]): SeriesFile {
  return {
    metric: "latency_ms",
    unit: "ms",
    direction: "smaller_is_better",
    series: {
      "series-a": {
        points: timestamps.map((ts) => ({ timestamp: ts, value: 10 })),
      },
    },
  };
}

describe("presetToDateRange", () => {
  const now = new Date("2026-03-15T12:00:00Z");

  it("returns 7 days back for '7d'", () => {
    const range = presetToDateRange("7d", now);
    assert.ok(range.start);
    assert.equal(range.end, null);
    const start = new Date(range.start);
    assert.equal(start.toISOString(), "2026-03-08T12:00:00.000Z");
  });

  it("returns 30 days back for '30d'", () => {
    const range = presetToDateRange("30d", now);
    assert.ok(range.start);
    const start = new Date(range.start);
    assert.equal(start.toISOString(), "2026-02-13T12:00:00.000Z");
  });

  it("returns 90 days back for '90d'", () => {
    const range = presetToDateRange("90d", now);
    assert.ok(range.start);
    const start = new Date(range.start);
    assert.equal(start.toISOString(), "2025-12-15T12:00:00.000Z");
  });

  it("returns null start/end for 'all'", () => {
    const range = presetToDateRange("all", now);
    assert.equal(range.start, null);
    assert.equal(range.end, null);
  });
});

describe("filterSeriesFileByDateRange", () => {
  it("returns all data when range is 'all' (null start/end)", () => {
    const sf = makeSeries(["2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]);
    const filtered = filterSeriesFileByDateRange(sf, { start: null, end: null });
    assert.equal(Object.keys(filtered.series).length, 1);
    assert.equal(filtered.series["series-a"].points.length, 2);
  });

  it("filters points before the start date", () => {
    const sf = makeSeries([
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-03-01T00:00:00Z",
      "2026-03-10T00:00:00Z",
    ]);
    const range: DateRange = { start: "2026-02-15T00:00:00Z", end: null };
    const filtered = filterSeriesFileByDateRange(sf, range);
    assert.equal(filtered.series["series-a"].points.length, 2);
    assert.equal(filtered.series["series-a"].points[0].timestamp, "2026-03-01T00:00:00Z");
  });

  it("filters points after the end date", () => {
    const sf = makeSeries([
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-03-01T00:00:00Z",
    ]);
    const range: DateRange = { start: null, end: "2026-01-15T00:00:00Z" };
    const filtered = filterSeriesFileByDateRange(sf, range);
    assert.equal(filtered.series["series-a"].points.length, 1);
  });

  it("removes series entirely if all points are outside the range", () => {
    const sf = makeSeries(["2025-01-01T00:00:00Z", "2025-06-01T00:00:00Z"]);
    const range: DateRange = { start: "2026-01-01T00:00:00Z", end: null };
    const filtered = filterSeriesFileByDateRange(sf, range);
    assert.equal(Object.keys(filtered.series).length, 0);
  });

  it("preserves the original series file metadata", () => {
    const sf = makeSeries(["2026-03-01T00:00:00Z"]);
    const filtered = filterSeriesFileByDateRange(sf, { start: "2026-01-01T00:00:00Z", end: null });
    assert.equal(filtered.metric, "latency_ms");
    assert.equal(filtered.unit, "ms");
    assert.equal(filtered.direction, "smaller_is_better");
  });

  it("does not mutate the original series file", () => {
    const sf = makeSeries(["2025-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]);
    const range: DateRange = { start: "2026-01-01T00:00:00Z", end: null };
    filterSeriesFileByDateRange(sf, range);
    assert.equal(sf.series["series-a"].points.length, 2);
  });

  it("handles multiple series independently", () => {
    const sf: SeriesFile = {
      metric: "latency_ms",
      unit: "ms",
      direction: "smaller_is_better",
      series: {
        "series-a": {
          points: [
            { timestamp: "2026-01-01T00:00:00Z", value: 10 },
            { timestamp: "2026-03-01T00:00:00Z", value: 20 },
          ],
        },
        "series-b": {
          points: [
            { timestamp: "2026-03-05T00:00:00Z", value: 30 },
          ],
        },
      },
    };
    const range: DateRange = { start: "2026-02-01T00:00:00Z", end: null };
    const filtered = filterSeriesFileByDateRange(sf, range);
    assert.equal(filtered.series["series-a"].points.length, 1);
    assert.equal(filtered.series["series-b"].points.length, 1);
  });
});
