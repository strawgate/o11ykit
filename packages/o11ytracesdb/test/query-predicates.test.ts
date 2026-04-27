/**
 * Tests for the rich query predicates, trace-level intrinsics,
 * sort/pagination, and the fluent TraceQuery builder.
 */
import { describe, expect, it } from "vitest";
import { TraceStore } from "../src/engine.js";
import { queryTraces } from "../src/query.js";
import { TraceQuery } from "../src/query-builder.js";
import type { SpanRecord } from "../src/types.js";
import { SpanKind, StatusCode } from "../src/types.js";

// ─── Test helpers ────────────────────────────────────────────────────

let idCounter = 0;
function makeId(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  buf[0] = ++idCounter;
  return buf;
}

const TRACE_A = makeId(16);
const TRACE_B = makeId(16);
const TRACE_C = makeId(16);

function span(overrides: Partial<SpanRecord> & { traceId: Uint8Array; name: string }): SpanRecord {
  const start = 1700000000000000000n + BigInt(idCounter) * 1_000_000n;
  return {
    spanId: makeId(8),
    kind: SpanKind.SERVER,
    startTimeUnixNano: start,
    endTimeUnixNano: start + 10_000_000n,
    durationNanos: 10_000_000n,
    statusCode: StatusCode.OK,
    attributes: [],
    events: [],
    links: [],
    ...overrides,
  };
}

function buildStore(spans: SpanRecord[]): TraceStore {
  const store = new TraceStore({ chunkSize: 256 });
  const resource = { attributes: [{ key: "service.name", value: "test-svc" }] };
  const scope = { name: "test", version: "1.0" };
  store.append(resource, scope, spans);
  store.flush();
  return store;
}

// ─── Test data ───────────────────────────────────────────────────────

const spans: SpanRecord[] = [
  // Trace A: 3 spans, frontend service, some with errors
  span({
    traceId: TRACE_A,
    name: "GET /api/users",
    durationNanos: 50_000_000n,
    startTimeUnixNano: 1700000000000000000n,
    endTimeUnixNano: 1700000000050000000n,
    kind: SpanKind.SERVER,
    attributes: [
      { key: "http.method", value: "GET" },
      { key: "http.status_code", value: 200 },
      { key: "http.url", value: "/api/users" },
    ],
  }),
  span({
    traceId: TRACE_A,
    name: "db.query SELECT",
    durationNanos: 30_000_000n,
    startTimeUnixNano: 1700000000010000000n,
    endTimeUnixNano: 1700000000040000000n,
    parentSpanId: makeId(8),
    kind: SpanKind.CLIENT,
    attributes: [
      { key: "db.system", value: "postgresql" },
      { key: "db.statement", value: "SELECT * FROM users WHERE id = $1" },
    ],
  }),
  span({
    traceId: TRACE_A,
    name: "cache.lookup",
    durationNanos: 2_000_000n,
    startTimeUnixNano: 1700000000005000000n,
    endTimeUnixNano: 1700000000007000000n,
    parentSpanId: makeId(8),
    kind: SpanKind.INTERNAL,
    attributes: [{ key: "cache.hit", value: false }],
  }),

  // Trace B: 2 spans, error trace, POST method
  span({
    traceId: TRACE_B,
    name: "POST /api/orders",
    durationNanos: 200_000_000n,
    startTimeUnixNano: 1700000000100000000n,
    endTimeUnixNano: 1700000000300000000n,
    statusCode: StatusCode.ERROR,
    kind: SpanKind.SERVER,
    attributes: [
      { key: "http.method", value: "POST" },
      { key: "http.status_code", value: 500 },
      { key: "http.url", value: "/api/orders" },
      { key: "error", value: true },
    ],
  }),
  span({
    traceId: TRACE_B,
    name: "db.query INSERT",
    durationNanos: 180_000_000n,
    startTimeUnixNano: 1700000000110000000n,
    endTimeUnixNano: 1700000000290000000n,
    parentSpanId: makeId(8),
    kind: SpanKind.CLIENT,
    statusCode: StatusCode.ERROR,
    attributes: [
      { key: "db.system", value: "postgresql" },
      { key: "db.statement", value: "INSERT INTO orders VALUES ($1, $2)" },
      { key: "error", value: true },
    ],
  }),

  // Trace C: 1 span, short consumer span
  span({
    traceId: TRACE_C,
    name: "kafka.consume",
    durationNanos: 1_000_000n,
    startTimeUnixNano: 1700000000500000000n,
    endTimeUnixNano: 1700000000501000000n,
    kind: SpanKind.CONSUMER,
    attributes: [
      { key: "messaging.system", value: "kafka" },
      { key: "messaging.destination", value: "orders-topic" },
    ],
  }),
];

