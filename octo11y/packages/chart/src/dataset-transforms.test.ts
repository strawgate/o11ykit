import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { SeriesFile } from "@octo11y/core";
import type { RunDetailMetricSnapshot } from "@benchkit/format";
import {
  transformSeriesDataset,
  partitionSeriesMap,
  applyDateRangeToMap,
  detectAllRegressions,
  partitionSnapshots,
} from "./dataset-transforms.js";

function makeSeriesFile(): SeriesFile {
  return {
    metric: "events_per_sec",
    unit: "events/sec",
    direction: "bigger_is_better",
    series: {
      "worker-a": {
        tags: { process: "worker", lane: "a" },
        points: [
          { timestamp: "2026-04-01T00:00:00Z", value: 10 },
          { timestamp: "2026-04-01T00:01:00Z", value: 20 },
        ],
      },
      "worker-b": {
        tags: { process: "worker", lane: "b" },
        points: [
          { timestamp: "2026-04-01T00:00:00Z", value: 30 },
          { timestamp: "2026-04-01T00:01:00Z", value: 40 },
        ],
      },
      collector: {
        tags: { process: "collector", lane: "shared" },
        points: [
          { timestamp: "2026-04-01T00:00:00Z", value: 5 },
          { timestamp: "2026-04-01T00:01:00Z", value: 6 },
        ],
      },
    },
  };
}

describe("transformSeriesDataset", () => {
  it("filters by tag values", () => {
    const transformed = transformSeriesDataset(makeSeriesFile(), {
      filters: [{ key: "process", values: ["worker"] }],
    });
    assert.deepEqual(Object.keys(transformed.series), ["worker-a", "worker-b"]);
  });

  it("supports exclusion filters", () => {
    const transformed = transformSeriesDataset(makeSeriesFile(), {
      filters: [{ key: "process", values: ["collector"], exclude: true }],
    });
    assert.deepEqual(Object.keys(transformed.series), ["worker-a", "worker-b"]);
  });

  it("groups by tag and sums matching series", () => {
    const transformed = transformSeriesDataset(makeSeriesFile(), {
      groupByTag: "process",
      aggregate: "sum",
    });
    assert.deepEqual(Object.keys(transformed.series), ["process=worker", "process=collector"]);
    assert.deepEqual(transformed.series["process=worker"].points, [
      { timestamp: "2026-04-01T00:00:00Z", value: 40 },
      { timestamp: "2026-04-01T00:01:00Z", value: 60 },
    ]);
  });

  it("groups by tag and averages matching series", () => {
    const transformed = transformSeriesDataset(makeSeriesFile(), {
      groupByTag: "process",
      aggregate: "avg",
    });
    assert.deepEqual(transformed.series["process=worker"].points, [
      { timestamp: "2026-04-01T00:00:00Z", value: 20 },
      { timestamp: "2026-04-01T00:01:00Z", value: 30 },
    ]);
  });

  it("sorts by latest value and limits visible series", () => {
    const transformed = transformSeriesDataset(makeSeriesFile(), {
      sortByLatest: "desc",
      limit: 2,
    });
    assert.deepEqual(Object.keys(transformed.series), ["worker-b", "worker-a"]);
  });
});

// ── Map-level transforms ─────────────────────────────────────────────

describe("partitionSeriesMap", () => {
  it("splits a map by predicate", () => {
    const map = new Map<string, SeriesFile>([
      ["_monitor/cpu", { metric: "_monitor/cpu", series: {} }],
      ["latency_ms", { metric: "latency_ms", series: {} }],
      ["_monitor/mem", { metric: "_monitor/mem", series: {} }],
    ]);
    const [monitors, user] = partitionSeriesMap(map, (m) => m.startsWith("_monitor/"));
    assert.equal(monitors.size, 2);
    assert.equal(user.size, 1);
    assert.ok(monitors.has("_monitor/cpu"));
    assert.ok(monitors.has("_monitor/mem"));
    assert.ok(user.has("latency_ms"));
  });

  it("returns two empty maps when input is empty", () => {
    const [a, b] = partitionSeriesMap(new Map(), () => true);
    assert.equal(a.size, 0);
    assert.equal(b.size, 0);
  });
});

