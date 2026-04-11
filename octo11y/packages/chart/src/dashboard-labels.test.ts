import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultDashboardLabels, resolveLabels } from "./dashboard-labels.js";

describe("resolveLabels", () => {
  it("returns defaults when no overrides given", () => {
    const labels = resolveLabels();
    assert.deepStrictEqual(labels, defaultDashboardLabels);
  });

  it("returns defaults when undefined is passed", () => {
    const labels = resolveLabels(undefined);
    assert.deepStrictEqual(labels, defaultDashboardLabels);
  });

  it("overrides specific keys while keeping defaults for the rest", () => {
    const labels = resolveLabels({ brand: "My App", heroTitle: "Overview" });
    assert.equal(labels.brand, "My App");
    assert.equal(labels.heroTitle, "Overview");
    assert.equal(labels.loadingTitle, defaultDashboardLabels.loadingTitle);
    assert.equal(labels.monitorTitle, defaultDashboardLabels.monitorTitle);
  });

  it("overrides all keys when a full object is passed", () => {
    const full = { ...defaultDashboardLabels, brand: "Custom" };
    const labels = resolveLabels(full);
    assert.equal(labels.brand, "Custom");
    assert.equal(labels.heroTitle, defaultDashboardLabels.heroTitle);
  });
});

describe("defaultDashboardLabels", () => {
  it("has non-empty values for all keys", () => {
    for (const [key, value] of Object.entries(defaultDashboardLabels)) {
      assert.ok(typeof value === "string" && value.length > 0, `${key} should be a non-empty string`);
    }
  });
});
