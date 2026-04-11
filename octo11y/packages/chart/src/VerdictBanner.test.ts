import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ComparisonResult } from "@benchkit/format";

// Test the pure-function aspects of VerdictBanner logic.

function categorize(result: ComparisonResult) {
  const regressed = result.entries.filter((e) => e.status === "regressed");
  const improved = result.entries.filter((e) => e.status === "improved");
  const stable = result.entries.filter((e) => e.status === "stable");
  return { regressed: regressed.length, improved: improved.length, stable: stable.length };
}

function headlineText(result: ComparisonResult): string {
  const regressed = result.entries.filter((e) => e.status === "regressed");
  if (result.hasRegression) {
    return `${regressed.length} regression${regressed.length !== 1 ? "s" : ""} detected`;
  }
  return "No regressions";
}

describe("VerdictBanner logic", () => {
  it("reports no regressions when all stable", () => {
    const result: ComparisonResult = {
      hasRegression: false,
      entries: [
        { benchmark: "A", metric: "m", direction: "smaller_is_better", baseline: 100, current: 101, percentChange: 1, status: "stable" },
        { benchmark: "B", metric: "m", direction: "smaller_is_better", baseline: 200, current: 198, percentChange: -1, status: "stable" },
      ],
    };
    assert.equal(headlineText(result), "No regressions");
    assert.deepEqual(categorize(result), { regressed: 0, improved: 0, stable: 2 });
  });

  it("reports regression count with plural", () => {
    const result: ComparisonResult = {
      hasRegression: true,
      entries: [
        { benchmark: "A", metric: "m", direction: "smaller_is_better", baseline: 100, current: 150, percentChange: 50, status: "regressed" },
        { benchmark: "B", metric: "m", direction: "smaller_is_better", baseline: 100, current: 140, percentChange: 40, status: "regressed" },
        { benchmark: "C", metric: "m", direction: "bigger_is_better", baseline: 100, current: 120, percentChange: 20, status: "improved" },
      ],
    };
    assert.equal(headlineText(result), "2 regressions detected");
    assert.deepEqual(categorize(result), { regressed: 2, improved: 1, stable: 0 });
  });

  it("uses singular for single regression", () => {
    const result: ComparisonResult = {
      hasRegression: true,
      entries: [
        { benchmark: "A", metric: "m", direction: "smaller_is_better", baseline: 100, current: 120, percentChange: 20, status: "regressed" },
      ],
    };
    assert.equal(headlineText(result), "1 regression detected");
  });

  it("handles empty entries", () => {
    const result: ComparisonResult = { hasRegression: false, entries: [] };
    assert.equal(headlineText(result), "No regressions");
    assert.deepEqual(categorize(result), { regressed: 0, improved: 0, stable: 0 });
  });
});
