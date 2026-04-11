import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enforceDatapointPolicy, parseMinDatapoints } from "./guardrails.js";

describe("parseMinDatapoints", () => {
  it("parses valid non-negative integers", () => {
    assert.equal(parseMinDatapoints("0"), 0);
    assert.equal(parseMinDatapoints("3"), 3);
  });

  it("rejects invalid values", () => {
    assert.throws(() => parseMinDatapoints("-1"), /non-negative integer/);
    assert.throws(() => parseMinDatapoints("abc"), /non-negative integer/);
  });
});

describe("enforceDatapointPolicy", () => {
  it("passes when datapoints satisfy thresholds", () => {
    assert.doesNotThrow(() =>
      enforceDatapointPolicy({
        dataPoints: 5,
        failOnZeroDatapoints: true,
        minDatapoints: 3,
      }),
    );
  });

  it("fails when fail-on-zero-datapoints is enabled", () => {
    assert.throws(
      () =>
        enforceDatapointPolicy({
          dataPoints: 0,
          failOnZeroDatapoints: true,
          minDatapoints: 0,
        }),
      /fail-on-zero-datapoints=true/,
    );
  });

  it("fails when datapoints are below min-datapoints", () => {
    assert.throws(
      () =>
        enforceDatapointPolicy({
          dataPoints: 1,
          failOnZeroDatapoints: false,
          minDatapoints: 2,
        }),
      /below min-datapoints=2/,
    );
  });
});

