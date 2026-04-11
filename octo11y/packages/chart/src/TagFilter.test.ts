import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractTags, filterSeriesFile } from "./components/TagFilter.js";
import type { SeriesFile } from "@octo11y/core";

const makeSeriesFile = (entries: Record<string, { tags?: Record<string, string> }>): SeriesFile => ({
  metric: "ns_per_op",
  series: Object.fromEntries(
    Object.entries(entries).map(([name, e]) => [name, { tags: e.tags, points: [] }]),
  ),
});

describe("extractTags", () => {
  it("returns empty object when no series files", () => {
    const result = extractTags(new Map());
    assert.deepEqual(result, {});
  });

  it("returns empty object when series have no tags", () => {
    const sf = makeSeriesFile({ BenchmarkA: {}, BenchmarkB: {} });
    const result = extractTags(new Map([["ns_per_op", sf]]));
    assert.deepEqual(result, {});
  });

  it("extracts unique tag keys and values", () => {
    const sf = makeSeriesFile({
      BenchmarkA: { tags: { os: "linux", size: "small" } },
      BenchmarkB: { tags: { os: "macos", size: "large" } },
    });
    const result = extractTags(new Map([["ns_per_op", sf]]));
    assert.deepEqual(result, { os: ["linux", "macos"], size: ["large", "small"] });
  });

  it("deduplicates tag values across series entries", () => {
    const sf = makeSeriesFile({
      BenchmarkA: { tags: { os: "linux" } },
      BenchmarkB: { tags: { os: "linux" } },
    });
    const result = extractTags(new Map([["ns_per_op", sf]]));
    assert.deepEqual(result, { os: ["linux"] });
  });

  it("merges tags across multiple SeriesFiles", () => {
    const sf1 = makeSeriesFile({ BenchA: { tags: { os: "linux" } } });
    const sf2 = makeSeriesFile({ BenchB: { tags: { size: "large" } } });
    const result = extractTags(new Map([["ns_per_op", sf1], ["allocs_per_op", sf2]]));
    assert.deepEqual(result, { os: ["linux"], size: ["large"] });
  });

  it("sorts tag values alphabetically", () => {
    const sf = makeSeriesFile({
      A: { tags: { os: "windows" } },
      B: { tags: { os: "linux" } },
      C: { tags: { os: "macos" } },
    });
    const result = extractTags(new Map([["ns_per_op", sf]]));
    assert.deepEqual(result.os, ["linux", "macos", "windows"]);
  });
});

describe("filterSeriesFile", () => {
  it("returns original file when no filters are active", () => {
    const sf = makeSeriesFile({
      BenchmarkA: { tags: { os: "linux" } },
      BenchmarkB: { tags: { os: "macos" } },
    });
    const result = filterSeriesFile(sf, {});
    assert.equal(result, sf);
  });

  it("keeps only entries matching a single filter", () => {
    const sf = makeSeriesFile({
      BenchmarkA: { tags: { os: "linux" } },
      BenchmarkB: { tags: { os: "macos" } },
    });
    const result = filterSeriesFile(sf, { os: "linux" });
    assert.deepEqual(Object.keys(result.series), ["BenchmarkA"]);
  });

  it("applies AND logic for multiple filters", () => {
    const sf = makeSeriesFile({
      BenchmarkA: { tags: { os: "linux", size: "large" } },
      BenchmarkB: { tags: { os: "linux", size: "small" } },
      BenchmarkC: { tags: { os: "macos", size: "large" } },
    });
    const result = filterSeriesFile(sf, { os: "linux", size: "large" });
    assert.deepEqual(Object.keys(result.series), ["BenchmarkA"]);
  });

  it("excludes entries without tags when a filter is active", () => {
    const sf = makeSeriesFile({
      BenchmarkA: { tags: { os: "linux" } },
      BenchmarkB: {},
    });
    const result = filterSeriesFile(sf, { os: "linux" });
    assert.deepEqual(Object.keys(result.series), ["BenchmarkA"]);
  });

  it("returns empty series when no entries match", () => {
    const sf = makeSeriesFile({
      BenchmarkA: { tags: { os: "linux" } },
    });
    const result = filterSeriesFile(sf, { os: "windows" });
    assert.deepEqual(Object.keys(result.series), []);
  });

  it("preserves metric and unit in filtered result", () => {
    const sf: SeriesFile = {
      metric: "ns_per_op",
      unit: "ns",
      direction: "smaller_is_better",
      series: {
        BenchmarkA: { tags: { os: "linux" }, points: [] },
      },
    };
    const result = filterSeriesFile(sf, { os: "linux" });
    assert.equal(result.metric, "ns_per_op");
    assert.equal(result.unit, "ns");
    assert.equal(result.direction, "smaller_is_better");
  });
});
