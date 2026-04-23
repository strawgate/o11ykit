import { describe, expect, it } from "vitest";
import {
  buildQueryPreviewHtml,
  buildQueryRecipeConfig,
  formatEffectiveStepStat,
  formatStepLabel,
  summarizeStepResolution,
} from "../js/query-builder-model.js";

describe("query-builder-model", () => {
  it("formats steps for human-readable UI labels", () => {
    expect(formatStepLabel(null)).toBe("raw");
    expect(formatStepLabel(1_000_000_000n)).toBe("1s");
    expect(formatStepLabel(169_000_000_000n)).toBe("2m 49s");
  });

  it("builds the query preview from query state", () => {
    const html = buildQueryPreviewHtml({
      metric: "http_requests_total",
      matchers: [{ label: "service", op: "=", value: "frontend" }],
      transform: "rate",
      agg: "sum",
      groupBy: ["region"],
      stepMs: 60000,
    });

    expect(html).toContain("http_requests_total");
    expect(html).toContain("service");
    expect(html).toContain("frontend");
    expect(html).toContain("rate");
    expect(html).toContain("sum");
    expect(html).toContain("[1m]");
    expect(html).toContain("region");
  });

  it("maps quick-query recipes into pure query state", () => {
    const recipe = buildQueryRecipeConfig("count", "k8s.pod.cpu.usage", (metric, count) => {
      expect(metric).toBe("k8s.pod.cpu.usage");
      expect(count).toBe(2);
      return ["k8s.namespace.name", "k8s.node.name"];
    });

    expect(recipe).toEqual({
      agg: "count",
      transform: "",
      stepMs: 60000,
      groupBy: ["k8s.namespace.name", "k8s.node.name"],
    });
  });

  it("summarizes auto-widened step resolution", () => {
    const result = {
      requestedStep: 1_000_000_000n,
      effectiveStep: 169_000_000_000n,
      pointBudget: 445,
    };

    expect(summarizeStepResolution(result)).toBe("step widened from 1s to 2m 49s for ~445 points");
    expect(formatEffectiveStepStat(result)).toContain("2m 49s");
    expect(formatEffectiveStepStat(result)).toContain("auto");
  });
});
