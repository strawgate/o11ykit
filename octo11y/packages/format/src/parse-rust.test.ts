import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRustBench } from "./parse-rust.js";
import { MetricsBatch } from "./metrics-batch.js";

describe("parseRustBench", () => {
  it("parses single rust benchmark", () => {
    const input = "test sort::bench_sort   ... bench:         320 ns/iter (+/- 42)";
    const batch = MetricsBatch.fromOtlp(parseRustBench(input));

    assert.equal(batch.scenarios.length, 1);
    assert.equal(batch.scenarios[0], "sort::bench_sort");
    const p = batch.forMetric("ns_per_iter").points[0];
    assert.equal(p.value, 320);
    assert.equal(p.unit, "ns/iter");
    assert.equal(p.direction, "smaller_is_better");
  });

  it("parses multiple rust benchmarks", () => {
    const input = `
test sort::bench_sort   ... bench:         320 ns/iter (+/- 42)
test sort::bench_stable ... bench:         285 ns/iter (+/- 31)
    `;
    const batch = MetricsBatch.fromOtlp(parseRustBench(input));

    assert.equal(batch.scenarios.length, 2);
    assert.ok(batch.scenarios.includes("sort::bench_sort"));
    assert.ok(batch.scenarios.includes("sort::bench_stable"));
  });

  it("handles benchmarks without range", () => {
    const input = "test basic ... bench: 100 ns/iter";
    const batch = MetricsBatch.fromOtlp(parseRustBench(input));

    assert.equal(batch.forMetric("ns_per_iter").points[0].value, 100);
  });

  it("handles numbers with commas", () => {
    const input = "test large ... bench: 1,234,567 ns/iter (+/- 1,234)";
    const batch = MetricsBatch.fromOtlp(parseRustBench(input));

    assert.equal(batch.forMetric("ns_per_iter").points[0].value, 1234567);
  });

  it("skips non-benchmark lines", () => {
    const input = `
running 2 tests
test sort::bench_sort   ... bench:         320 ns/iter (+/- 42)
test sort::bench_stable ... bench:         285 ns/iter (+/- 31)
test result: ok. 0 passed; 0 failed; 0 ignored; 2 measured; 0 filtered out; finished in 0.00s
    `;
    const batch = MetricsBatch.fromOtlp(parseRustBench(input));
    assert.equal(batch.scenarios.length, 2);
  });

  it("throws on empty string input", () => {
    assert.throws(() => parseRustBench(""), {
      message: /\[parse-rust\] Input must be a non-empty string/,
    });
  });

  it("throws on whitespace-only input", () => {
    assert.throws(() => parseRustBench("   \n\t  \n  "), {
      message: /\[parse-rust\] Input must be a non-empty string/,
    });
  });
});
