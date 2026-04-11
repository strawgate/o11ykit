import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as core from "./index.js";

describe("@octo11y/core package root exports", () => {
  it("exports OTLP parsing functions", () => {
    assert.equal(typeof core.parseOtlp, "function");
    assert.equal(typeof core.otlpAttributesToRecord, "function");
    assert.equal(typeof core.getOtlpMetricKind, "function");
    assert.equal(typeof core.getOtlpTemporality, "function");
  });

  it("exports retry helpers", () => {
    assert.equal(typeof core.computeRetryDelayMs, "function");
    assert.equal(typeof core.sleep, "function");
    assert.equal(core.DEFAULT_PUSH_RETRY_COUNT, 5);
  });
});
