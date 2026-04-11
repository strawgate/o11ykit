import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sortBySeverity } from "./components/ComparisonSummaryTable.js";
import { formatPct, formatFixedValue } from "./format-utils.js";

describe("ComparisonSummaryTable helpers", () => {
  describe("formatPct", () => {
    it("adds + sign for positive values", () => {
      assert.equal(formatPct(12.345), "+12.35%");
    });

    it("preserves - sign for negative values", () => {
      assert.equal(formatPct(-7.891), "-7.89%");
    });

    it("handles zero", () => {
      assert.equal(formatPct(0), "0.00%");
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
  });

  describe("sortBySeverity", () => {
    it("sorts regressions first, then improvements, then stable", () => {
      const entries = [
        { benchmark: "A", metric: "m", direction: "smaller_is_better" as const, baseline: 0, current: 0, status: "stable" as const, percentChange: 1 },
        { benchmark: "B", metric: "m", direction: "smaller_is_better" as const, baseline: 0, current: 0, status: "improved" as const, percentChange: -10 },
        { benchmark: "C", metric: "m", direction: "smaller_is_better" as const, baseline: 0, current: 0, status: "regressed" as const, percentChange: 15 },
        { benchmark: "D", metric: "m", direction: "smaller_is_better" as const, baseline: 0, current: 0, status: "regressed" as const, percentChange: 5 },
      ];
      const sorted = sortBySeverity(entries);
      assert.deepEqual(
        sorted.map((e) => e.status),
        ["regressed", "regressed", "improved", "stable"],
      );
    });

    it("sorts within group by |percentChange| descending", () => {
      const entries = [
        { benchmark: "A", metric: "m", direction: "smaller_is_better" as const, baseline: 0, current: 0, status: "regressed" as const, percentChange: 5.2 },
        { benchmark: "B", metric: "m", direction: "smaller_is_better" as const, baseline: 0, current: 0, status: "regressed" as const, percentChange: 22.1 },
        { benchmark: "C", metric: "m", direction: "smaller_is_better" as const, baseline: 0, current: 0, status: "regressed" as const, percentChange: 8.7 },
      ];
      const sorted = sortBySeverity(entries);
      assert.deepEqual(
        sorted.map((e) => e.percentChange),
        [22.1, 8.7, 5.2],
      );
    });

    it("returns empty array for empty input", () => {
      assert.deepEqual(sortBySeverity([]), []);
    });
  });
});
