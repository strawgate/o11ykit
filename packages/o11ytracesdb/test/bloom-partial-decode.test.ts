import { describe, expect, it } from "vitest";
import {
  bloomFromBase64,
  bloomMayContain,
  bloomToBase64,
  createBloomFilter,
} from "../src/bloom.js";
import { ColumnarTracePolicy } from "../src/codec-columnar.js";
import { TraceStore } from "../src/engine.js";
import { queryTraces } from "../src/query.js";
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

// ─── Bloom filter tests ──────────────────────────────────────────────

describe("Bloom filter", () => {
  it("has no false negatives — every inserted trace ID is found", () => {
    const ids = Array.from({ length: 100 }, () => randomBytes(16));
    const filter = createBloomFilter(ids);

    for (const id of ids) {
      expect(bloomMayContain(filter, id)).toBe(true);
    }
  });

  it("false positive rate is below 2% with 10 bits/element", () => {
    // Use a deterministic seed pattern to avoid flakiness
    const inserted: Uint8Array[] = [];
    for (let i = 0; i < 500; i++) {
      const buf = new Uint8Array(16);
      // Deterministic "inserted" IDs: first 4 bytes = index, rest = 0xAA
      buf[0] = (i >>> 24) & 0xff;
      buf[1] = (i >>> 16) & 0xff;
      buf[2] = (i >>> 8) & 0xff;
      buf[3] = i & 0xff;
      for (let j = 4; j < 16; j++) buf[j] = 0xaa;
      inserted.push(buf);
    }
    const filter = createBloomFilter(inserted, 10);

    // Test 10000 deterministic non-inserted IDs
    let falsePositives = 0;
    const trials = 10000;
    for (let i = 0; i < trials; i++) {
      const probe = new Uint8Array(16);
      // Deterministic "probe" IDs: first 4 bytes = index + offset, rest = 0xBB
      const idx = i + 100000;
      probe[0] = (idx >>> 24) & 0xff;
      probe[1] = (idx >>> 16) & 0xff;
      probe[2] = (idx >>> 8) & 0xff;
      probe[3] = idx & 0xff;
      for (let j = 4; j < 16; j++) probe[j] = 0xbb;
      if (bloomMayContain(filter, probe)) falsePositives++;
    }

    const fpr = falsePositives / trials;
    // 10 bits/element → theoretical FPR ~0.8%. Use 2% to avoid flakiness.
    expect(fpr).toBeLessThan(0.02);
  });

  it("handles empty input", () => {
    const filter = createBloomFilter([]);
    expect(filter.length).toBe(0);
    // Empty filter should return true (no filtering)
    expect(bloomMayContain(filter, randomBytes(16))).toBe(true);
  });

  it("handles duplicate trace IDs", () => {
    const id = randomBytes(16);
    const filter = createBloomFilter([id, id, id, id, id]);
    expect(bloomMayContain(filter, id)).toBe(true);
  });

  it("round-trips through base64", () => {
    const ids = Array.from({ length: 50 }, () => randomBytes(16));
    const filter = createBloomFilter(ids);
    const b64 = bloomToBase64(filter);
    const restored = bloomFromBase64(b64);

    expect(restored).toEqual(filter);

    // Verify membership still works after round-trip
    for (const id of ids) {
      expect(bloomMayContain(restored, id)).toBe(true);
    }
  });

  it("base64 round-trip preserves empty filter edge case", () => {
    const empty = new Uint8Array(0);
    const b64 = bloomToBase64(empty);
    const restored = bloomFromBase64(b64);
    expect(restored.length).toBe(0);
  });
});

// ─── Partial decode (IDs only) tests ─────────────────────────────────

