import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { detectRegressions, regressionTooltip } from "./utils.js";
import type { SeriesFile } from "@octo11y/core";

function makeSeriesFile(
  values: number[],
  direction: SeriesFile["direction"] = "smaller_is_better",
): SeriesFile {
  return {
    metric: "ns_per_op",
    unit: "ns/op",
    direction,
    series: {
      BenchmarkFoo: {
        points: values.map((v, i) => ({
          timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
          value: v,
        })),
      },
    },
  };
}

describe("detectRegressions", () => {
  it("returns empty array when fewer than window+1 points", () => {
    const sf = makeSeriesFile([100, 100, 100, 100, 100]); // 5 points, window=5 → need 6
    assert.deepEqual(detectRegressions(sf), []);
  });

  it("returns empty array with exactly window+1 points but no regression", () => {
    const sf = makeSeriesFile([100, 100, 100, 100, 100, 100]); // 6 points, stable
    assert.deepEqual(detectRegressions(sf), []);
  });

  it("detects regression for smaller_is_better when latest value increases above threshold", () => {
    // Mean of previous 5 = 100, latest = 115 → +15%
    const sf = makeSeriesFile([100, 100, 100, 100, 100, 115]);
    const results = detectRegressions(sf, 10, 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].seriesName, "BenchmarkFoo");
    assert.equal(results[0].latestValue, 115);
    assert.equal(results[0].previousMean, 100);
    assert.ok(results[0].percentChange > 14 && results[0].percentChange < 16);
    assert.equal(results[0].window, 5);
  });

  it("does not flag regression when change is below threshold", () => {
    // Mean of previous 5 = 100, latest = 105 → +5% (threshold=10)
    const sf = makeSeriesFile([100, 100, 100, 100, 100, 105]);
    const results = detectRegressions(sf, 10, 5);
    assert.deepEqual(results, []);
  });

  it("does not flag regression for smaller_is_better when latest value decreases", () => {
    // Mean of previous 5 = 100, latest = 80 → -20%, but decrease is good
    const sf = makeSeriesFile([100, 100, 100, 100, 100, 80]);
    const results = detectRegressions(sf, 10, 5);
    assert.deepEqual(results, []);
  });

  it("detects regression for bigger_is_better when latest value decreases below threshold", () => {
    // Mean of previous 5 = 100, latest = 80 → -20%
    const sf = makeSeriesFile([100, 100, 100, 100, 100, 80], "bigger_is_better");
    const results = detectRegressions(sf, 10, 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].seriesName, "BenchmarkFoo");
    assert.equal(results[0].latestValue, 80);
    assert.ok(results[0].percentChange < -19 && results[0].percentChange > -21);
  });

  it("does not flag regression for bigger_is_better when latest value increases", () => {
    // Mean of previous 5 = 100, latest = 120 → +20%, but increase is good
    const sf = makeSeriesFile([100, 100, 100, 100, 100, 120], "bigger_is_better");
    const results = detectRegressions(sf, 10, 5);
    assert.deepEqual(results, []);
  });

  it("respects custom window size", () => {
    // Window=3: mean of prev 3 = (90+90+90)=90, latest=120 → +33%
    const sf = makeSeriesFile([50, 50, 90, 90, 90, 120]);
    const results = detectRegressions(sf, 10, 3);
    assert.equal(results.length, 1);
    assert.ok(Math.abs(results[0].percentChange - 33.33) < 0.1);
    assert.equal(results[0].window, 3);
  });

  it("respects custom threshold", () => {
    // +15% change; passes at threshold=10, not at threshold=20
    const sf = makeSeriesFile([100, 100, 100, 100, 100, 115]);
    assert.equal(detectRegressions(sf, 10, 5).length, 1);
    assert.equal(detectRegressions(sf, 20, 5).length, 0);
  });

  it("skips series with zero mean to avoid division by zero", () => {
    const sf: SeriesFile = {
      metric: "ns_per_op",
      direction: "smaller_is_better",
      series: {
        BenchmarkFoo: {
          points: [
            { timestamp: "2025-01-01T00:00:00Z", value: 0 },
            { timestamp: "2025-01-01T00:01:00Z", value: 0 },
            { timestamp: "2025-01-01T00:02:00Z", value: 0 },
            { timestamp: "2025-01-01T00:03:00Z", value: 0 },
            { timestamp: "2025-01-01T00:04:00Z", value: 0 },
            { timestamp: "2025-01-01T00:05:00Z", value: 100 },
          ],
        },
      },
    };
    const results = detectRegressions(sf);
    assert.deepEqual(results, []);
  });

  it("detects regressions across multiple series independently", () => {
    const sf: SeriesFile = {
      metric: "ns_per_op",
      direction: "smaller_is_better",
      series: {
        BenchmarkFoo: {
          points: [100, 100, 100, 100, 100, 120].map((v, i) => ({
            timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
            value: v,
          })),
        },
        BenchmarkBar: {
          points: [100, 100, 100, 100, 100, 105].map((v, i) => ({
            timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
            value: v,
          })),
        },
      },
    };
    const results = detectRegressions(sf);
    assert.equal(results.length, 1);
    assert.equal(results[0].seriesName, "BenchmarkFoo");
  });

  it("defaults to smaller_is_better when direction is not set", () => {
    const sf: SeriesFile = {
      metric: "ns_per_op",
      series: {
        BenchmarkFoo: {
          points: [100, 100, 100, 100, 100, 120].map((v, i) => ({
            timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
            value: v,
          })),
        },
      },
    };
    const results = detectRegressions(sf);
    assert.equal(results.length, 1);
  });
});

describe("regressionTooltip", () => {
  it("formats increase tooltip for smaller_is_better", () => {
    const r = {
      seriesName: "BenchmarkFoo",
      latestValue: 368,
      previousMean: 320,
      percentChange: 15,
      window: 5,
    };
    const tooltip = regressionTooltip("ns_per_op", r);
    assert.equal(tooltip, "ns_per_op increased 15.0% vs 5-run average (320 → 368)");
  });

  it("formats decrease tooltip for bigger_is_better", () => {
    const r = {
      seriesName: "BenchmarkFoo",
      latestValue: 80,
      previousMean: 100,
      percentChange: -20,
      window: 3,
    };
    const tooltip = regressionTooltip("throughput", r);
    assert.equal(tooltip, "throughput decreased 20.0% vs 3-run average (100 → 80)");
  });

  it("uses metricLabelFormatter when provided", () => {
    const r = {
      seriesName: "BenchmarkFoo",
      latestValue: 368,
      previousMean: 320,
      percentChange: 15,
      window: 5,
    };
    const tooltip = regressionTooltip("ns_per_op", r, (m) => m.replace(/_/g, " "));
    assert.ok(tooltip.startsWith("ns per op"));
  });

  it("formats decimal values correctly", () => {
    const r = {
      seriesName: "BenchmarkFoo",
      latestValue: 1.5,
      previousMean: 1.25,
      percentChange: 20,
      window: 5,
    };
    const tooltip = regressionTooltip("ms_per_op", r);
    assert.equal(tooltip, "ms_per_op increased 20.0% vs 5-run average (1.25 → 1.50)");
  });

  it("formats integer values as whole numbers without decimal places", () => {
    const r = {
      seriesName: "BenchmarkFoo",
      latestValue: 120,
      previousMean: 100,
      percentChange: 20,
      window: 5,
    };
    const tooltip = regressionTooltip("ns_per_op", r);
    assert.equal(tooltip, "ns_per_op increased 20.0% vs 5-run average (100 → 120)");
  });
});
