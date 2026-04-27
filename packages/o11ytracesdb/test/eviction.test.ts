import { describe, expect, it } from "vitest";
import { TraceStore } from "../src/engine.js";
import type { InstrumentationScope, Resource, SpanRecord } from "../src/types.js";
import { SpanKind, StatusCode } from "../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

const resource: Resource = { attributes: [{ key: "service.name", value: "test-svc" }] };
const scope: InstrumentationScope = { name: "test", version: "1.0" };

function makeSpans(n: number): SpanRecord[] {
  const baseTime = 1700000000000000000n;
  return Array.from({ length: n }, (_, i) => ({
    traceId: randomBytes(16),
    spanId: randomBytes(8),
    name: `op-${i}`,
    kind: SpanKind.SERVER as SpanRecord["kind"],
    startTimeUnixNano: baseTime + BigInt(i) * 1_000_000n,
    endTimeUnixNano: baseTime + BigInt(i + 1) * 1_000_000n,
    durationNanos: 1_000_000n,
    statusCode: StatusCode.OK as SpanRecord["statusCode"],
    attributes: [],
    events: [],
    links: [],
  }));
}

// ─── Eviction Tests ──────────────────────────────────────────────────

describe("TraceStore eviction", () => {
  it("evicts oldest chunks when maxChunks exceeded", () => {
    const store = new TraceStore({ chunkSize: 10, maxChunks: 3 });

    // Insert 50 spans → should create 5 chunks (10 each)
    store.append(resource, scope, makeSpans(50));
    store.flush();

    const stats = store.stats();
    // Only 3 chunks should remain
    expect(stats.chunks).toBe(3);
    expect(stats.sealedSpans).toBe(30); // 3 × 10
    expect(stats.evictedChunks).toBe(2);
    expect(stats.evictedSpans).toBe(20); // 2 × 10
  });

  it("evicts oldest chunks when maxPayloadBytes exceeded", () => {
    // First, measure actual chunk size by encoding one batch
    const measureStore = new TraceStore({ chunkSize: 10 });
    measureStore.append(resource, scope, makeSpans(10));
    measureStore.flush();
    const oneChunkBytes = measureStore.stats().payloadBytes;

    // Set budget to hold ~3 chunks
    const budget = oneChunkBytes * 3 + 100;
    const store = new TraceStore({ chunkSize: 10, maxPayloadBytes: budget });

    // Insert spans in batches to create multiple chunks
    for (let i = 0; i < 10; i++) {
      store.append(resource, scope, makeSpans(10));
    }
    store.flush();

    const stats = store.stats();
    // Total payload should be under the budget
    expect(stats.payloadBytes).toBeLessThanOrEqual(budget);
    expect(stats.evictedChunks).toBeGreaterThan(0);
  });

  it("evicts expired chunks by TTL", async () => {
    const store = new TraceStore({ chunkSize: 10, ttlMs: 50 });

    // Insert first batch
    store.append(resource, scope, makeSpans(10));
    store.flush();

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Insert second batch — should trigger eviction of first
    store.append(resource, scope, makeSpans(10));
    store.flush();

    const stats = store.stats();
    expect(stats.chunks).toBe(1); // only the new chunk remains
    expect(stats.evictedChunks).toBe(1);
    expect(stats.evictedSpans).toBe(10);
  });

  it("TTL eviction occurs on reads", async () => {
    const store = new TraceStore({ chunkSize: 10, ttlMs: 50 });
    store.append(resource, scope, makeSpans(10));
    store.flush();
    expect(store.stats().chunks).toBe(1);

    await new Promise((r) => setTimeout(r, 60));

    // Reading should trigger eviction even without new writes
    const stats = store.stats();
    expect(stats.chunks).toBe(0);
    expect(stats.evictedChunks).toBe(1);
  });

  it("cleans up empty streams after full eviction", () => {
    const store = new TraceStore({ chunkSize: 10, maxChunks: 1 });
    const res1: Resource = { attributes: [{ key: "service.name", value: "svc-a" }] };
    const res2: Resource = { attributes: [{ key: "service.name", value: "svc-b" }] };

    // Create chunk for stream 1
    store.append(res1, scope, makeSpans(10));
    store.flush();
    expect(store.stats().streams).toBe(1);

    // Create chunk for stream 2 — should evict stream 1's only chunk
    store.append(res2, scope, makeSpans(10));
    store.flush();

    // Stream 1 should be cleaned up since all its chunks were evicted
    expect(store.stats().streams).toBe(1);
  });

  it("unlimited store never evicts", () => {
    const store = new TraceStore({ chunkSize: 10 });

    store.append(resource, scope, makeSpans(100));
    store.flush();

    const stats = store.stats();
    expect(stats.chunks).toBe(10);
    expect(stats.sealedSpans).toBe(100);
    expect(stats.evictedChunks).toBe(0);
    expect(stats.evictedSpans).toBe(0);
  });

  it("query still works after eviction", () => {
    const store = new TraceStore({ chunkSize: 10, maxChunks: 2 });

    store.append(resource, scope, makeSpans(30));
    store.flush();

    // Should be able to iterate remaining chunks without error
    let count = 0;
    for (const entry of store.iterChunks()) {
      const spans = store.decodeChunk(entry.chunk);
      count += spans.length;
    }
    expect(count).toBe(20); // 2 chunks × 10 spans
  });
});
