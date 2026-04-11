import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareRuns as compare } from "./compare.js";
import { MetricsBatch } from "./metrics-batch.js";
import type { MetricPoint } from "./metrics-batch.js";
import type { Direction } from "./otlp-conventions.js";

/** Shorthand for building a MetricsBatch from simple entries. */
function makeBatch(
  entries: Array<{
    scenario: string;
    metric: string;
    value: number;
    unit?: string;
    direction?: Direction;
  }>,
): MetricsBatch {
  const points: MetricPoint[] = entries.map((e) => ({
    scenario: e.scenario,
    series: "default",
    metric: e.metric,
    value: e.value,
    unit: e.unit ?? "",
    direction: e.direction,
    role: undefined,
    tags: {},
    timestamp: undefined,
  }));
  return MetricsBatch.fromPoints(points);
}

describe("compare", () => {
  it("returns empty result for empty baseline", () => {
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op" },
    ]);
    const result = compare(current, []);
    assert.deepEqual(result.entries, []);
    assert.equal(result.hasRegression, false);
  });

  it("detects regression for smaller_is_better metric", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 120, unit: "ns/op", direction: "smaller_is_better" },
    ]);

    const result = compare(current, baseline);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].status, "regressed");
    assert.equal(result.entries[0].percentChange, 20);
    assert.equal(result.hasRegression, true);
  });

  it("detects improvement for smaller_is_better metric", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 80, unit: "ns/op", direction: "smaller_is_better" },
    ]);

    const result = compare(current, baseline);
    assert.equal(result.entries[0].status, "improved");
    assert.equal(result.entries[0].percentChange, -20);
    assert.equal(result.hasRegression, false);
  });

  it("detects regression for bigger_is_better metric", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ops_per_sec", value: 1000, unit: "ops/s", direction: "bigger_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ops_per_sec", value: 800, unit: "ops/s", direction: "bigger_is_better" },
    ]);

    const result = compare(current, baseline);
    assert.equal(result.entries[0].status, "regressed");
    assert.equal(result.entries[0].percentChange, -20);
    assert.equal(result.hasRegression, true);
  });

  it("detects improvement for bigger_is_better metric", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ops_per_sec", value: 1000, unit: "ops/s", direction: "bigger_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ops_per_sec", value: 1200, unit: "ops/s", direction: "bigger_is_better" },
    ]);

    const result = compare(current, baseline);
    assert.equal(result.entries[0].status, "improved");
    assert.equal(result.entries[0].percentChange, 20);
    assert.equal(result.hasRegression, false);
  });

  it("classifies within threshold as stable", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 103, unit: "ns/op", direction: "smaller_is_better" },
    ]);

    const result = compare(current, baseline, { test: "percentage", threshold: 5 });
    assert.equal(result.entries[0].status, "stable");
    assert.equal(result.entries[0].percentChange, 3);
    assert.equal(result.hasRegression, false);
  });

  it("skips new benchmarks with no baseline", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op" },
      { scenario: "BenchNew", metric: "ns_per_op", value: 200, unit: "ns/op" },
    ]);

    const result = compare(current, baseline);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].benchmark, "BenchA");
  });

  it("averages across multiple baseline runs", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 90, unit: "ns/op", direction: "smaller_is_better" },
      ]),
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 110, unit: "ns/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op", direction: "smaller_is_better" },
    ]);

    // baseline avg = 100, current = 100, change = 0%
    const result = compare(current, baseline);
    assert.equal(result.entries[0].baseline, 100);
    assert.equal(result.entries[0].percentChange, 0);
    assert.equal(result.entries[0].status, "stable");
  });

  it("infers direction from unit when not explicit", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "throughput", value: 1000, unit: "ops/s" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "throughput", value: 800, unit: "ops/s" },
    ]);

    const result = compare(current, baseline);
    // ops/s → bigger_is_better; drop from 1000→800 = regressed
    assert.equal(result.entries[0].direction, "bigger_is_better");
    assert.equal(result.entries[0].status, "regressed");
  });

  it("handles multiple benchmarks and metrics", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op", direction: "smaller_is_better" },
        { scenario: "BenchA", metric: "bytes_per_op", value: 200, unit: "B/op", direction: "smaller_is_better" },
        { scenario: "BenchB", metric: "ns_per_op", value: 500, unit: "ns/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 90, unit: "ns/op", direction: "smaller_is_better" },
      { scenario: "BenchA", metric: "bytes_per_op", value: 250, unit: "B/op", direction: "smaller_is_better" },
      { scenario: "BenchB", metric: "ns_per_op", value: 550, unit: "ns/op", direction: "smaller_is_better" },
    ]);

    const result = compare(current, baseline);
    assert.equal(result.entries.length, 3);

    const benchANs = result.entries.find((e) => e.benchmark === "BenchA" && e.metric === "ns_per_op");
    assert.equal(benchANs?.status, "improved"); // 100→90 = -10%

    const benchABytes = result.entries.find((e) => e.benchmark === "BenchA" && e.metric === "bytes_per_op");
    assert.equal(benchABytes?.status, "regressed"); // 200→250 = +25%

    const benchBNs = result.entries.find((e) => e.benchmark === "BenchB" && e.metric === "ns_per_op");
    assert.equal(benchBNs?.status, "regressed"); // 500→550 = +10%

    assert.equal(result.hasRegression, true);
  });

  it("uses custom threshold", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 115, unit: "ns/op", direction: "smaller_is_better" },
    ]);

    // 15% change, 20% threshold → stable
    const result = compare(current, baseline, { test: "percentage", threshold: 20 });
    assert.equal(result.entries[0].status, "stable");

    // 15% change, 10% threshold → regressed
    const result2 = compare(current, baseline, { test: "percentage", threshold: 10 });
    assert.equal(result2.entries[0].status, "regressed");
  });

  it("skips metrics with zero baseline and returns warnings", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "allocs", value: 0, unit: "allocs/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "allocs", value: 5, unit: "allocs/op", direction: "smaller_is_better" },
    ]);

    const result = compare(current, baseline);
    assert.equal(result.entries.length, 0);
    assert.ok(result.warnings);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /allocs/);
    assert.match(result.warnings[0], /BenchA/);
    assert.match(result.warnings[0], /baseline mean is zero/);
  });

  it("omits warnings key when no metrics are skipped", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 105, unit: "ns/op", direction: "smaller_is_better" },
    ]);

    const result = compare(current, baseline);
    assert.equal(result.warnings, undefined);
  });

  it("boundary: exactly at threshold is stable", () => {
    const baseline = [
      makeBatch([
        { scenario: "BenchA", metric: "ns_per_op", value: 100, unit: "ns/op", direction: "smaller_is_better" },
      ]),
    ];
    const current = makeBatch([
      { scenario: "BenchA", metric: "ns_per_op", value: 105, unit: "ns/op", direction: "smaller_is_better" },
    ]);

    // 5% change with 5% threshold → stable (<=)
    const result = compare(current, baseline, { test: "percentage", threshold: 5 });
    assert.equal(result.entries[0].status, "stable");
  });
});