const store = buildStore(spans);

// ─── Attribute predicates ────────────────────────────────────────────

describe("attribute predicates", () => {
  it("eq — exact match", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.method", op: "eq", value: "GET" }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });

  it("neq — not equal", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.method", op: "neq", value: "GET" }],
    });
    // Only B has a span with http.method != "GET" (it has POST)
    // A's span with http.method has "GET" which fails neq
    // Spans without http.method return false for neq (attr not found)
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("gt — greater than numeric", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.status_code", op: "gt", value: 400 }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("gte — greater than or equal", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.status_code", op: "gte", value: 200 }],
    });
    expect(result.traces.length).toBe(2); // A (200) and B (500)
  });

  it("lt — less than", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.status_code", op: "lt", value: 300 }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });

  it("lte — less than or equal", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.status_code", op: "lte", value: 500 }],
    });
    expect(result.traces.length).toBe(2);
  });

  it("regex — pattern match", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "db.statement", op: "regex", value: "SELECT.*FROM" }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });

  it("contains — substring match", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.url", op: "contains", value: "/api/" }],
    });
    expect(result.traces.length).toBe(2); // A and B both have /api/ URLs
  });

  it("startsWith — prefix match", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.url", op: "startsWith", value: "/api/orders" }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("exists — attribute present", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "error", op: "exists" }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("notExists — attribute absent", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "messaging.system", op: "notExists" }],
    });
    // Traces A and B have spans without messaging.system; C only has messaging.system spans
    expect(result.traces.length).toBe(2);
  });

  it("in — value in set", () => {
    const result = queryTraces(store, {
      attributePredicates: [{ key: "http.method", op: "in", value: ["GET", "POST"] }],
    });
    expect(result.traces.length).toBe(2); // A (GET) and B (POST)
  });

  it("multiple predicates are AND-ed", () => {
    const result = queryTraces(store, {
      attributePredicates: [
        { key: "http.method", op: "eq", value: "POST" },
        { key: "http.status_code", op: "gte", value: 500 },
      ],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });
});

// ─── Span name regex ─────────────────────────────────────────────────

describe("span name regex", () => {
  it("matches spans by regex pattern", () => {
    const result = queryTraces(store, { spanNameRegex: /^GET / });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });

  it("regex matches across traces", () => {
    const result = queryTraces(store, { spanNameRegex: /db\.query/ });
    expect(result.traces.length).toBe(2); // A and B both have db.query spans
  });

  it("regex with no match returns empty", () => {
    const result = queryTraces(store, { spanNameRegex: /^NONEXISTENT/ });
    expect(result.traces.length).toBe(0);
  });
});

// ─── Trace-level intrinsics ──────────────────────────────────────────

