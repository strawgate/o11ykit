import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHyperfine } from "./parse-hyperfine.js";
import { parseBenchmarks as parse } from "./parse.js";
import { MetricsBatch } from "./metrics-batch.js";

const HYPERFINE_OUTPUT = JSON.stringify({
  results: [
    {
      command: "sort input.txt",
      mean: 0.123,
      stddev: 0.005,
      median: 0.121,
      min: 0.115,
      max: 0.135,
      times: [0.115, 0.121, 0.123, 0.135],
    },
    {
      command: "ls -l",
      mean: 0.01,
      stddev: 0.001,
      median: 0.01,
      min: 0.009,
      max: 0.012,
      times: [0.009, 0.01, 0.01, 0.012],
    },
  ],
});

describe("parseHyperfine", () => {
  it("parses hyperfine JSON output", () => {
    const batch = MetricsBatch.fromOtlp(parseHyperfine(HYPERFINE_OUTPUT));

    assert.equal(batch.scenarios.length, 2);

    const sortBatch = batch.forScenario("sort input.txt");
    assert.equal(sortBatch.forMetric("mean").points[0].value, 0.123);
    assert.equal(sortBatch.forMetric("mean").points[0].unit, "s");
    assert.equal(sortBatch.forMetric("mean").points[0].direction, "smaller_is_better");
    assert.equal(sortBatch.forMetric("stddev").points[0].value, 0.005);
    assert.equal(sortBatch.forMetric("median").points[0].value, 0.121);
    assert.equal(sortBatch.forMetric("min").points[0].value, 0.115);
    assert.equal(sortBatch.forMetric("max").points[0].value, 0.135);

    const lsBatch = batch.forScenario("ls -l");
    assert.equal(lsBatch.forMetric("mean").points[0].value, 0.01);
  });

  it("auto-detects hyperfine format", () => {
    const batch = MetricsBatch.fromOtlp(parse(HYPERFINE_OUTPUT));
    assert.equal(batch.scenarios.length, 2);
    assert.ok(batch.scenarios.includes("sort input.txt"));
  });

  it("throws on invalid hyperfine JSON", () => {
    assert.throws(() => parseHyperfine('{"foo": "bar"}'), {
      message: /\[parse-hyperfine\].*results/,
    });
  });

  it("throws contextual error on malformed JSON", () => {
    assert.throws(() => parseHyperfine("not-json"), {
      message: /\[parse-hyperfine\] Failed to parse input as JSON/,
    });
  });
});
