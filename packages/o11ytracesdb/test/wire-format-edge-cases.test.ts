import { describe, expect, it } from "vitest";
import { ChunkBuilder, deserializeChunk, serializeChunk } from "../src/chunk.js";
import { ColumnarTracePolicy } from "../src/codec-columnar.js";
import { TraceStore } from "../src/engine.js";
import { buildSpanTree, queryTraces } from "../src/query.js";
import type { SpanRecord } from "../src/types.js";
import { SpanKind, StatusCode } from "../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

function makeSpan(overrides: Partial<SpanRecord> = {}): SpanRecord {
  const start = 1700000000000000000n;
  return {
    traceId: randomBytes(16),
    spanId: randomBytes(8),
    name: "test-op",
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

// ─── Wire format tests ───────────────────────────────────────────────

describe("Chunk wire format (serialize/deserialize)", () => {
  const policy = new ColumnarTracePolicy();

  it("round-trips chunk through wire format", () => {
    const builder = new ChunkBuilder(policy, 128);
    const spans = Array.from({ length: 10 }, () => makeSpan());
    for (const s of spans) builder.append(s);
    const chunk = builder.flush()!;

    const wire = serializeChunk(chunk);
    const decoded = deserializeChunk(wire);

    expect(decoded.header.nSpans).toBe(chunk.header.nSpans);
    expect(decoded.header.codecName).toBe("columnar-v1");
    expect(decoded.header.hasError).toBe(false);
    expect(decoded.payload.length).toBe(chunk.payload.length);

    // Verify payload decodes correctly
    const decodedSpans = policy.decodePayload(
      decoded.payload,
      decoded.header.nSpans,
      decoded.header.codecMeta
    );
    expect(decodedSpans.length).toBe(10);
  });

  it("validates magic bytes", () => {
    const bad = new Uint8Array(20);
    bad[0] = 0x00; // wrong magic
    expect(() => deserializeChunk(bad)).toThrow("invalid chunk magic");
  });

  it("validates minimum size", () => {
    expect(() => deserializeChunk(new Uint8Array(5))).toThrow("chunk too small");
  });

  it("validates schema version", () => {
    const buf = new Uint8Array(20);
    buf[0] = 0x4f;
    buf[1] = 0x54;
    buf[2] = 0x44;
    buf[3] = 0x42; // OTDB
    buf[4] = 99; // bad version
    expect(() => deserializeChunk(buf)).toThrow("unsupported chunk version");
  });

  it("handles chunk with error spans", () => {
    const builder = new ChunkBuilder(policy, 128);
    builder.append(makeSpan({ statusCode: StatusCode.ERROR, statusMessage: "fail" }));
    builder.append(makeSpan());
    const chunk = builder.flush()!;

    expect(chunk.header.hasError).toBe(true);

    const wire = serializeChunk(chunk);
    const decoded = deserializeChunk(wire);
    expect(decoded.header.hasError).toBe(true);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────

describe("Edge cases", () => {
  const policy = new ColumnarTracePolicy();

  it("handles single span (minimal chunk)", () => {
    const span = makeSpan();
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);
    expect(decoded[0]!.name).toBe("test-op");
  });

  it("handles span with empty name", () => {
    const span = makeSpan({ name: "" });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);
    expect(decoded[0]!.name).toBe("");
  });

  it("handles span with very long attribute values", () => {
    const longValue = "x".repeat(10000);
    const span = makeSpan({
      attributes: [{ key: "long-attr", value: longValue }],
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);
    expect(decoded[0]!.attributes[0]!.value).toBe(longValue);
  });

  it("handles span with null attribute values", () => {
    const span = makeSpan({
      attributes: [{ key: "nullable", value: null }],
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);
    expect(decoded[0]!.attributes[0]!.value).toBeNull();
  });

  it("handles span with Uint8Array attribute values", () => {
    const bytes = randomBytes(32);
    const span = makeSpan({
      attributes: [{ key: "binary-data", value: bytes }],
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);
    expect(decoded[0]!.attributes[0]!.value).toEqual(bytes);
  });

  it("handles span with nested array/map attributes", () => {
    const span = makeSpan({
      attributes: [
        { key: "nested-array", value: ["a", "b", "c"] },
        { key: "nested-map", value: { x: 1n, y: "hello" } },
      ],
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);
    expect(decoded[0]!.attributes[0]!.value).toEqual(["a", "b", "c"]);
    expect(decoded[0]!.attributes[1]!.value).toEqual({ x: 1n, y: "hello" });
  });

  it("handles negative and zero duration spans", () => {
    const start = 1700000000000000000n;
    const span = makeSpan({
      startTimeUnixNano: start,
      endTimeUnixNano: start,
      durationNanos: 0n,
    });
    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);
    expect(decoded[0]!.durationNanos).toBe(0n);
  });

  it("handles all SpanKind values", () => {
    const spans = [0, 1, 2, 3, 4, 5].map((kind) => makeSpan({ kind: kind as SpanRecord["kind"] }));
    const { payload, meta } = policy.encodePayload(spans);
    const decoded = policy.decodePayload(payload, spans.length, meta);
    for (let i = 0; i < spans.length; i++) {
      expect(decoded[i]!.kind).toBe(i);
    }
  });

  it("handles all StatusCode values", () => {
    const spans = [
      makeSpan({ statusCode: StatusCode.UNSET }),
      makeSpan({ statusCode: StatusCode.OK }),
      makeSpan({ statusCode: StatusCode.ERROR, statusMessage: "oops" }),
    ];
    const { payload, meta } = policy.encodePayload(spans);
    const decoded = policy.decodePayload(payload, spans.length, meta);
    expect(decoded[0]!.statusCode).toBe(StatusCode.UNSET);
    expect(decoded[1]!.statusCode).toBe(StatusCode.OK);
    expect(decoded[2]!.statusCode).toBe(StatusCode.ERROR);
    expect(decoded[2]!.statusMessage).toBe("oops");
  });
});

// ─── Query correctness tests ─────────────────────────────────────────

describe("Query correctness", () => {
  it("returns complete traces (all spans) even when filter matches subset", () => {
    const store = new TraceStore({ chunkSize: 64 });
    const resource = { attributes: [{ key: "service.name", value: "svc" }] };
    const scope = { name: "test", version: "1.0.0" };

    const traceId = randomBytes(16);
    const rootId = randomBytes(8);
    const base = 1700000000000000000n;
    const spans: SpanRecord[] = [
      makeSpan({
        traceId,
        spanId: rootId,
        name: "root",
        startTimeUnixNano: base,
        endTimeUnixNano: base + 100n,
        durationNanos: 100n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "child-a",
        startTimeUnixNano: base + 10n,
        endTimeUnixNano: base + 50n,
        durationNanos: 40n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "child-b",
        startTimeUnixNano: base + 20n,
        endTimeUnixNano: base + 80n,
        durationNanos: 60n,
      }),
    ];

    store.append(resource, scope, spans);
    store.flush();

    // Filter matches only "child-a", but result should contain ALL spans
    const result = queryTraces(store, { spanName: "child-a" });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.spans.length).toBe(3); // Complete trace!
  });

  it("prunes chunks by time range", () => {
    const store = new TraceStore({ chunkSize: 4 });
    const resource = { attributes: [{ key: "service.name", value: "svc" }] };
    const scope = { name: "test", version: "1.0.0" };

    const oldBase = 1600000000000000000n;
    const newBase = 1700000000000000000n;

    // Old spans (will be in their own chunk)
    const oldSpans = Array.from({ length: 4 }, (_, i) =>
      makeSpan({
        traceId: randomBytes(16),
        startTimeUnixNano: oldBase + BigInt(i),
        endTimeUnixNano: oldBase + BigInt(i) + 10n,
        durationNanos: 10n,
      })
    );
    // New spans (will be in their own chunk)
    const newSpans = Array.from({ length: 4 }, (_, i) =>
      makeSpan({
        traceId: randomBytes(16),
        startTimeUnixNano: newBase + BigInt(i),
        endTimeUnixNano: newBase + BigInt(i) + 10n,
        durationNanos: 10n,
      })
    );

    store.append(resource, scope, oldSpans);
    store.append(resource, scope, newSpans);
    store.flush();

    const result = queryTraces(store, {
      startTimeNano: newBase - 1n,
      endTimeNano: newBase + 100n,
    });

    // Should prune the old chunk
    expect(result.chunksPruned).toBeGreaterThan(0);
    expect(result.traces.length).toBe(4); // All new traces found
  });

  it("filters by min/max duration", () => {
    const store = new TraceStore({ chunkSize: 64 });
    const resource = { attributes: [{ key: "service.name", value: "svc" }] };
    const scope = { name: "test", version: "1.0.0" };

    const base = 1700000000000000000n;
    const spans = [
      makeSpan({
        traceId: randomBytes(16),
        name: "fast",
        durationNanos: 10n,
        startTimeUnixNano: base,
        endTimeUnixNano: base + 10n,
      }),
      makeSpan({
        traceId: randomBytes(16),
        name: "slow",
        durationNanos: 1000n,
        startTimeUnixNano: base,
        endTimeUnixNano: base + 1000n,
      }),
    ];

    store.append(resource, scope, spans);
    store.flush();

    const result = queryTraces(store, { minDurationNanos: 500n });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.spans[0]!.name).toBe("slow");
  });
});

// ─── Self-time correctness ──────────────────────────────────────────

describe("Self-time computation", () => {
  it("computes self-time correctly with non-overlapping children", () => {
    const traceId = randomBytes(16);
    const rootId = randomBytes(8);
    const base = 1700000000000000000n;

    const spans: SpanRecord[] = [
      makeSpan({
        traceId,
        spanId: rootId,
        name: "root",
        startTimeUnixNano: base,
        endTimeUnixNano: base + 100n,
        durationNanos: 100n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "a",
        startTimeUnixNano: base + 10n,
        endTimeUnixNano: base + 30n,
        durationNanos: 20n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "b",
        startTimeUnixNano: base + 50n,
        endTimeUnixNano: base + 70n,
        durationNanos: 20n,
      }),
    ];

    const roots = buildSpanTree(spans);
    // Root self-time = 100 - (20 + 20) = 60
    expect(roots[0]!.selfTimeNanos).toBe(60n);
  });

  it("computes self-time correctly with overlapping children", () => {
    const traceId = randomBytes(16);
    const rootId = randomBytes(8);
    const base = 1700000000000000000n;

    const spans: SpanRecord[] = [
      makeSpan({
        traceId,
        spanId: rootId,
        name: "root",
        startTimeUnixNano: base,
        endTimeUnixNano: base + 100n,
        durationNanos: 100n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "a",
        startTimeUnixNano: base + 10n,
        endTimeUnixNano: base + 60n,
        durationNanos: 50n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "b",
        startTimeUnixNano: base + 40n,
        endTimeUnixNano: base + 80n,
        durationNanos: 40n,
      }),
    ];

    const roots = buildSpanTree(spans);
    // Merged child coverage: [10..80] = 70ns (not 50+40=90!)
    // Root self-time = 100 - 70 = 30
    expect(roots[0]!.selfTimeNanos).toBe(30n);
  });

  it("computes self-time correctly with fully contained children", () => {
    const traceId = randomBytes(16);
    const rootId = randomBytes(8);
    const base = 1700000000000000000n;

    const spans: SpanRecord[] = [
      makeSpan({
        traceId,
        spanId: rootId,
        name: "root",
        startTimeUnixNano: base,
        endTimeUnixNano: base + 100n,
        durationNanos: 100n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "outer",
        startTimeUnixNano: base + 10n,
        endTimeUnixNano: base + 90n,
        durationNanos: 80n,
      }),
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        parentSpanId: rootId,
        name: "inner",
        startTimeUnixNano: base + 20n,
        endTimeUnixNano: base + 50n,
        durationNanos: 30n,
      }),
    ];

    const roots = buildSpanTree(spans);
    // Merged child coverage: [10..90] = 80ns (inner is fully contained in outer)
    // Root self-time = 100 - 80 = 20
    expect(roots[0]!.selfTimeNanos).toBe(20n);
  });
});
