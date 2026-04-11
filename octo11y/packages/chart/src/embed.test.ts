import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

/**
 * The embed module is designed for browser execution (uses `document`,
 * `render()`, etc.), so we test the exported API shape and types here.
 * Full integration tests require a browser environment.
 */

describe("embed module exports", () => {
  it("exports mount function and types", async () => {
    // Verify the module can be imported and has the expected shape.
    const mod = await import("./embed.js");
    assert.equal(typeof mod.mount, "function");
  });
});