describe("applyDateRangeToMap", () => {
  function makeTimedSeries(): Map<string, SeriesFile> {
    return new Map([
      [
        "latency",
        {
          metric: "latency",
          series: {
            a: {
              points: [
                { timestamp: "2026-03-01T00:00:00Z", value: 10 },
                { timestamp: "2026-04-01T00:00:00Z", value: 20 },
              ],
            },
          },
        },
      ],
    ]);
  }

  it("returns same map when range is unbounded", () => {
    const map = makeTimedSeries();
    const result = applyDateRangeToMap(map, { start: null, end: null });
    assert.strictEqual(result, map);
  });

  it("filters points by date range", () => {
    const result = applyDateRangeToMap(makeTimedSeries(), {
      start: "2026-03-15T00:00:00Z",
      end: null,
    });
    const sf = result.get("latency")!;
    assert.equal(sf.series["a"].points.length, 1);
    assert.equal(sf.series["a"].points[0].value, 20);
  });
});

describe("detectAllRegressions", () => {
  it("detects regressions across multiple metrics", () => {
    // Build a series with enough points: 5 stable + 1 spike
    const stablePoints = Array.from({ length: 5 }, (_, i) => ({
      timestamp: `2026-04-0${i + 1}T00:00:00Z`,
      value: 100,
    }));
    const spikePoint = { timestamp: "2026-04-06T00:00:00Z", value: 200 };

    const map = new Map<string, SeriesFile>([
      [
        "latency_ms",
        {
          metric: "latency_ms",
          direction: "smaller_is_better" as const,
          series: { main: { points: [...stablePoints, spikePoint] } },
        },
      ],
      [
        "throughput",
        {
          metric: "throughput",
          direction: "bigger_is_better" as const,
          series: {
            main: {
              points: [
                { timestamp: "2026-04-01T00:00:00Z", value: 100 },
                { timestamp: "2026-04-02T00:00:00Z", value: 105 },
              ],
            },
          },
        },
      ],
    ]);

    const regressions = detectAllRegressions(map, 10, 5);
    // latency spiked 100% → regression; throughput has only 2 points → skipped
    assert.equal(regressions.size, 1);
    assert.ok(regressions.has("latency_ms"));
    assert.equal(regressions.get("latency_ms")!.length, 1);
    assert.equal(regressions.get("latency_ms")![0].seriesName, "main");
  });

  it("returns empty map when no regressions", () => {
    const points = Array.from({ length: 6 }, (_, i) => ({
      timestamp: `2026-04-0${i + 1}T00:00:00Z`,
      value: 100,
    }));
    const map = new Map<string, SeriesFile>([
      [
        "stable",
        {
          metric: "stable",
          direction: "smaller_is_better" as const,
          series: { main: { points } },
        },
      ],
    ]);
    assert.equal(detectAllRegressions(map).size, 0);
  });
});

describe("partitionSnapshots", () => {
  it("splits snapshots by predicate", () => {
    const snapshots: RunDetailMetricSnapshot[] = [
      { metric: "_monitor/cpu", values: [] },
      { metric: "latency_ms", values: [] },
      { metric: "_monitor/mem", values: [] },
    ] as RunDetailMetricSnapshot[];

    const [monitors, user] = partitionSnapshots(snapshots, (m) => m.startsWith("_monitor/"));
    assert.equal(monitors.length, 2);
    assert.equal(user.length, 1);
    assert.equal(monitors[0].metric, "_monitor/cpu");
    assert.equal(user[0].metric, "latency_ms");
  });

  it("returns two empty arrays for empty input", () => {
    const [a, b] = partitionSnapshots([], () => true);
    assert.equal(a.length, 0);
    assert.equal(b.length, 0);
  });
});
