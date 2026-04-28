import { describe, expect, it } from "vitest";
import {
  computeServiceMetrics,
  detectProblematicTraces,
  generateInsights,
  groupByTrace,
} from "../js/traces-model.js";
import { hexToBytes } from "../js/utils.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSpan(overrides = {}) {
  return {
    traceId: hexToBytes("aabb00112233445566778899aabbccdd"),
    spanId: hexToBytes("1122334455667788"),
    parentSpanId: undefined,
    name: "GET /api",
    kind: 2,
    startTimeUnixNano: 1000000000n,
    endTimeUnixNano: 1050000000n,
    durationNanos: 50000000n, // 50ms
    statusCode: 1,
    attributes: [{ key: "service.name", value: "gateway" }],
    events: [],
    links: [],
    ...overrides,
  };
}

const serviceNames = ["gateway", "database"];

function buildSpans() {
  return [
    makeSpan({ spanId: hexToBytes("0000000000000001") }),
    makeSpan({
      traceId: hexToBytes("aabb00112233445566778899aabbccdd"),
      spanId: hexToBytes("0000000000000002"),
      parentSpanId: hexToBytes("0000000000000001"),
      name: "SELECT users",
      startTimeUnixNano: 1010000000n,
      endTimeUnixNano: 1040000000n,
      durationNanos: 30000000n,
      attributes: [{ key: "service.name", value: "database" }],
    }),
    makeSpan({
      traceId: hexToBytes("ff00112233445566778899aabbccddee"),
      spanId: hexToBytes("0000000000000003"),
      name: "POST /api/orders",
      startTimeUnixNano: 2000000000n,
      endTimeUnixNano: 2200000000n,
      durationNanos: 200000000n,
      statusCode: 2,
    }),
    makeSpan({
      traceId: hexToBytes("ff00112233445566778899aabbccddee"),
      spanId: hexToBytes("0000000000000004"),
      parentSpanId: hexToBytes("0000000000000003"),
      name: "INSERT orders",
      startTimeUnixNano: 2020000000n,
      endTimeUnixNano: 2180000000n,
      durationNanos: 160000000n,
      statusCode: 2,
      attributes: [{ key: "service.name", value: "database" }],
    }),
  ];
}

// ── Tests ────────────────────────────────────────────────────────────

describe("groupByTrace", () => {
  it("groups spans by traceId", () => {
    const spans = buildSpans();
    const groups = groupByTrace(spans);
    expect(groups.size).toBe(2);
    expect(groups.get("aabb00112233445566778899aabbccdd").length).toBe(2);
    expect(groups.get("ff00112233445566778899aabbccddee").length).toBe(2);
  });

  it("handles a single span", () => {
    const groups = groupByTrace([makeSpan()]);
    expect(groups.size).toBe(1);
  });
});

describe("computeServiceMetrics", () => {
  it("returns per-service RED stats", () => {
    const spans = buildSpans();
    const metrics = computeServiceMetrics(spans, serviceNames);

    expect(metrics.size).toBe(2);

    const gw = metrics.get("gateway");
    expect(gw.spanCount).toBe(2);
    expect(gw.errorCount).toBe(1);
    expect(gw.errorRate).toBeCloseTo(0.5, 1);
    expect(gw.avgDurationNs).toBeGreaterThan(0);
    expect(gw.p50DurationNs).toBeGreaterThan(0);

    const db = metrics.get("database");
    expect(db.spanCount).toBe(2);
    expect(db.errorCount).toBe(1);
  });

  it("returns empty metrics when no spans", () => {
    const metrics = computeServiceMetrics([], serviceNames);
    const gw = metrics.get("gateway");
    expect(gw.spanCount).toBe(0);
    // errorRate is only set after the sort loop, which is skipped for empty spans
    expect(gw.errorRate).toBeUndefined();
  });
});

describe("detectProblematicTraces", () => {
  it("finds traces with errors", () => {
    const spans = buildSpans();
    const metrics = computeServiceMetrics(spans, serviceNames);
    const problems = detectProblematicTraces(spans, metrics);

    expect(problems.length).toBeGreaterThan(0);
    const errorTrace = problems.find((p) => p.traceId === "ff00112233445566778899aabbccddee");
    expect(errorTrace).toBeTruthy();
    expect(errorTrace.errorCount).toBe(2);
    expect(errorTrace.issues.some((i) => i.type === "errors")).toBe(true);
  });

  it("finds slow traces (> 1s)", () => {
    const slowSpan = makeSpan({
      traceId: hexToBytes("1111111111111111aaaaaaaaaaaaaaaa"),
      spanId: hexToBytes("aaaaaaaaaaaaaaaa"),
      startTimeUnixNano: 0n,
      endTimeUnixNano: 2_000_000_000n,
      durationNanos: 2_000_000_000n,
    });

    const metrics = computeServiceMetrics([slowSpan], ["gateway"]);
    const problems = detectProblematicTraces([slowSpan], metrics);

    expect(problems.length).toBe(1);
    expect(problems[0].issues.some((i) => i.type === "slow")).toBe(true);
  });
});

describe("generateInsights", () => {
  it("reports high error rate services", () => {
    const spans = buildSpans();
    const metrics = computeServiceMetrics(spans, serviceNames);
    const insights = generateInsights(metrics);

    expect(insights.length).toBeGreaterThan(0);
    const errorInsight = insights.find((i) => i.message.includes("error rate"));
    expect(errorInsight).toBeTruthy();
  });

  it("produces overall error rate insight", () => {
    const spans = buildSpans();
    const metrics = computeServiceMetrics(spans, serviceNames);
    const insights = generateInsights(metrics);

    const overall = insights.find((i) => i.message.includes("Overall"));
    expect(overall).toBeTruthy();
    expect(overall.severity).toBe("low");
  });

  it("returns empty for perfect metrics", () => {
    const spans = [makeSpan({ statusCode: 1 })];
    const metrics = computeServiceMetrics(spans, ["gateway"]);
    const insights = generateInsights(metrics);
    expect(insights.length).toBe(0);
  });
});
