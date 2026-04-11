import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Sample } from "@benchkit/format";
import type { DataPoint } from "@octo11y/core";
import {
  samplesToDataPoints,
  dataPointsToComparisonData,
} from "./comparison-transforms.js";

describe("samplesToDataPoints", () => {
  it("maps sample t and metric value to x/y chart points", () => {
    const samples: Sample[] = [
      { t: 0, eps: 100, heap_mb: 50 },
      { t: 1, eps: 110, heap_mb: 52 },
      { t: 2, eps: 120, heap_mb: 54 },
    ];
    const result = samplesToDataPoints(samples, "eps");
    assert.deepEqual(result, [
      { x: 0, y: 100 },
      { x: 1, y: 110 },
      { x: 2, y: 120 },
    ]);
  });

  it("skips samples that do not contain the requested metric", () => {
    const samples: Sample[] = [
      { t: 0, eps: 100 },
      { t: 1 },
      { t: 2, eps: 120 },
    ];
    const result = samplesToDataPoints(samples, "eps");
    assert.deepEqual(result, [
      { x: 0, y: 100 },
      { x: 2, y: 120 },
    ]);
  });

  it("returns an empty array when samples is empty", () => {
    assert.deepEqual(samplesToDataPoints([], "eps"), []);
  });

  it("returns an empty array when no sample contains the metric", () => {
    const samples: Sample[] = [{ t: 0 }, { t: 1 }];
    assert.deepEqual(samplesToDataPoints(samples, "missing"), []);
  });

  it("works with multiple metrics independently", () => {
    const samples: Sample[] = [
      { t: 0, eps: 100, rss_mb: 200 },
      { t: 1, eps: 110, rss_mb: 210 },
    ];
    assert.deepEqual(samplesToDataPoints(samples, "rss_mb"), [
      { x: 0, y: 200 },
      { x: 1, y: 210 },
    ]);
  });
});

describe("dataPointsToComparisonData", () => {
  it("maps timestamp and value to x/y chart points", () => {
    const points: DataPoint[] = [
      { timestamp: "2026-01-01T00:00:00Z", value: 42 },
      { timestamp: "2026-01-02T00:00:00Z", value: 55 },
    ];
    const result = dataPointsToComparisonData(points);
    assert.deepEqual(result, [
      { x: "2026-01-01T00:00:00Z", y: 42 },
      { x: "2026-01-02T00:00:00Z", y: 55 },
    ]);
  });

  it("returns an empty array when points is empty", () => {
    assert.deepEqual(dataPointsToComparisonData([]), []);
  });

  it("preserves order of points", () => {
    const points: DataPoint[] = [
      { timestamp: "2026-03-01T00:00:00Z", value: 10 },
      { timestamp: "2026-01-01T00:00:00Z", value: 20 },
      { timestamp: "2026-02-01T00:00:00Z", value: 30 },
    ];
    const result = dataPointsToComparisonData(points);
    assert.equal(result[0].x, "2026-03-01T00:00:00Z");
    assert.equal(result[1].x, "2026-01-01T00:00:00Z");
    assert.equal(result[2].x, "2026-02-01T00:00:00Z");
  });
});