describe("trace-level intrinsics", () => {
  it("filters by trace duration min", () => {
    const result = queryTraces(store, {
      traceFilter: { minDurationNanos: 100_000_000n },
    });
    // Only Trace B has duration >= 100ms (200ms)
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("filters by trace duration max", () => {
    const result = queryTraces(store, {
      traceFilter: { maxDurationNanos: 10_000_000n },
    });
    // Trace C has 1ms duration
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_C);
  });

  it("filters by root span name (exact)", () => {
    const result = queryTraces(store, {
      traceFilter: { rootSpanName: "POST /api/orders" },
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("filters by root span name (regex)", () => {
    const result = queryTraces(store, {
      traceFilter: { rootSpanName: /^GET/ },
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });

  it("filters by min span count", () => {
    const result = queryTraces(store, {
      traceFilter: { minSpanCount: 2 },
    });
    // A has 3 spans, B has 2 spans, C has 1 span
    expect(result.traces.length).toBe(2);
  });

  it("combines trace intrinsics with span predicates", () => {
    const result = queryTraces(store, {
      statusCode: StatusCode.ERROR,
      traceFilter: { minDurationNanos: 100_000_000n },
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });
});

// ─── Sort and pagination ─────────────────────────────────────────────

describe("sort and pagination", () => {
  it("sorts by startTime desc (default)", () => {
    const result = queryTraces(store, {});
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_C); // latest start time
    expect(result.traces[2]!.traceId).toStrictEqual(TRACE_A); // earliest
  });

  it("sorts by startTime asc", () => {
    const result = queryTraces(store, { sortBy: "startTime", sortOrder: "asc" });
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
    expect(result.traces[2]!.traceId).toStrictEqual(TRACE_C);
  });

  it("sorts by duration desc", () => {
    const result = queryTraces(store, { sortBy: "duration", sortOrder: "desc" });
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B); // 200ms
    expect(result.traces[2]!.traceId).toStrictEqual(TRACE_C); // 1ms
  });

  it("sorts by spanCount desc", () => {
    const result = queryTraces(store, { sortBy: "spanCount", sortOrder: "desc" });
    expect(result.traces[0]!.spans.length).toBe(3); // Trace A
    expect(result.traces[2]!.spans.length).toBe(1); // Trace C
  });

  it("applies offset", () => {
    const result = queryTraces(store, { offset: 1 });
    expect(result.traces.length).toBe(2);
    expect(result.totalTraces).toBe(3);
  });

  it("applies limit after offset", () => {
    const result = queryTraces(store, { offset: 1, limit: 1 });
    expect(result.traces.length).toBe(1);
    expect(result.totalTraces).toBe(3);
  });

  it("includes queryTimeMs", () => {
    const result = queryTraces(store, {});
    expect(result.queryTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("includes totalTraces", () => {
    const result = queryTraces(store, { limit: 1 });
    expect(result.totalTraces).toBe(3);
    expect(result.traces.length).toBe(1);
  });
});

// ─── Fluent query builder ────────────────────────────────────────────

describe("TraceQuery builder", () => {
  it("basic service + status query", () => {
    const result = TraceQuery.where().service("test-svc").status("error").exec(store);
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("span name with regex", () => {
    const result = TraceQuery.where().spanName(/^GET/).exec(store);
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });

  it("attribute predicate via builder", () => {
    const result = TraceQuery.where().attribute("http.status_code", "gte", 400).exec(store);
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("hasAttribute shorthand", () => {
    const result = TraceQuery.where().hasAttribute("messaging.system").exec(store);
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_C);
  });

  it("missingAttribute shorthand", () => {
    const result = TraceQuery.where().missingAttribute("http.method").exec(store);
    // Spans without http.method: cache.lookup (A), db.query INSERT (B), kafka.consume (C)
    expect(result.traces.length).toBe(3);
  });

  it("duration filter", () => {
    const result = TraceQuery.where().duration({ min: 100_000_000n }).exec(store);
    // Only B has spans with 180ms and 200ms duration
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("trace duration filter", () => {
    const result = TraceQuery.where().traceDuration({ min: 100_000_000n }).exec(store);
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("rootSpanName filter", () => {
    const result = TraceQuery.where().rootSpanName("kafka.consume").exec(store);
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_C);
  });

  it("sort and limit", () => {
    const result = TraceQuery.where().sortBy("duration", "desc").limit(1).exec(store);
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B); // longest
    expect(result.totalTraces).toBe(3);
  });

  it("offset pagination", () => {
    const page1 = TraceQuery.where().sortBy("startTime", "asc").limit(2).exec(store);
    const page2 = TraceQuery.where().sortBy("startTime", "asc").offset(2).limit(2).exec(store);
    expect(page1.traces.length).toBe(2);
    expect(page2.traces.length).toBe(1);
    expect(page1.totalTraces).toBe(3);
    expect(page2.totalTraces).toBe(3);
  });

  it("kind filter with string", () => {
    const result = TraceQuery.where().kind("consumer").exec(store);
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_C);
  });

  it("build() returns opts object", () => {
    const opts = TraceQuery.where().service("frontend").status("error").limit(10).build();
    expect(opts.serviceName).toBe("frontend");
    expect(opts.statusCode).toBe(StatusCode.ERROR);
    expect(opts.limit).toBe(10);
  });

  it("chaining produces correct complex query", () => {
    const opts = TraceQuery.where()
      .service("frontend")
      .spanName(/POST.*/)
      .duration({ min: 100_000_000n })
      .attribute("http.status_code", "gte", 400)
      .hasAttribute("error")
      .traceDuration({ min: 5_000_000_000n })
      .rootService("gateway")
      .minSpanCount(3)
      .sortBy("duration", "desc")
      .limit(50)
      .offset(10)
      .build();

    expect(opts.serviceName).toBe("frontend");
    expect(opts.spanNameRegex).toEqual(/POST.*/);
    expect(opts.minDurationNanos).toBe(100_000_000n);
    expect(opts.attributePredicates?.length).toBe(2);
    expect(opts.attributePredicates?.[0]?.op).toBe("gte");
    expect(opts.attributePredicates?.[1]?.op).toBe("exists");
    expect(opts.traceFilter?.minDurationNanos).toBe(5_000_000_000n);
    expect(opts.traceFilter?.rootServiceName).toBe("gateway");
    expect(opts.traceFilter?.minSpanCount).toBe(3);
    expect(opts.sortBy).toBe("duration");
    expect(opts.sortOrder).toBe("desc");
    expect(opts.limit).toBe(50);
    expect(opts.offset).toBe(10);
  });
});

// ─── Two-phase query & rootResource ──────────────────────────────────

describe("two-phase query: trace spanning multiple chunks", () => {
  it("assembles full trace when spans are in different chunks", () => {
    const sharedTraceId = makeId(16);
    const rootSpanId = makeId(8);
    const childSpanId = makeId(8);

    const batch1: SpanRecord[] = [
      span({
        traceId: sharedTraceId,
        spanId: rootSpanId,
        name: "batch1-root",
        durationNanos: 100_000_000n,
        startTimeUnixNano: 1700000000000000000n,
        endTimeUnixNano: 1700000000100000000n,
      }),
    ];
    const batch2: SpanRecord[] = [
      span({
        traceId: sharedTraceId,
        spanId: childSpanId,
        parentSpanId: rootSpanId,
        name: "batch2-child",
        durationNanos: 50_000_000n,
        startTimeUnixNano: 1700000000010000000n,
        endTimeUnixNano: 1700000000060000000n,
      }),
    ];

    // Use small chunkSize to force separate chunks
    const multiChunkStore = new TraceStore({ chunkSize: 1 });
    const resource = { attributes: [{ key: "service.name", value: "test-svc" }] };
    const scope = { name: "test", version: "1.0" };

    multiChunkStore.append(resource, scope, batch1);
    multiChunkStore.flush();
    multiChunkStore.append(resource, scope, batch2);
    multiChunkStore.flush();

    // Query with spanName filter matching only batch2
    const result = queryTraces(multiChunkStore, { spanNameRegex: /batch2/ });
    expect(result.traces.length).toBe(1);
    // Both spans should be assembled into the trace
    expect(result.traces[0]!.spans.length).toBe(2);
  });
});

describe("rootResource on assembled trace", () => {
  it("populated rootResource on assembled trace", () => {
    const result = queryTraces(store, { traceId: TRACE_A });
    expect(result.traces[0]?.rootResource).toBeDefined();
    expect(result.traces[0]?.rootResource?.attributes).toBeDefined();
  });
});

// ─── Backward compatibility ──────────────────────────────────────────

describe("backward compatibility", () => {
  it("old attributes field still works", () => {
    const result = queryTraces(store, {
      attributes: [{ key: "http.method", value: "GET" }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });

  it("old and new attribute formats can combine", () => {
    const result = queryTraces(store, {
      attributes: [{ key: "http.method", value: "POST" }],
      attributePredicates: [{ key: "http.status_code", op: "gte", value: 500 }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_B);
  });

  it("trace_id fast path still works", () => {
    const result = queryTraces(store, { traceId: TRACE_A });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.spans.length).toBe(3);
  });

  it("fast path not used when other filters present", () => {
    // Use ERROR status which doesn't match TRACE_A spans (they're OK)
    // This forces the general path and verifies the filter is actually applied
    const result = queryTraces(store, {
      traceId: TRACE_A,
      statusCode: StatusCode.ERROR,
    });
    expect(result.traces.length).toBe(0);
  });
});
