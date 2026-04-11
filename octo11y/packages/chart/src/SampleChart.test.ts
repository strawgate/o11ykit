import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractSampleMetrics } from "./sample-utils.js";
import type { Sample } from "@benchkit/format";

describe("extractSampleMetrics", () => {
  it("returns empty array for empty samples", () => {
    assert.deepEqual(extractSampleMetrics([]), []);
  });

  it("excludes the 't' key from results", () => {
    const samples: Sample[] = [{ t: 0, eps: 1000 }];
    const metrics = extractSampleMetrics(samples);
    assert.ok(!metrics.includes("t"), "should not include 't'");
    assert.deepEqual(metrics, ["eps"]);
  });

  it("returns all metric keys present across samples", () => {
    const samples: Sample[] = [
      { t: 0, eps: 1000, heap_mb: 256 },
      { t: 1, eps: 1020, heap_mb: 260 },
    ];
    const metrics = extractSampleMetrics(samples);
    assert.ok(metrics.includes("eps"));
    assert.ok(metrics.includes("heap_mb"));
    assert.equal(metrics.length, 2);
  });

  it("unions keys that only appear in some samples", () => {
    const samples: Sample[] = [
      { t: 0, eps: 1000 },
      { t: 1, eps: 1020, rss_mb: 512 },
    ];
    const metrics = extractSampleMetrics(samples);
    assert.ok(metrics.includes("eps"));
    assert.ok(metrics.includes("rss_mb"));
    assert.equal(metrics.length, 2);
  });

  it("deduplicates keys that appear in multiple samples", () => {
    const samples: Sample[] = [
      { t: 0, eps: 1000 },
      { t: 1, eps: 1020 },
      { t: 2, eps: 1010 },
    ];
    const metrics = extractSampleMetrics(samples);
    assert.deepEqual(metrics, ["eps"]);
  });

  it("handles a sample with only the 't' key", () => {
    const samples: Sample[] = [{ t: 0 }];
    assert.deepEqual(extractSampleMetrics(samples), []);
  });
});
