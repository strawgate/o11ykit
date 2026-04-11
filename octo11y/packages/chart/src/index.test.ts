import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDirection } from "./index.js";

describe("package root exports", () => {
  it("exports formatDirection", () => {
    assert.equal(formatDirection("smaller_is_better"), "↓ smaller");
    assert.equal(formatDirection("bigger_is_better"), "↑ bigger");
  });
});
