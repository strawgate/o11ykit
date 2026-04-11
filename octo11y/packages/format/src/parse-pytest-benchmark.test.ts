import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePytestBenchmark } from "./parse-pytest-benchmark.js";
import { parseBenchmarks as parse } from "./parse.js";
import { MetricsBatch } from "./metrics-batch.js";

const PYTEST_BENCHMARK_OUTPUT = JSON.stringify({
  benchmarks: [
    {
      name: "test_sort",
      fullname: "tests/test_perf.py::test_sort",
      stats: {
        min: 0.000123,
        max: 0.000156,
        mean: 0.000134,
        stddev: 0.0000089,
        rounds: 1000,
        median: 0.000132,
        ops: 7462.68,
      },
    },
    {
      name: "test_search",
      fullname: "tests/test_perf.py::test_search",
      stats: {
        min: 0.000050,
        max: 0.000080,
        mean: 0.000063,
        stddev: 0.000005,
        rounds: 2000,
        median: 0.000062,
        ops: 15873.02,
      },
    },
  ],
});

describe("parsePytestBenchmark", () => {
  it("parses pytest-benchmark JSON output", () => {
    const batch = MetricsBatch.fromOtlp(parsePytestBenchmark(PYTEST_BENCHMARK_OUTPUT));

    assert.equal(batch.scenarios.length, 2);

    const sortBatch = batch.forScenario("test_sort");
    assert.equal(sortBatch.forMetric("mean").points[0].value, 0.000134);
    assert.equal(sortBatch.forMetric("mean").points[0].unit, "s");
    assert.equal(sortBatch.forMetric("mean").points[0].direction, "smaller_is_better");
    assert.equal(sortBatch.forMetric("median").points[0].value, 0.000132);
    assert.equal(sortBatch.forMetric("min").points[0].value, 0.000123);
    assert.equal(sortBatch.forMetric("max").points[0].value, 0.000156);
    assert.equal(sortBatch.forMetric("stddev").points[0].value, 0.0000089);
    assert.equal(sortBatch.forMetric("ops").points[0].value, 7462.68);
    assert.equal(sortBatch.forMetric("ops").points[0].unit, "ops/s");
    assert.equal(sortBatch.forMetric("ops").points[0].direction, "bigger_is_better");
    assert.equal(sortBatch.forMetric("rounds").points[0].value, 1000);
    assert.equal(sortBatch.forMetric("rounds").points[0].direction, "bigger_is_better");
  });

  it("parses multiple benchmarks", () => {
    const batch = MetricsBatch.fromOtlp(parsePytestBenchmark(PYTEST_BENCHMARK_OUTPUT));

    const searchBatch = batch.forScenario("test_search");
    assert.equal(searchBatch.forMetric("mean").points[0].value, 0.000063);
    assert.equal(searchBatch.forMetric("ops").points[0].value, 15873.02);
    assert.equal(searchBatch.forMetric("rounds").points[0].value, 2000);
  });

  it("auto-detects pytest-benchmark format", () => {
    const batch = MetricsBatch.fromOtlp(parse(PYTEST_BENCHMARK_OUTPUT));
    assert.equal(batch.scenarios.length, 2);
    assert.ok(batch.scenarios.includes("test_sort"));
  });

  it("throws on missing benchmarks array", () => {
    assert.throws(() => parsePytestBenchmark('{"foo": "bar"}'), {
      message: /\[parse-pytest-benchmark\].*benchmarks/,
    });
  });

  it("throws when an entry lacks a stats object", () => {
    assert.throws(
      () =>
        parsePytestBenchmark(
          JSON.stringify({ benchmarks: [{ name: "bad_bench" }] }),
        ),
      { message: /stats/ },
    );
  });

  it("throws contextual error on malformed JSON", () => {
    assert.throws(() => parsePytestBenchmark("not-json"), {
      message: /\[parse-pytest-benchmark\] Failed to parse input as JSON/,
    });
  });
});
