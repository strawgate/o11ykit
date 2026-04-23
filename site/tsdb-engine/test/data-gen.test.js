import { describe, expect, it } from "vitest";
import {
  generateScenarioData,
  SCENARIOS,
  scenarioSampleCount,
  scenarioSeriesCount,
} from "../js/data-gen.js";

describe("data-gen kubernetes scenario", () => {
  it("uses OpenTelemetry-style metric and label names", () => {
    const scenario = SCENARIOS.find((entry) => entry.id === "kubernetes");
    expect(scenario).toBeTruthy();
    expect(scenarioSeriesCount(scenario)).toBeGreaterThan(0);

    const series = generateScenarioData({ ...scenario, numPoints: 2 });
    const metricNames = new Set(series.map((entry) => entry.labels.get("__name__")));

    expect(metricNames.has("k8s.pod.cpu.usage")).toBe(true);
    expect(metricNames.has("k8s.pod.memory.working_set")).toBe(true);
    expect(metricNames.has("k8s.pod.network.io")).toBe(true);

    const first = series[0];
    expect(first.labels.has("k8s.cluster.name")).toBe(true);
    expect(first.labels.has("k8s.namespace.name")).toBe(true);
    expect(first.labels.has("k8s.node.name")).toBe(true);
    expect(first.labels.has("k8s.pod.name")).toBe(true);
  });

  it("scales the kubernetes scenario to roughly 10x the original sample volume", () => {
    const scenario = SCENARIOS.find((entry) => entry.id === "kubernetes");
    expect(scenario).toBeTruthy();
    expect(scenarioSeriesCount(scenario)).toBe(468);
    expect(scenarioSampleCount(scenario)).toBe(9_360_000);
  });
});
