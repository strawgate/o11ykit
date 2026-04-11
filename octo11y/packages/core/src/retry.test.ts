import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRetryDelayMs,
  DEFAULT_PUSH_RETRY_COUNT,
  RETRY_DELAY_MAX_MS,
  RETRY_DELAY_MIN_MS,
} from "./retry.js";

describe("retry helpers", () => {
  it("keeps the default retry count at five attempts", () => {
    assert.equal(DEFAULT_PUSH_RETRY_COUNT, 5);
  });

  it("returns the minimum delay for random value 0", () => {
    assert.equal(computeRetryDelayMs(0), RETRY_DELAY_MIN_MS);
  });

  it("returns the maximum delay for random value 1", () => {
    assert.equal(computeRetryDelayMs(1), RETRY_DELAY_MAX_MS);
  });

  it("returns the midpoint delay for a 0.5 random value", () => {
    assert.equal(computeRetryDelayMs(0.5), 1750);
  });

  it("clamps random values below zero", () => {
    assert.equal(computeRetryDelayMs(-1), RETRY_DELAY_MIN_MS);
  });

  it("clamps random values above one", () => {
    assert.equal(computeRetryDelayMs(2), RETRY_DELAY_MAX_MS);
  });
});
