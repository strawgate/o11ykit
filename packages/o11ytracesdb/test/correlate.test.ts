import { describe, expect, it } from "vitest";
import {
  computeServiceGraph,
  deriveREDMetrics,
  extractServiceNames,
  extractTraceIds,
  spanTimeWindow,
  traceTimeWindow,
} from "../src/correlate.js";
import type { SpanRecord, Trace } from "../src/types.js";
import { SpanKind, StatusCode } from "../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function fixedBytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function makeSpan(opts: {
  traceId?: number;
  spanId?: number;
  parentSpanId?: number;
  name?: string;
  kind?: number;
  start?: bigint;
  duration?: bigint;
  status?: number;
  serviceName?: string;
}): SpanRecord {
  const start = opts.start ?? 1700000000000000000n;
  const dur = opts.duration ?? 50_000_000n;
  return {
    traceId: fixedBytes(16, opts.traceId ?? 0xaa),
    spanId: fixedBytes(8, opts.spanId ?? 0x01),
    ...(opts.parentSpanId !== undefined ? { parentSpanId: fixedBytes(8, opts.parentSpanId) } : {}),
    name: opts.name ?? "test-op",
    kind: (opts.kind ?? SpanKind.SERVER) as SpanRecord["kind"],
    startTimeUnixNano: start,
    endTimeUnixNano: start + dur,
    durationNanos: dur,
    statusCode: (opts.status ?? StatusCode.OK) as SpanRecord["statusCode"],
    attributes: opts.serviceName ? [{ key: "service.name", value: opts.serviceName }] : [],
    events: [],
    links: [],
  };
}

// ─── Time Window Tests ───────────────────────────────────────────────

describe("Time window extraction", () => {
  it("extracts time window from a trace", () => {
    const spans = [
      makeSpan({ start: 1000n, duration: 100n }),
      makeSpan({ start: 1050n, duration: 200n }),
      makeSpan({ start: 900n, duration: 50n }),
    ];
    const trace: Trace = {
      traceId: fixedBytes(16, 0xaa),
      spans,
      durationNanos: 350n,
    };

    const window = traceTimeWindow(trace);
    expect(window.startNano).toBe(900n);
    expect(window.endNano).toBe(1250n); // 1050 + 200
  });

  it("applies padding to time window", () => {
    const spans = [makeSpan({ start: 1000n, duration: 100n })];
    const trace: Trace = {
      traceId: fixedBytes(16, 0xaa),
      spans,
      durationNanos: 100n,
    };

    const window = traceTimeWindow(trace, 500n);
    expect(window.startNano).toBe(500n); // 1000 - 500
    expect(window.endNano).toBe(1600n); // 1100 + 500
  });

  it("extracts time window from a single span", () => {
    const span = makeSpan({ start: 5000n, duration: 300n });
    const window = spanTimeWindow(span, 100n);
    expect(window.startNano).toBe(4900n);
    expect(window.endNano).toBe(5400n);
  });
});

// ─── RED Metrics Tests ───────────────────────────────────────────────

describe("RED metrics derivation", () => {
  it("computes rate, errors, and duration stats", () => {
    const baseTime = 1700000000000000000n;
    const spans = [
      makeSpan({ name: "GET /api", start: baseTime, duration: 10_000_000n, status: StatusCode.OK }),
      makeSpan({
        name: "GET /api",
        start: baseTime + 1_000_000n,
        duration: 20_000_000n,
        status: StatusCode.OK,
      }),
      makeSpan({
        name: "GET /api",
        start: baseTime + 2_000_000n,
        duration: 100_000_000n,
        status: StatusCode.ERROR,
      }),
    ];

    const metrics = deriveREDMetrics(spans, 60_000_000_000n, "api-gateway");
    expect(metrics.length).toBe(1);

    const m = metrics[0]!;
    expect(m.serviceName).toBe("api-gateway");
    expect(m.operationName).toBe("GET /api");
    expect(m.rate).toBe(3);
    expect(m.errors).toBe(1);
    expect(m.errorRate).toBeCloseTo(1 / 3);
    expect(m.duration.min).toBe(10_000_000n);
    expect(m.duration.max).toBe(100_000_000n);
    expect(m.duration.count).toBe(3);
  });

  it("groups by operation name", () => {
    const baseTime = 1700000000000000000n;
    const spans = [
      makeSpan({ name: "GET /users", start: baseTime, duration: 10_000_000n }),
      makeSpan({ name: "POST /users", start: baseTime + 1_000_000n, duration: 20_000_000n }),
      makeSpan({ name: "GET /users", start: baseTime + 2_000_000n, duration: 5_000_000n }),
    ];

    const metrics = deriveREDMetrics(spans);
    expect(metrics.length).toBe(2);
    const getMetrics = metrics.find((m) => m.operationName === "GET /users")!;
    const postMetrics = metrics.find((m) => m.operationName === "POST /users")!;
    expect(getMetrics.rate).toBe(2);
    expect(postMetrics.rate).toBe(1);
  });

  it("computes percentiles correctly", () => {
    const baseTime = 1700000000000000000n;
    // Create 100 spans with durations 1ms, 2ms, ..., 100ms
    const spans = Array.from({ length: 100 }, (_, i) =>
      makeSpan({
        name: "op",
        start: baseTime + BigInt(i) * 1000n,
        duration: BigInt(i + 1) * 1_000_000n,
      })
    );

    const metrics = deriveREDMetrics(spans);
    expect(metrics.length).toBe(1);
    const m = metrics[0]!;
    expect(m.duration.p50).toBe(50_000_000n); // ~50ms
    expect(m.duration.p95).toBe(95_000_000n); // ~95ms
    expect(m.duration.p99).toBe(99_000_000n); // ~99ms
  });
});

