import { describe, expect, it } from "vitest";
import {
  estimateScenarioBytes,
  estimateScenarioSpans,
  generateScenarioData,
  SCENARIOS,
} from "../js/data-gen.js";

describe("SCENARIOS", () => {
  it("contains at least 5 built-in scenarios plus custom", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(6);
    expect(SCENARIOS.some((s) => s.id === "custom")).toBe(true);
  });

  it("each scenario has required fields", () => {
    for (const s of SCENARIOS) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.emoji).toBeTruthy();
      expect(typeof s.description).toBe("string");
      expect(s.meta).toBeTruthy();
    }
  });
});

describe("generateScenarioData", () => {
  it("generates valid spans for the microservices scenario", async () => {
    const result = await generateScenarioData("microservices", { targetSpans: 50 });
    expect(result.spans.length).toBeGreaterThan(0);
    expect(result.traceCount).toBeGreaterThan(0);
    expect(result.serviceNames).toContain("gateway");
    expect(result.serviceCount).toBe(result.serviceNames.length);
  });

  it("generates spans with correct ID lengths", async () => {
    const result = await generateScenarioData("database-heavy", { targetSpans: 30 });
    for (const span of result.spans) {
      // traceId: 16 bytes = 32 hex chars
      expect(span.traceId).toHaveLength(32);
      // spanId: 8 bytes = 16 hex chars
      expect(span.spanId).toHaveLength(16);
    }
  });

  it("parentSpanId references exist in the same trace", async () => {
    const result = await generateScenarioData("microservices", { targetSpans: 80 });
    const spansByTrace = new Map();
    for (const span of result.spans) {
      if (!spansByTrace.has(span.traceId)) spansByTrace.set(span.traceId, new Set());
      spansByTrace.get(span.traceId).add(span.spanId);
    }

    for (const span of result.spans) {
      if (span.parentSpanId) {
        expect(spansByTrace.get(span.traceId).has(span.parentSpanId)).toBe(true);
      }
    }
  });

  it("services match the expected list for the scenario", async () => {
    const result = await generateScenarioData("database-heavy", { targetSpans: 30 });
    const expected = ["gateway", "orders", "database", "cache", "queue"];
    for (const name of result.serviceNames) {
      expect(expected).toContain(name);
    }
  });

  it("custom scenario config works", async () => {
    // For custom, meta.services is the slice count and options.services is the name list.
    // Passing both under the same key would conflict, so just use the defaults
    // and override the count + other knobs.
    const result = await generateScenarioData("custom", {
      targetSpans: 30,
      depth: 2,
      width: 2,
      errorRate: 0.1,
    });
    // defaults to first 6 of microservices list
    expect(result.serviceCount).toBe(6);
    expect(result.spans.length).toBeGreaterThan(0);
  });

  it("progress callback is called", async () => {
    const calls = [];
    await generateScenarioData("microservices", { targetSpans: 50 }, (progress) => {
      calls.push(progress);
    });

    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    expect(last.phase).toBe("complete");
    expect(last.spans).toBeGreaterThan(0);

    const generating = calls.filter((c) => c.phase === "generating");
    expect(generating.length).toBeGreaterThan(0);
  });

  it("throws on unknown scenario id", async () => {
    await expect(generateScenarioData("nonexistent")).rejects.toThrow("Unknown scenario");
  });
});

describe("estimateScenarioSpans", () => {
  it("returns targetSpans from meta for known scenarios", () => {
    const ms = SCENARIOS.find((s) => s.id === "microservices");
    expect(estimateScenarioSpans(ms)).toBe(250_000);
  });

  it("returns 0 for custom scenario with no targetSpans", () => {
    const custom = SCENARIOS.find((s) => s.id === "custom");
    expect(estimateScenarioSpans(custom)).toBe(0);
  });
});

describe("estimateScenarioBytes", () => {
  it("returns targetSpans * 280 bytes", () => {
    const ms = SCENARIOS.find((s) => s.id === "microservices");
    expect(estimateScenarioBytes(ms)).toBe(250_000 * 280);
  });

  it("returns 0 for custom scenario", () => {
    const custom = SCENARIOS.find((s) => s.id === "custom");
    expect(estimateScenarioBytes(custom)).toBe(0);
  });
});
