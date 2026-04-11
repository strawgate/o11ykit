import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { rankSeries, getWinner } from "./leaderboard.js";
import type { SeriesFile } from "@octo11y/core";

function makeSeriesFile(
  direction: SeriesFile["direction"],
  entries: Record<string, number[]>,
): SeriesFile {
  const series: SeriesFile["series"] = {};
  for (const [name, values] of Object.entries(entries)) {
    series[name] = {
      points: values.map((v, i) => ({ timestamp: `2025-01-0${i + 1}T00:00:00Z`, value: v })),
    };
  }
  return { metric: "test", direction, series };
}

describe("rankSeries", () => {
  it("smaller_is_better: lowest value is rank 1", () => {
    const sf = makeSeriesFile("smaller_is_better", {
      fast: [100, 90],
      slow: [200, 210],
      medium: [150, 140],
    });
    const ranked = rankSeries(sf);
    assert.equal(ranked[0].name, "fast");
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[0].isWinner, true);
    assert.equal(ranked[1].name, "medium");
    assert.equal(ranked[2].name, "slow");
  });

  it("bigger_is_better: highest value is rank 1", () => {
    const sf = makeSeriesFile("bigger_is_better", {
      low: [10, 12],
      high: [50, 55],
      mid: [30, 35],
    });
    const ranked = rankSeries(sf);
    assert.equal(ranked[0].name, "high");
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[0].isWinner, true);
    assert.equal(ranked[1].name, "mid");
    assert.equal(ranked[2].name, "low");
  });

  it("no direction: lowest value is rank 1 (neutral)", () => {
    const sf = makeSeriesFile(undefined, {
      a: [30],
      b: [10],
      c: [20],
    });
    const ranked = rankSeries(sf);
    assert.equal(ranked[0].name, "b");
    assert.equal(ranked[0].rank, 1);
  });

  it("calculates delta from previous point", () => {
    const sf = makeSeriesFile("smaller_is_better", {
      series1: [100, 80],
    });
    const [r] = rankSeries(sf);
    assert.equal(r.latestValue, 80);
    assert.equal(r.previousValue, 100);
    assert.equal(r.delta, -20);
  });

  it("delta is undefined for series with a single point", () => {
    const sf = makeSeriesFile("smaller_is_better", {
      series1: [100],
    });
    const [r] = rankSeries(sf);
    assert.equal(r.previousValue, undefined);
    assert.equal(r.delta, undefined);
  });

  it("excludes series with no data points", () => {
    const sf: SeriesFile = {
      metric: "test",
      series: {
        empty: { points: [] },
        filled: { points: [{ timestamp: "2025-01-01T00:00:00Z", value: 42 }] },
      },
    };
    const ranked = rankSeries(sf);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].name, "filled");
  });

  it("returns empty array when all series are empty", () => {
    const sf: SeriesFile = { metric: "test", series: {} };
    const ranked = rankSeries(sf);
    assert.deepEqual(ranked, []);
  });

  it("single series returns rank 1 with isWinner true", () => {
    const sf = makeSeriesFile("smaller_is_better", { only: [42] });
    const [r] = rankSeries(sf);
    assert.equal(r.rank, 1);
    assert.equal(r.isWinner, true);
  });
});

describe("getWinner", () => {
  it("returns the name of the rank-1 series", () => {
    const sf = makeSeriesFile("smaller_is_better", {
      a: [100],
      b: [50],
      c: [200],
    });
    assert.equal(getWinner(sf), "b");
  });

  it("returns undefined when no series have data", () => {
    const sf: SeriesFile = { metric: "test", series: {} };
    assert.equal(getWinner(sf), undefined);
  });
});