// ─── Service Graph Tests ─────────────────────────────────────────────

describe("Service graph", () => {
  it("detects CLIENT→SERVER edges between services", () => {
    // Simulate: frontend (CLIENT) → backend (SERVER)
    const clientSpan = makeSpan({
      spanId: 0x01,
      kind: SpanKind.CLIENT,
      parentSpanId: 0xff, // some parent
      name: "call-backend",
      serviceName: "frontend",
    });
    const serverSpan = makeSpan({
      spanId: 0x02,
      kind: SpanKind.SERVER,
      parentSpanId: 0x01, // child of client span
      name: "handle-request",
      serviceName: "backend",
    });

    const edges = computeServiceGraph([clientSpan, serverSpan]);
    expect(edges.length).toBe(1);
    expect(edges[0]!.source).toBe("frontend");
    expect(edges[0]!.target).toBe("backend");
    expect(edges[0]!.callCount).toBe(1);
  });

  it("aggregates multiple calls into edge weight", () => {
    const spans: SpanRecord[] = [];
    for (let i = 0; i < 5; i++) {
      spans.push(
        makeSpan({
          spanId: i * 2 + 1,
          kind: SpanKind.CLIENT,
          parentSpanId: 0xff,
          name: "call",
          serviceName: "svc-a",
        })
      );
      spans.push(
        makeSpan({
          spanId: i * 2 + 2,
          kind: SpanKind.SERVER,
          parentSpanId: i * 2 + 1,
          name: "handle",
          serviceName: "svc-b",
          status: i === 4 ? StatusCode.ERROR : StatusCode.OK,
        })
      );
    }

    const edges = computeServiceGraph(spans);
    expect(edges.length).toBe(1);
    expect(edges[0]!.callCount).toBe(5);
    expect(edges[0]!.errorCount).toBe(1);
  });
});

// ─── Trace ID / Service Name Extraction ──────────────────────────────

describe("Correlation helpers", () => {
  it("extracts unique trace IDs as hex", () => {
    const spans = [
      makeSpan({ traceId: 0xaa }),
      makeSpan({ traceId: 0xbb }),
      makeSpan({ traceId: 0xaa }), // duplicate
    ];

    const ids = extractTraceIds(spans);
    expect(ids.length).toBe(2);
    expect(ids).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".slice(0, 32)); // 16 bytes of 0xAA
  });

  it("extracts unique service names", () => {
    const spans = [
      makeSpan({ serviceName: "frontend" }),
      makeSpan({ serviceName: "backend" }),
      makeSpan({ serviceName: "frontend" }), // duplicate
      makeSpan({}), // no service name
    ];

    const names = extractServiceNames(spans);
    expect(names.length).toBe(2);
    expect(names).toContain("frontend");
    expect(names).toContain("backend");
  });
});

// ─── Bug regression tests ────────────────────────────────────────────

describe("Bug fixes", () => {
  it("handles span names containing pipe characters in RED metrics", () => {
    const baseTime = 1700000000000000000n;
    const spans = [
      makeSpan({ name: "graphql|query|mutation", start: baseTime, duration: 10_000_000n }),
      makeSpan({ name: "graphql|query|mutation", start: baseTime + 1000n, duration: 20_000_000n }),
    ];

    // Should not throw SyntaxError from BigInt parsing
    const metrics = deriveREDMetrics(spans);
    expect(metrics.length).toBe(1);
    expect(metrics[0]!.operationName).toBe("graphql|query|mutation");
    expect(metrics[0]!.rate).toBe(2);
  });

  it("detects service graph edges from root CLIENT spans (no parentSpanId)", () => {
    // Root CLIENT span (no parent) calling a child SERVER span
    const clientSpan = makeSpan({
      spanId: 0x01,
      kind: SpanKind.CLIENT,
      // No parentSpanId — this is the trace root
      name: "call-downstream",
      serviceName: "api-gateway",
    });
    const serverSpan = makeSpan({
      spanId: 0x02,
      kind: SpanKind.SERVER,
      parentSpanId: 0x01,
      name: "handle-request",
      serviceName: "user-service",
    });

    const edges = computeServiceGraph([clientSpan, serverSpan]);
    expect(edges.length).toBe(1);
    expect(edges[0]!.source).toBe("api-gateway");
    expect(edges[0]!.target).toBe("user-service");
  });
});
