import { describe, it } from "node:test";
import assert from "node:assert/strict";

// These are integration-level helpers that need git + exec — but we can
// test the module exports are correct and the types compile.

describe("actions-common exports", () => {
  it("exports configureGit, checkoutDataBranch, pushWithRetry", async () => {
    const mod = await import("./index.js");
    assert.equal(typeof mod.configureGit, "function");
    assert.equal(typeof mod.checkoutDataBranch, "function");
    assert.equal(typeof mod.pushWithRetry, "function");
  });
});
