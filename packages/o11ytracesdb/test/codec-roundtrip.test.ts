import { describe, expect, it } from "vitest";
import { ChunkBuilder } from "../src/chunk.js";
import { ColumnarTracePolicy } from "../src/codec-columnar.js";
import { TraceStore } from "../src/engine.js";
import { buildSpanTree, criticalPath, queryTraces } from "../src/query.js";
import type { SpanRecord } from "../src/types.js";
import { SpanKind, StatusCode } from "../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

function makeSpan(overrides: Partial<SpanRecord> = {}): SpanRecord {
  const start = BigInt(Date.now()) * 1_000_000n;
  return {
    traceId: randomBytes(16),
    spanId: randomBytes(8),
    name: "test-operation",
    kind: SpanKind.SERVER,
    startTimeUnixNano: start,
    endTimeUnixNano: start + 50_000_000n,
    durationNanos: 50_000_000n,
    statusCode: StatusCode.OK,
    attributes: [],
    events: [],
    links: [],
    ...overrides,
  };
}

const traceId = randomBytes(16);

function makeTrace(numSpans: number): SpanRecord[] {
  const rootSpanId = randomBytes(8);
  const baseTime = BigInt(Date.now()) * 1_000_000n;
  const root = makeSpan({
    traceId,
    spanId: rootSpanId,
    name: "root-operation",
    startTimeUnixNano: baseTime,
    endTimeUnixNano: baseTime + 200_000_000n,
    durationNanos: 200_000_000n,
  });

  const spans: SpanRecord[] = [root];
  for (let i = 1; i < numSpans; i++) {
    const childStart = baseTime + BigInt(i) * 10_000_000n;
    spans.push(
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootSpanId,
        name: `child-op-${i}`,
        kind: SpanKind.CLIENT,
        startTimeUnixNano: childStart,
        endTimeUnixNano: childStart + 30_000_000n,
        durationNanos: 30_000_000n,
      })
    );
  }
  return spans;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("ColumnarTracePolicy — encode/decode round-trip", () => {
  const policy = new ColumnarTracePolicy();

  it("round-trips a single span", () => {
    const span = makeSpan();
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);

    expect(decoded.length).toBe(1);
    const d = decoded[0]!;
    expect(d.name).toBe(span.name);
    expect(d.kind).toBe(span.kind);
    expect(d.startTimeUnixNano).toBe(span.startTimeUnixNano);
    expect(d.endTimeUnixNano).toBe(span.endTimeUnixNano);
    expect(d.durationNanos).toBe(span.durationNanos);
    expect(d.statusCode).toBe(span.statusCode);
    expect(d.traceId).toEqual(span.traceId);
    expect(d.spanId).toEqual(span.spanId);
    expect(d.parentSpanId).toBeUndefined();
    expect(d.attributes).toEqual([]);
    expect(d.events).toEqual([]);
    expect(d.links).toEqual([]);
  });

  it("round-trips multiple spans with parent relationships", () => {
    const spans = makeTrace(5);
    const { payload, meta } = policy.encodePayload(spans);
    const decoded = policy.decodePayload(payload, spans.length, meta);

    expect(decoded.length).toBe(5);
    for (let i = 0; i < spans.length; i++) {
      const original = spans[i]!;
      const d = decoded[i]!;
      expect(d.traceId).toEqual(original.traceId);
      expect(d.spanId).toEqual(original.spanId);
      expect(d.name).toBe(original.name);
      expect(d.startTimeUnixNano).toBe(original.startTimeUnixNano);
      expect(d.endTimeUnixNano).toBe(original.endTimeUnixNano);
      expect(d.durationNanos).toBe(original.durationNanos);
      if (original.parentSpanId !== undefined) {
        expect(d.parentSpanId).toEqual(original.parentSpanId);
      } else {
        expect(d.parentSpanId).toBeUndefined();
      }
    }
  });

  it("round-trips spans with attributes", () => {
    const span = makeSpan({
      attributes: [
        { key: "http.method", value: "GET" },
        { key: "http.status_code", value: 200n },
        { key: "http.url", value: "https://example.com/api" },
        { key: "error", value: true },
        { key: "latency_ms", value: 42.5 },
        { key: "retry_count", value: 3n },
      ],
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);

    expect(decoded[0]!.attributes).toEqual(span.attributes);
  });

  it("round-trips spans with events", () => {
    const baseTime = BigInt(Date.now()) * 1_000_000n;
    const span = makeSpan({
      events: [
        {
          timeUnixNano: baseTime + 10_000_000n,
          name: "exception",
          attributes: [
            { key: "exception.type", value: "TypeError" },
            { key: "exception.message", value: "Cannot read property 'x' of null" },
          ],
        },
        {
          timeUnixNano: baseTime + 20_000_000n,
          name: "log",
          attributes: [{ key: "message", value: "retrying..." }],
        },
      ],
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);

    expect(decoded[0]!.events.length).toBe(2);
    expect(decoded[0]!.events[0]!.name).toBe("exception");
    expect(decoded[0]!.events[0]!.timeUnixNano).toBe(baseTime + 10_000_000n);
    expect(decoded[0]!.events[0]!.attributes).toEqual(span.events[0]!.attributes);
    expect(decoded[0]!.events[1]!.name).toBe("log");
  });

  it("round-trips spans with links", () => {
    const span = makeSpan({
      links: [
        {
          traceId: randomBytes(16),
          spanId: randomBytes(8),
          attributes: [{ key: "link.type", value: "parent" }],
        },
      ],
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);

    expect(decoded[0]!.links.length).toBe(1);
    expect(decoded[0]!.links[0]!.traceId).toEqual(span.links[0]!.traceId);
    expect(decoded[0]!.links[0]!.spanId).toEqual(span.links[0]!.spanId);
    expect(decoded[0]!.links[0]!.attributes).toEqual(span.links[0]!.attributes);
  });

  it("round-trips error status with message", () => {
    const span = makeSpan({
      statusCode: StatusCode.ERROR,
      statusMessage: "connection timeout",
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);

    expect(decoded[0]!.statusCode).toBe(StatusCode.ERROR);
    expect(decoded[0]!.statusMessage).toBe("connection timeout");
  });

  it("handles dictionary encoding for repeated span names", () => {
    const spans = Array.from({ length: 50 }, (_, i) => makeSpan({ name: `op-${i % 5}` }));
    const { payload, meta } = policy.encodePayload(spans);
    const decoded = policy.decodePayload(payload, spans.length, meta);

    for (let i = 0; i < spans.length; i++) {
      expect(decoded[i]!.name).toBe(spans[i]!.name);
    }
  });

  it("achieves expected compression ratio", () => {
    const spans = makeTrace(100);
    const { payload } = policy.encodePayload(spans);
    const bytesPerSpan = payload.length / spans.length;

    // Should be roughly 50 B/span for typical spans with few attributes
    // IDs alone are 32 bytes, so < 100 B/span is excellent
    expect(bytesPerSpan).toBeLessThan(100);
    // But at minimum we need the IDs (16+8+8 = 32 bytes)
    expect(bytesPerSpan).toBeGreaterThan(30);
  });
});

describe("ChunkBuilder — serialize/deserialize", () => {
  it("builds and flushes a chunk", () => {
    const policy = new ColumnarTracePolicy();
    const builder = new ChunkBuilder(policy, 128);

    const spans = makeTrace(10);
    for (const s of spans) builder.append(s);

    const chunk = builder.flush();
    expect(chunk).not.toBeNull();
    expect(chunk!.header.nSpans).toBe(10);
    expect(BigInt(chunk!.header.minTimeNano)).toBeLessThanOrEqual(
      BigInt(chunk!.header.maxTimeNano)
    );
    expect(chunk!.header.spanNames.length).toBeGreaterThan(0);
  });

  it("tracks isFull correctly", () => {
    const policy = new ColumnarTracePolicy();
    const builder = new ChunkBuilder(policy, 4);

    expect(builder.isFull).toBe(false);
    builder.append(makeSpan());
    builder.append(makeSpan());
    builder.append(makeSpan());
    expect(builder.isFull).toBe(false);
    builder.append(makeSpan());
    expect(builder.isFull).toBe(true);
  });
});

describe("TraceStore — ingest + query", () => {
  it("ingests and queries by trace_id", () => {
    const store = new TraceStore({ chunkSize: 16 });
    const resource = { attributes: [{ key: "service.name", value: "test-svc" }] };
    const scope = { name: "test-scope", version: "1.0.0" };

    const spans = makeTrace(5);
    store.append(resource, scope, spans);
    store.flush();

    const result = queryTraces(store, { traceId });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.spans.length).toBe(5);
  });

  it("ingests and queries by time range", () => {
    const store = new TraceStore({ chunkSize: 16 });
    const resource = { attributes: [{ key: "service.name", value: "test-svc" }] };
    const scope = { name: "test-scope", version: "1.0.0" };

    const now = BigInt(Date.now()) * 1_000_000n;
    const oldSpan = makeSpan({
      traceId: randomBytes(16),
      startTimeUnixNano: now - 1_000_000_000_000n,
      endTimeUnixNano: now - 999_000_000_000n,
      durationNanos: 1_000_000_000n,
    });
    const newSpan = makeSpan({
      traceId: randomBytes(16),
      startTimeUnixNano: now,
      endTimeUnixNano: now + 50_000_000n,
      durationNanos: 50_000_000n,
    });

    store.append(resource, scope, [oldSpan, newSpan]);
    store.flush();

    const result = queryTraces(store, {
      startTimeNano: now - 100_000_000n,
      endTimeNano: now + 100_000_000n,
    });

    // Should find the new span's trace
    const traceIds = result.traces.map((t) =>
      Array.from(t.traceId)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
    const newTraceHex = Array.from(newSpan.traceId)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(traceIds).toContain(newTraceHex);
  });

  it("reports accurate stats", () => {
    const store = new TraceStore({ chunkSize: 8 });
    const resource = { attributes: [{ key: "service.name", value: "my-svc" }] };
    const scope = { name: "my-scope", version: "1.0.0" };

    store.append(resource, scope, makeTrace(10));
    store.flush();

    const stats = store.stats();
    expect(stats.streams).toBe(1);
    expect(stats.sealedSpans).toBe(10);
    expect(stats.chunks).toBeGreaterThanOrEqual(1);
    expect(stats.payloadBytes).toBeGreaterThan(0);
    expect(stats.hotSpans).toBe(0);
  });
});

describe("buildSpanTree + criticalPath", () => {
  it("builds a tree from parent-child relationships", () => {
    const rootId = randomBytes(8);
    const childAId = randomBytes(8);
    const childBId = randomBytes(8);
    const base = BigInt(Date.now()) * 1_000_000n;

    const spans: SpanRecord[] = [
      makeSpan({
        traceId,
        spanId: rootId,
        name: "root",
        startTimeUnixNano: base,
        endTimeUnixNano: base + 100_000_000n,
        durationNanos: 100_000_000n,
      }),
      makeSpan({
        traceId,
        spanId: childAId,
        parentSpanId: rootId,
        name: "child-a",
        startTimeUnixNano: base + 10_000_000n,
        endTimeUnixNano: base + 60_000_000n,
        durationNanos: 50_000_000n,
      }),
      makeSpan({
        traceId,
        spanId: childBId,
        parentSpanId: rootId,
        name: "child-b",
        startTimeUnixNano: base + 20_000_000n,
        endTimeUnixNano: base + 90_000_000n,
        durationNanos: 70_000_000n,
      }),
    ];

    const roots = buildSpanTree(spans);
    expect(roots.length).toBe(1);
    expect(roots[0]!.span.name).toBe("root");
    expect(roots[0]!.children.length).toBe(2);
  });

  it("computes critical path (follows latest-ending child)", () => {
    const rootId = randomBytes(8);
    const base = BigInt(Date.now()) * 1_000_000n;

    const spans: SpanRecord[] = [
      makeSpan({
        traceId,
        spanId: rootId,
        name: "root",
        startTimeUnixNano: base,
        endTimeUnixNano: base + 100_000_000n,
        durationNanos: 100_000_000n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "fast-child",
        startTimeUnixNano: base + 5_000_000n,
        endTimeUnixNano: base + 30_000_000n,
        durationNanos: 25_000_000n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "slow-child",
        startTimeUnixNano: base + 5_000_000n,
        endTimeUnixNano: base + 95_000_000n,
        durationNanos: 90_000_000n,
      }),
    ];

    const roots = buildSpanTree(spans);
    const path = criticalPath(roots);

    expect(path.length).toBe(2);
    expect(path[0]!.span.name).toBe("root");
    expect(path[1]!.span.name).toBe("slow-child");
  });
});