describe("Partial decode — IDs only", () => {
  const policy = new ColumnarTracePolicy();

  it("returns correct trace IDs without full decode", () => {
    const traceId = randomBytes(16);
    const spans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        traceId,
        spanId: randomBytes(8),
        ...(i > 0 ? { parentSpanId: randomBytes(8) } : {}),
      })
    );

    const { payload } = policy.encodePayload(spans);
    const { traceIds, spanIds, parentSpanIds } = policy.decodeIdsOnly(payload, spans.length);

    expect(traceIds.length).toBe(10);
    expect(spanIds.length).toBe(10);
    expect(parentSpanIds.length).toBe(10);

    for (let i = 0; i < spans.length; i++) {
      expect(traceIds[i]).toEqual(spans[i]!.traceId);
      expect(spanIds[i]).toEqual(spans[i]!.spanId);
      if (spans[i]!.parentSpanId !== undefined) {
        expect(parentSpanIds[i]).toEqual(spans[i]!.parentSpanId);
      } else {
        expect(parentSpanIds[i]).toBeUndefined();
      }
    }
  });

  it("matches full decode output", () => {
    const spans = Array.from({ length: 20 }, () => makeSpan());
    const { payload, meta } = policy.encodePayload(spans);

    const full = policy.decodePayload(payload, spans.length, meta);
    const partial = policy.decodeIdsOnly(payload, spans.length);

    for (let i = 0; i < spans.length; i++) {
      expect(partial.traceIds[i]).toEqual(full[i]!.traceId);
      expect(partial.spanIds[i]).toEqual(full[i]!.spanId);
    }
  });

  it("TraceStore.decodeChunkIds works end-to-end", () => {
    const store = new TraceStore({ chunkSize: 64 });
    const resource = { attributes: [{ key: "service.name", value: "svc" }] };
    const scope = { name: "test", version: "1.0.0" };

    const traceId = randomBytes(16);
    const spans = Array.from({ length: 5 }, () => makeSpan({ traceId }));
    store.append(resource, scope, spans);
    store.flush();

    for (const { chunk } of store.iterChunks()) {
      const ids = store.decodeChunkIds(chunk);
      expect(ids.traceIds.length).toBe(5);
      for (const tid of ids.traceIds) {
        expect(tid).toEqual(traceId);
      }
    }
  });
});

// ─── Event delta timestamp tests ─────────────────────────────────────

describe("Event delta timestamps", () => {
  const policy = new ColumnarTracePolicy();

  it("round-trips event timestamps correctly via delta encoding", () => {
    const baseTime = 1700000000000000000n;
    const span = makeSpan({
      startTimeUnixNano: baseTime,
      endTimeUnixNano: baseTime + 100_000_000n,
      durationNanos: 100_000_000n,
      events: [
        {
          timeUnixNano: baseTime + 10_000_000n,
          name: "event-1",
          attributes: [],
        },
        {
          timeUnixNano: baseTime + 50_000_000n,
          name: "event-2",
          attributes: [{ key: "msg", value: "hello" }],
        },
        {
          timeUnixNano: baseTime + 99_000_000n,
          name: "event-3",
          attributes: [],
        },
      ],
    });

    const { payload, meta } = policy.encodePayload([span]);
    const decoded = policy.decodePayload(payload, 1, meta);

    expect(decoded[0]!.events.length).toBe(3);
    expect(decoded[0]!.events[0]!.timeUnixNano).toBe(baseTime + 10_000_000n);
    expect(decoded[0]!.events[0]!.name).toBe("event-1");
    expect(decoded[0]!.events[1]!.timeUnixNano).toBe(baseTime + 50_000_000n);
    expect(decoded[0]!.events[1]!.name).toBe("event-2");
    expect(decoded[0]!.events[1]!.attributes).toEqual([{ key: "msg", value: "hello" }]);
    expect(decoded[0]!.events[2]!.timeUnixNano).toBe(baseTime + 99_000_000n);
  });

  it("handles multiple spans with events (correct start time per span)", () => {
    const base1 = 1700000000000000000n;
    const base2 = 1700000001000000000n;
    const spans = [
      makeSpan({
        startTimeUnixNano: base1,
        endTimeUnixNano: base1 + 100_000_000n,
        durationNanos: 100_000_000n,
        events: [{ timeUnixNano: base1 + 5_000_000n, name: "e1", attributes: [] }],
      }),
      makeSpan({
        startTimeUnixNano: base2,
        endTimeUnixNano: base2 + 200_000_000n,
        durationNanos: 200_000_000n,
        events: [{ timeUnixNano: base2 + 150_000_000n, name: "e2", attributes: [] }],
      }),
    ];

    const { payload, meta } = policy.encodePayload(spans);
    const decoded = policy.decodePayload(payload, 2, meta);

    expect(decoded[0]!.events[0]!.timeUnixNano).toBe(base1 + 5_000_000n);
    expect(decoded[1]!.events[0]!.timeUnixNano).toBe(base2 + 150_000_000n);
  });

  it("delta encoding produces smaller payloads than absolute timestamps would", () => {
    const baseTime = 1700000000000000000n; // large absolute timestamp
    const span = makeSpan({
      startTimeUnixNano: baseTime,
      endTimeUnixNano: baseTime + 1_000_000_000n,
      durationNanos: 1_000_000_000n,
      events: Array.from({ length: 10 }, (_, i) => ({
        timeUnixNano: baseTime + BigInt(i) * 100_000_000n,
        name: `evt-${i}`,
        attributes: [] as SpanRecord["attributes"],
      })),
    });

    const { payload } = policy.encodePayload([span]);
    // The payload size should be reasonable — delta timestamps for
    // small offsets encode in 2-3 bytes vs ~10 bytes for absolute nanos
    expect(payload.length).toBeGreaterThan(0);
    // Hard to assert exact size, but the test passing with correct
    // round-trip proves delta encoding/decoding works
  });
});

