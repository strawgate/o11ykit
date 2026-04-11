import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGoBench } from "./parse-go.js";
import { MetricsBatch } from "./metrics-batch.js";

describe("parseGoBench", () => {
  it("parses a single benchmark line", () => {
    const input = `BenchmarkFib20-8        30000        41653 ns/op`;
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));

    assert.equal(batch.scenarios.length, 1);
    assert.equal(batch.scenarios[0], "BenchmarkFib20");
    const p = batch.forScenario("BenchmarkFib20").forMetric("ns_per_op").points[0];
    assert.equal(p.value, 41653);
    assert.equal(p.unit, "ns/op");
    assert.equal(p.direction, "smaller_is_better");
    assert.equal(p.tags["procs"], "8");
  });

  it("parses multiple metrics per line", () => {
    const input = `BenchmarkScanner-8    5000    234567 ns/op    4096 B/op    12 allocs/op`;
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));

    assert.equal(batch.scenarios.length, 1);
    assert.equal(batch.metricNames.length, 3);
    assert.equal(batch.forMetric("ns_per_op").points[0].value, 234567);
    assert.equal(batch.forMetric("bytes_per_op").points[0].value, 4096);
    assert.equal(batch.forMetric("allocs_per_op").points[0].value, 12);
  });

  it("parses multiple benchmark lines", () => {
    const input = [
      "goos: linux",
      "goarch: amd64",
      "pkg: github.com/example/pkg",
      "BenchmarkA-8    10000    12345 ns/op",
      "BenchmarkB-8    20000     6789 ns/op",
      "PASS",
      "ok      github.com/example/pkg  2.345s",
    ].join("\n");

    const batch = MetricsBatch.fromOtlp(parseGoBench(input));
    assert.equal(batch.scenarios.length, 2);
    assert.ok(batch.scenarios.includes("BenchmarkA"));
    assert.ok(batch.scenarios.includes("BenchmarkB"));
  });

  it("handles benchmarks without procs suffix", () => {
    const input = `BenchmarkSimple      50000        30000 ns/op`;
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));

    assert.equal(batch.scenarios.length, 1);
    assert.equal(batch.scenarios[0], "BenchmarkSimple");
    assert.equal(batch.points[0].tags["procs"], undefined);
  });

  it("handles MB/s as bigger_is_better", () => {
    const input = `BenchmarkRead-8    1000    500000 ns/op    200.00 MB/s`;
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));

    assert.equal(batch.forMetric("mb_per_s").points[0].direction, "bigger_is_better");
  });

  it("returns empty batch for non-benchmark input", () => {
    const input = "just some random text\nno benchmarks here";
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));
    assert.equal(batch.size, 0);
  });

  it("throws on empty string input", () => {
    assert.throws(() => parseGoBench(""), {
      message: /\[parse-go\] Input must be a non-empty string/,
    });
  });

  it("throws on whitespace-only input", () => {
    assert.throws(() => parseGoBench("   \n\t  \n  "), {
      message: /\[parse-go\] Input must be a non-empty string/,
    });
  });

  it("parses sub-benchmark names with slashes", () => {
    const input = `BenchmarkSort/asc-8    10000    100 ns/op`;
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));
    assert.equal(batch.scenarios.length, 1);
    assert.equal(batch.scenarios[0], "BenchmarkSort/asc");
  });

  it("parses benchmark names with special characters", () => {
    const input = `BenchmarkParse/json(100)-8    5000    200 ns/op`;
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));
    assert.equal(batch.scenarios.length, 1);
    assert.equal(batch.scenarios[0], "BenchmarkParse/json(100)");
  });

  it("skips lines where benchmark name contains spaces (unsupported)", () => {
    const input = `Benchmark Has Spaces-8    1000    100 ns/op`;
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));
    assert.equal(batch.size, 0);
  });

  it("handles custom metric units via fallback key", () => {
    const input = `BenchmarkEncode-4    2000    512 ns/op    1234 bytes`;
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));
    assert.equal(batch.scenarios.length, 1);
    const bytesPoint = batch.forMetric("bytes").points[0];
    assert.ok(bytesPoint, "custom unit should produce metric keyed by unit name");
    assert.equal(bytesPoint.value, 1234);
  });

  it("ignores PASS/FAIL/ok summary lines", () => {
    const input = [
      "PASS",
      "FAIL\tgithub.com/example/pkg",
      "ok  \tgithub.com/example/pkg\t1.234s",
      "BenchmarkOk-8    1000    99 ns/op",
    ].join("\n");
    const batch = MetricsBatch.fromOtlp(parseGoBench(input));
    assert.equal(batch.scenarios.length, 1);
    assert.equal(batch.scenarios[0], "BenchmarkOk");
  });
});
