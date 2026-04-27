/**
 * Tests for the aggregation pipeline and structural query operators.
 */
import { describe, it, expect } from "vitest";
import { TraceStore } from "../src/engine.js";
import { queryTraces } from "../src/query.js";
import { TraceQuery } from "../src/query-builder.js";
import { aggregateTraces, aggregateSpans } from "../src/aggregate.js";
import type { SpanRecord } from "../src/types.js";
import { SpanKind, StatusCode } from "../src/types.js";

// ─── Test helpers ────────────────────────────────────────────────────

let idCounter = 100;
function makeId(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  buf[0] = ++idCounter;
  return buf;
}

const TRACE_A = makeId(16);
const TRACE_B = makeId(16);

function span(overrides: Partial<SpanRecord> & { traceId: Uint8Array; name: string }): SpanRecord {
  const start = 1700000000000000000n + BigInt(idCounter) * 10_000_000n;
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

// Build a realistic trace tree:
// Trace A: root → [api-handler → [db-query, cache-lookup], auth-check]
const rootA = span({ traceId: TRACE_A, name: "root-gateway", durationNanos: 100_000_000n,
  startTimeUnixNano: 1700000000000000000n, endTimeUnixNano: 1700000000100000000n,
  kind: SpanKind.SERVER,
  attributes: [{ key: "service.name", value: "gateway" }] });
const apiHandler = span({ traceId: TRACE_A, name: "api-handler", durationNanos: 80_000_000n,
  startTimeUnixNano: 1700000000010000000n, endTimeUnixNano: 1700000000090000000n,
  parentSpanId: rootA.spanId, kind: SpanKind.INTERNAL,
  attributes: [{ key: "service.name", value: "api" }] });
const dbQuery = span({ traceId: TRACE_A, name: "db.query", durationNanos: 30_000_000n,
  startTimeUnixNano: 1700000000020000000n, endTimeUnixNano: 1700000000050000000n,
  parentSpanId: apiHandler.spanId, kind: SpanKind.CLIENT, statusCode: StatusCode.ERROR,
  attributes: [{ key: "db.system", value: "postgresql" }, { key: "service.name", value: "db" }] });
const cacheLookup = span({ traceId: TRACE_A, name: "cache.lookup", durationNanos: 5_000_000n,
  startTimeUnixNano: 1700000000055000000n, endTimeUnixNano: 1700000000060000000n,
  parentSpanId: apiHandler.spanId, kind: SpanKind.CLIENT,
  attributes: [{ key: "cache.hit", value: true }, { key: "service.name", value: "redis" }] });
const authCheck = span({ traceId: TRACE_A, name: "auth-check", durationNanos: 15_000_000n,
  startTimeUnixNano: 1700000000005000000n, endTimeUnixNano: 1700000000020000000n,
  parentSpanId: rootA.spanId, kind: SpanKind.INTERNAL,
  attributes: [{ key: "service.name", value: "auth" }] });

// Trace B: simple 2-span trace
const rootB = span({ traceId: TRACE_B, name: "consumer-root", durationNanos: 50_000_000n,
  startTimeUnixNano: 1700000000200000000n, endTimeUnixNano: 1700000000250000000n,
  kind: SpanKind.CONSUMER,
  attributes: [{ key: "service.name", value: "worker" }] });
const processB = span({ traceId: TRACE_B, name: "process-message", durationNanos: 40_000_000n,
  startTimeUnixNano: 1700000000205000000n, endTimeUnixNano: 1700000000245000000n,
  parentSpanId: rootB.spanId, kind: SpanKind.INTERNAL,
  attributes: [{ key: "service.name", value: "worker" }] });

const allSpans = [rootA, apiHandler, dbQuery, cacheLookup, authCheck, rootB, processB];

function buildStore(): TraceStore {
  const store = new TraceStore({ chunkSize: 256 });
  const resource = { attributes: [{ key: "service.name", value: "test" }] };
  const scope = { name: "test", version: "1.0" };
  store.append(resource, scope, allSpans);
  store.flush();
  return store;
}

const store = buildStore();

// ─── Aggregation on traces ───────────────────────────────────────────

describe("aggregateTraces", () => {
  const result = queryTraces(store, {});
  const traces = result.traces;

  it("count() returns number of traces", () => {
    const agg = aggregateTraces(traces, [{ fn: "count" }]);
    expect(agg.results[0]!.value).toBe(2);
    expect(agg.totalCount).toBe(2);
  });

  it("avg(duration) computes average trace duration", () => {
    const agg = aggregateTraces(traces, [{ fn: "avg", field: "duration" }]);
    // A = 100ms, B = 50ms → avg = 75ms = 75_000_000
    expect(agg.results[0]!.value).toBe(75_000_000);
  });

  it("min/max(duration)", () => {
    const agg = aggregateTraces(traces, [
      { fn: "min", field: "duration" },
      { fn: "max", field: "duration" },
    ]);
    expect(agg.results[0]!.value).toBe(50_000_000); // B
    expect(agg.results[1]!.value).toBe(100_000_000); // A
  });

  it("sum(spanCount)", () => {
    const agg = aggregateTraces(traces, [{ fn: "sum", field: "spanCount" }]);
    expect(agg.results[0]!.value).toBe(7); // 5 + 2
  });

  it("p50/p90/p99(duration)", () => {
    const agg = aggregateTraces(traces, [
      { fn: "p50", field: "duration" },
      { fn: "p90", field: "duration" },
      { fn: "p99", field: "duration" },
    ]);
    // With only 2 values, p50 = min, p90/p99 = max
    expect(agg.results[0]!.value).toBe(50_000_000);
    expect(agg.results[2]!.value).toBe(100_000_000);
  });

  it("multiple aggregations at once", () => {
    const agg = aggregateTraces(traces, [
      { fn: "count" },
      { fn: "avg", field: "duration" },
      { fn: "max", field: "spanCount" },
    ]);
    expect(agg.results.length).toBe(3);
    expect(agg.results[0]!.fn).toBe("count");
    expect(agg.results[1]!.fn).toBe("avg");
    expect(agg.results[2]!.fn).toBe("max");
  });
});

// ─── Aggregation on spans ────────────────────────────────────────────

describe("aggregateSpans", () => {
  it("count() all spans", () => {
    const agg = aggregateSpans(allSpans, [{ fn: "count" }]);
    expect(agg.results[0]!.value).toBe(7);
  });

  it("avg(duration) across all spans", () => {
    const agg = aggregateSpans(allSpans, [{ fn: "avg", field: "duration" }]);
    const expected = (100 + 80 + 30 + 5 + 15 + 50 + 40) * 1_000_000 / 7;
    expect(Math.round(agg.results[0]!.value)).toBe(Math.round(expected));
  });

  it("groupBy name", () => {
    const agg = aggregateSpans(allSpans, [{ fn: "count" }], ["name"]);
    expect(agg.groups.length).toBe(7); // each span has unique name
    expect(agg.groups[0]!.count).toBe(1);
  });

  it("groupBy kind", () => {
    const agg = aggregateSpans(allSpans, [{ fn: "count" }, { fn: "avg", field: "duration" }], ["kind"]);
    const serverGroup = agg.groups.find(g => g.groupKey["kind"] === "SERVER");
    const clientGroup = agg.groups.find(g => g.groupKey["kind"] === "CLIENT");
    const internalGroup = agg.groups.find(g => g.groupKey["kind"] === "INTERNAL");
    expect(serverGroup?.count).toBe(1); // rootA
    expect(clientGroup?.count).toBe(2); // dbQuery + cacheLookup
    expect(internalGroup?.count).toBe(3); // apiHandler + authCheck + processB
  });

  it("groupBy status", () => {
    const agg = aggregateSpans(allSpans, [{ fn: "count" }], ["status"]);
    const errorGroup = agg.groups.find(g => g.groupKey["status"] === "ERROR");
    const okGroup = agg.groups.find(g => g.groupKey["status"] === "OK");
    expect(errorGroup?.count).toBe(1); // dbQuery
    expect(okGroup?.count).toBe(6);
  });

  it("groupBy attribute", () => {
    const agg = aggregateSpans(allSpans, [{ fn: "avg", field: "duration" }], ["service.name"]);
    // Each span has service.name in its attributes
    expect(agg.groups.length).toBeGreaterThan(1);
    const gatewayGroup = agg.groups.find(g => g.groupKey["service.name"] === "gateway");
    expect(gatewayGroup?.count).toBe(1);
  });

  it("groups sorted by count descending", () => {
    const agg = aggregateSpans(allSpans, [{ fn: "count" }], ["kind"]);
    // INTERNAL (3) > CLIENT (2) > SERVER (1) > CONSUMER (1)
    expect(agg.groups[0]!.count).toBeGreaterThanOrEqual(agg.groups[1]!.count);
  });
});

// ─── Structural queries ──────────────────────────────────────────────

describe("structural queries", () => {
  it("descendant: root-gateway >> db.query (error)", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "descendant",
        left: { spanName: "root-gateway" },
        right: { spanName: "db.query" },
      }],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });

  it("descendant: gateway has descendant with error status", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "descendant",
        left: { spanName: "root-gateway" },
        right: { statusCode: StatusCode.ERROR },
      }],
    });
    expect(result.traces.length).toBe(1);
  });

  it("child: api-handler has direct child db.query", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "child",
        left: { spanName: "api-handler" },
        right: { spanName: "db.query" },
      }],
    });
    expect(result.traces.length).toBe(1);
  });

  it("child: root-gateway does NOT have direct child db.query", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "child",
        left: { spanName: "root-gateway" },
        right: { spanName: "db.query" },
      }],
    });
    // db.query is a grandchild, not direct child
    expect(result.traces.length).toBe(0);
  });

  it("sibling: db.query ~ cache.lookup (share parent)", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "sibling",
        left: { spanName: "db.query" },
        right: { spanName: "cache.lookup" },
      }],
    });
    expect(result.traces.length).toBe(1);
  });

  it("sibling: db.query is NOT sibling of auth-check", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "sibling",
        left: { spanName: "db.query" },
        right: { spanName: "auth-check" },
      }],
    });
    // db.query parent = api-handler, auth-check parent = root-gateway
    expect(result.traces.length).toBe(0);
  });

  it("ancestor: db.query has ancestor root-gateway", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "ancestor",
        left: { spanName: "db.query" },
        right: { spanName: "root-gateway" },
      }],
    });
    expect(result.traces.length).toBe(1);
  });

  it("parent: api-handler has direct parent root-gateway", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "parent",
        left: { spanName: "api-handler" },
        right: { spanName: "root-gateway" },
      }],
    });
    expect(result.traces.length).toBe(1);
  });

  it("structural with attribute predicates", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "descendant",
        left: { spanName: "api-handler" },
        right: {
          attributes: [{ key: "db.system", op: "eq", value: "postgresql" }],
        },
      }],
    });
    expect(result.traces.length).toBe(1);
  });

  it("structural with spanNameRegex", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "child",
        left: { spanNameRegex: /api-/ },
        right: { spanNameRegex: /^db\./ },
      }],
    });
    expect(result.traces.length).toBe(1);
  });

  it("structural predicate via builder", () => {
    const result = TraceQuery.where()
      .hasDescendant(
        { spanName: "root-gateway" },
        { statusCode: StatusCode.ERROR },
      )
      .exec(store);
    expect(result.traces.length).toBe(1);
  });

  it("structural via builder: hasChild", () => {
    const result = TraceQuery.where()
      .hasChild(
        { spanName: "api-handler" },
        { spanName: "cache.lookup" },
      )
      .exec(store);
    expect(result.traces.length).toBe(1);
  });

  it("structural via builder: hasSibling", () => {
    const result = TraceQuery.where()
      .hasSibling(
        { spanName: "db.query" },
        { spanName: "cache.lookup" },
      )
      .exec(store);
    expect(result.traces.length).toBe(1);
  });

  it("no match returns empty", () => {
    const result = queryTraces(store, {
      structuralPredicates: [{
        relation: "descendant",
        left: { spanName: "consumer-root" },
        right: { spanName: "db.query" },
      }],
    });
    expect(result.traces.length).toBe(0);
  });

  it("multiple structural predicates are AND-ed", () => {
    const result = queryTraces(store, {
      structuralPredicates: [
        {
          relation: "descendant",
          left: { spanName: "root-gateway" },
          right: { statusCode: StatusCode.ERROR },
        },
        {
          relation: "sibling",
          left: { spanName: "db.query" },
          right: { spanName: "cache.lookup" },
        },
      ],
    });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.traceId).toStrictEqual(TRACE_A);
  });
});