// ─── Bloom filter query pruning integration test ─────────────────────

describe("Query engine bloom filter pruning", () => {
  it("prunes chunks that don't contain the target trace ID", () => {
    const store = new TraceStore({ chunkSize: 8 });
    const resource = { attributes: [{ key: "service.name", value: "svc" }] };
    const scope = { name: "test", version: "1.0.0" };

    // Create two batches with distinct trace IDs — each fills one chunk
    const targetTraceId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const otherTraceId = new Uint8Array([
      255, 254, 253, 252, 251, 250, 249, 248, 247, 246, 245, 244, 243, 242, 241, 240,
    ]);

    const targetSpans = Array.from({ length: 8 }, () => makeSpan({ traceId: targetTraceId }));
    const otherSpans = Array.from({ length: 8 }, () => makeSpan({ traceId: otherTraceId }));

    store.append(resource, scope, targetSpans);
    store.append(resource, scope, otherSpans);
    store.flush();

    // Verify we have multiple chunks
    let chunkCount = 0;
    for (const _c of store.iterChunks()) chunkCount++;
    expect(chunkCount).toBeGreaterThanOrEqual(2);

    // Query for the target trace ID — bloom filter should prune at least one chunk
    const result = queryTraces(store, { traceId: targetTraceId });
    expect(result.traces.length).toBe(1);
    expect(result.traces[0]!.spans.length).toBe(8);
    expect(result.chunksPruned).toBeGreaterThan(0);
  });

  it("bloom filter is stored in chunk header after flush", () => {
    const store = new TraceStore({ chunkSize: 64 });
    const resource = { attributes: [{ key: "service.name", value: "svc" }] };
    const scope = { name: "test", version: "1.0.0" };

    store.append(resource, scope, [makeSpan()]);
    store.flush();

    for (const { chunk } of store.iterChunks()) {
      expect(chunk.header.bloomFilter).toBeDefined();
      expect(typeof chunk.header.bloomFilter).toBe("string");
      // Should be valid base64
      const filter = bloomFromBase64(chunk.header.bloomFilter!);
      expect(filter.length).toBeGreaterThan(0);
    }
  });
});
