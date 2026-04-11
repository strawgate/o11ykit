import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDirection,
  formatFixedValue,
  formatPct,
  formatRef,
  formatTimestamp,
  formatValue,
  shortCommit,
} from "./format-utils.js";

describe("format-utils", () => {
  describe("formatValue", () => {
    it("formats large values without decimals", () => {
      assert.equal(formatValue(1234), "1,234");
    });

    it("formats small values with up to 2 decimals", () => {
      const result = formatValue(3.14159);
      assert.ok(result.includes("3.14"), `Expected "3.14" in "${result}"`);
    });

    it("formats values in compact mode", () => {
      const result = formatValue(1500, true);
      assert.ok(result.includes("1.5K") || result.includes("2K"), `Expected compact notation in "${result}"`);
    });

    it("formats zero", () => {
      assert.equal(formatValue(0), "0");
    });
  });

  describe("formatFixedValue", () => {
    it("shows integers without decimals", () => {
      assert.equal(formatFixedValue(320), "320");
    });

    it("shows 1 decimal for large floats", () => {
      assert.equal(formatFixedValue(1234.567), "1234.6");
    });

    it("shows 2 decimals for small floats", () => {
      assert.equal(formatFixedValue(3.14159), "3.14");
    });

    it("shows 0 decimals for integer zero", () => {
      assert.equal(formatFixedValue(0), "0");
    });
  });

  describe("formatRef", () => {
    it("formats PR merge refs", () => {
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

    it("returns em-dash for undefined", () => {
      assert.equal(formatRef(undefined), "—");
    });

    it("returns em-dash for empty string", () => {
      assert.equal(formatRef(""), "—");
    });
  });

  describe("formatPct", () => {
    it("adds + sign for positive values", () => {
      assert.equal(formatPct(12.345), "+12.35%");
    });

    it("preserves - sign for negative values", () => {
      assert.equal(formatPct(-7.891), "-7.89%");
    });

    it("shows no sign for zero", () => {
      assert.equal(formatPct(0), "0.00%");
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

  describe("shortCommit", () => {
    it("truncates to 7 characters", () => {
      assert.equal(shortCommit("abc123def456"), "abc123d");
    });

    it("returns a dash for undefined", () => {
      assert.equal(shortCommit(undefined), "–");
    });

    it("handles short commits", () => {
      assert.equal(shortCommit("abc"), "abc");
    });
  });

  describe("formatDirection", () => {
    it("formats smaller-is-better directions", () => {
      assert.equal(formatDirection("smaller_is_better"), "↓ smaller");
    });

    it("formats bigger-is-better directions", () => {
      assert.equal(formatDirection("bigger_is_better"), "↑ bigger");
    });

    it("shows a clear fallback for unknown directions", () => {
      assert.equal(formatDirection("sideways_is_better"), "? sideways_is_better");
    });

    it("shows unknown when no direction is provided", () => {
      assert.equal(formatDirection(""), "unknown");
    });
  });
});
