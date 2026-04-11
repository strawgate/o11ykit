import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRef, formatTimestamp, shortCommit } from "./format-utils.js";

describe("RunSelector helpers", () => {
  describe("shortCommit", () => {
    it("truncates to 7 characters", () => {
      assert.equal(shortCommit("abc123def456"), "abc123d");
    });

    it("returns dash for undefined", () => {
      assert.equal(shortCommit(undefined), "–");
    });

    it("handles short commits", () => {
      assert.equal(shortCommit("abc"), "abc");
    });
  });

  describe("formatRef", () => {
    it("formats PR refs", () => {
      assert.equal(formatRef("refs/pull/42/merge"), "PR #42");
    });

    it("strips refs/heads/ prefix", () => {
      assert.equal(formatRef("refs/heads/main"), "main");
    });

    it("formats tag refs", () => {
      assert.equal(formatRef("refs/tags/v1.0.0"), "tag v1.0.0");
    });

    it("returns unknown refs as-is", () => {
      assert.equal(formatRef("some/other/ref"), "some/other/ref");
    });

    it("returns dash for undefined", () => {
      assert.equal(formatRef(undefined), "—");
    });
  });

  describe("formatTimestamp", () => {
    it("returns a formatted string for valid ISO dates", () => {
      const result = formatTimestamp("2026-04-01T10:30:00Z");
      assert.ok(typeof result === "string");
      assert.ok(result.length > 0);
      assert.notEqual(result, "2026-04-01T10:30:00Z");
    });

    it("returns raw input for invalid dates", () => {
      assert.equal(formatTimestamp("not-a-date"), "not-a-date");
    });
  });
});
