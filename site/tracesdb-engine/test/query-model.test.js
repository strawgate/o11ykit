import { describe, expect, it } from "vitest";
import { aggregateResults, buildQueryPreview, executeQuery } from "../js/query-model.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSpan(overrides = {}) {
  return {
    traceId: "aabb00112233445566778899aabbccdd",
    spanId: "1122334455667788",
    parentSpanId: "",
    name: "GET /api/users",
    kind: 2,
    startTimeUnixNano: 1000000000n,
    endTimeUnixNano: 1050000000n,
    durationNanos: 50000000n, // 50ms
    statusCode: 1,
    attributes: [
      { key: "service.name", value: "gateway" },
      { key: "http.method", value: "GET" },
    ],
    events: [],
    links: [],
    ...overrides,
  };
}

function buildTestSpans() {
  return [
    makeSpan({ spanId: "0000000000000001" }),
    makeSpan({
      traceId: "aabb00112233445566778899aabbccdd",
      spanId: "0000000000000002",
      parentSpanId: "0000000000000001",
      name: "SELECT users",
      kind: 3,
      startTimeUnixNano: 1010000000n,
      endTimeUnixNano: 1040000000n,
      durationNanos: 30000000n,
      attributes: [
        { key: "service.name", value: "database" },
        { key: "db.system", value: "postgresql" },
      ],
    }),
    makeSpan({
      traceId: "ff00112233445566778899aabbccddee",
      spanId: "0000000000000003",
      name: "POST /api/orders",
      startTimeUnixNano: 2000000000n,
      endTimeUnixNano: 2200000000n,
      durationNanos: 200000000n,
      statusCode: 2,
      attributes: [
        { key: "service.name", value: "gateway" },
        { key: "http.method", value: "POST" },
      ],
    }),
    makeSpan({
      traceId: "ff00112233445566778899aabbccddee",
      spanId: "0000000000000004",
      parentSpanId: "0000000000000003",
      name: "INSERT orders",
      kind: 3,
      startTimeUnixNano: 2020000000n,
      endTimeUnixNano: 2180000000n,
      durationNanos: 160000000n,
      statusCode: 2,
      attributes: [
        { key: "service.name", value: "database" },
        { key: "db.system", value: "postgresql" },
      ],
    }),
  ];
}

// ── Tests ────────────────────────────────────────────────────────────

describe("executeQuery", () => {
  it("returns all traces when no filters applied", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans);
    expect(result.traceCount).toBe(2);
    expect(result.totalSpans).toBe(4);
  });

  it("filters by service", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, { service: "database" });
    expect(result.matchedSpans).toBe(2);
    // Both traces have a database span
    expect(result.traceCount).toBe(2);
  });

  it("filters by span name regex", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, { spanName: "SELECT" });
    expect(result.matchedSpans).toBe(1);
  });

  it("filters by status code", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, { statusCode: 2 });
    expect(result.matchedSpans).toBe(2);
    expect(result.traceCount).toBe(1);
  });

  it("filters by span kind", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, { spanKind: 3 });
    expect(result.matchedSpans).toBe(2);
  });

  it("filters by min duration", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, { minDurationMs: 100 });
    expect(result.matchedSpans).toBe(2); // 200ms and 160ms
  });

  it("filters by max duration", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, { maxDurationMs: 40 });
    expect(result.matchedSpans).toBe(1); // 30ms
  });

  it("filters by attribute with = operator", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, {
      attrFilters: [{ key: "db.system", op: "=", value: "postgresql" }],
    });
    expect(result.matchedSpans).toBe(2);
  });

  it("filters by attribute with != operator", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, {
      attrFilters: [{ key: "http.method", op: "!=", value: "GET" }],
    });
    // POST span + two database spans (no http.method → undefined → "!=" returns true)
    expect(result.matchedSpans).toBe(3);
  });

  it("filters by attribute with ~ (contains) operator", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, {
      attrFilters: [{ key: "http.method", op: "~", value: "PO" }],
    });
    expect(result.matchedSpans).toBe(1);
  });

  it("sorts by duration descending by default", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, {});
    const durations = result.traces.map((t) => t.duration);
    for (let i = 1; i < durations.length; i++) {
      expect(durations[i]).toBeLessThanOrEqual(durations[i - 1]);
    }
  });

  it("respects limit", () => {
    const spans = buildTestSpans();
    const result = executeQuery(spans, { limit: 1 });
    expect(result.traceCount).toBe(1);
  });
});

describe("buildQueryPreview", () => {
  it("includes service filter in preview", () => {
    const html = buildQueryPreview({ service: "gateway" });
    expect(html).toContain("gateway");
    expect(html).toContain("resource.service.name");
  });

  it("includes span name filter", () => {
    const html = buildQueryPreview({ spanName: "SELECT" });
    expect(html).toContain("SELECT");
    expect(html).toContain("name");
  });

  it("includes status code filter", () => {
    const html = buildQueryPreview({ statusCode: 2 });
    expect(html).toContain("error");
  });

  it("includes duration filters", () => {
    const html = buildQueryPreview({ minDurationMs: 100, maxDurationMs: 500 });
    expect(html).toContain("100ms");
    expect(html).toContain("500ms");
  });

  it("includes attribute filters", () => {
    const html = buildQueryPreview({
      attrFilters: [{ key: "http.method", op: "=", value: "GET" }],
    });
    expect(html).toContain(".http.method");
    expect(html).toContain("GET");
  });

  it("includes structural predicates", () => {
    const html = buildQueryPreview({
      structural: { type: "hasDescendant", service: "database" },
    });
    expect(html).toContain("hasDescendant");
    expect(html).toContain("database");
  });

  it("includes sort and limit", () => {
    const html = buildQueryPreview({
      sortBy: "duration",
      sortDir: "desc",
      limit: 50,
    });
    expect(html).toContain("sort");
    expect(html).toContain("duration");
    expect(html).toContain("50");
  });

  it("shows select-all comment when no filters", () => {
    const html = buildQueryPreview({});
    expect(html).toContain("select all spans");
  });
});

describe("aggregateResults", () => {
  it("counts traces with no groupBy", () => {
    const traces = [
      { duration: 100, spanCount: 3 },
      { duration: 200, spanCount: 5 },
    ];
    const result = aggregateResults(traces, { fn: "count" });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].value).toBe(2);
  });

  it("computes avg duration", () => {
    const traces = [
      { duration: 100, spanCount: 3 },
      { duration: 200, spanCount: 5 },
    ];
    const result = aggregateResults(traces, { fn: "avg", field: "duration" });
    expect(result.groups[0].value).toBe(150);
  });

  it("groups by rootService", () => {
    const traces = [
      { rootService: "gateway", duration: 100 },
      { rootService: "gateway", duration: 200 },
      { rootService: "auth", duration: 50 },
    ];
    const result = aggregateResults(traces, {
      fn: "count",
      groupBy: "rootService",
    });
    expect(result.groups.length).toBe(2);
    const gw = result.groups.find((g) => g.key === "gateway");
    expect(gw.value).toBe(2);
  });
});
