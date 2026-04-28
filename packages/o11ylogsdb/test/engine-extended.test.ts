import { describe, it, expect } from "vitest";
import { LogStore } from "../src/engine.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import type { LogRecord, Resource, InstrumentationScope } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "service", value: "test" }] };
const scope: InstrumentationScope = { name: "test-scope" };

function rec(i: number, sev = 9): LogRecord {
  return {
    timeUnixNano: BigInt(1000000000 + i),
    severityNumber: sev,
    severityText: "INFO",
    body: `log line ${i}`,
    attributes: [{ key: "index", value: i }],
  };
}

describe("LogStore flush edge cases", () => {
  it("flush() on empty store is a no-op", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    store.flush();
    expect(store.stats().chunks).toBe(0);
    expect(store.stats().totalLogs).toBe(0);
  });

  it("double flush does not double-count", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    for (let i = 0; i < 5; i++) store.append(resource, scope, rec(i));
    store.flush();
    const s1 = store.stats();
    store.flush(); // second flush should be no-op
    const s2 = store.stats();
    expect(s1.chunks).toBe(s2.chunks);
    expect(s1.totalLogs).toBe(s2.totalLogs);
    expect(s1.totalChunkBytes).toBe(s2.totalChunkBytes);
  });

  it("append after flush creates new chunk", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    for (let i = 0; i < 5; i++) store.append(resource, scope, rec(i));
    store.flush();
    expect(store.stats().chunks).toBe(1);

    // Append more records after flush
    for (let i = 100; i < 103; i++) store.append(resource, scope, rec(i));
    store.flush();
    expect(store.stats().chunks).toBe(2);
    expect(store.stats().totalLogs).toBe(8);
  });

  it("unflushed records are not in stats", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    for (let i = 0; i < 5; i++) store.append(resource, scope, rec(i));
    // No flush — records are in-flight
    expect(store.stats().chunks).toBe(0);
    expect(store.stats().totalLogs).toBe(0);
  });

  it("chunksClosed counter increments correctly across auto-freeze and manual flush", () => {
    const store = new LogStore({ rowsPerChunk: 4 });
    // First 4 records auto-freeze a chunk
    let lastStats;
    for (let i = 0; i < 4; i++) lastStats = store.append(resource, scope, rec(i));
    expect(lastStats!.chunksClosed).toBe(1);

    // Next 2 records are in-flight
    store.append(resource, scope, rec(10));
    store.append(resource, scope, rec(11));
    store.flush(); // closes second chunk

    expect(store.stats().chunks).toBe(2);
    expect(store.stats().totalLogs).toBe(6);
  });
});

describe("LogStore iterRecords edge cases", () => {
  it("iterRecords on empty store yields nothing", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    const results = [...store.iterRecords()];
    expect(results).toHaveLength(0);
  });

  it("iterRecords yields correct streamId", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    const r1: Resource = { attributes: [{ key: "svc", value: "a" }] };
    const r2: Resource = { attributes: [{ key: "svc", value: "b" }] };
    store.append(r1, scope, rec(0));
    store.append(r2, scope, rec(1));
    store.flush();

    const results = [...store.iterRecords()];
    expect(results).toHaveLength(2);
    // Different resources → different stream IDs
    expect(results[0]!.streamId).not.toBe(results[1]!.streamId);
  });

  it("iterRecords with multiple chunks from same stream", () => {
    const store = new LogStore({ rowsPerChunk: 4 });
    for (let i = 0; i < 10; i++) store.append(resource, scope, rec(i));
    store.flush();

    const results = [...store.iterRecords()];
    // 10 records → 2 full chunks (4 each) + 1 partial (2)
    expect(results).toHaveLength(3);
    expect(results[0]!.records).toHaveLength(4);
    expect(results[1]!.records).toHaveLength(4);
    expect(results[2]!.records).toHaveLength(2);
    // All same streamId
    expect(results[0]!.streamId).toBe(results[1]!.streamId);
    expect(results[1]!.streamId).toBe(results[2]!.streamId);
  });
});

describe("LogStore rowsPerChunk extremes", () => {
  it("rowsPerChunk=1 creates a chunk per record", () => {
    const store = new LogStore({ rowsPerChunk: 1 });
    store.append(resource, scope, rec(0));
    store.append(resource, scope, rec(1));
    store.append(resource, scope, rec(2));
    // Each append auto-freezes, no flush needed
    expect(store.stats().chunks).toBe(3);
    expect(store.stats().totalLogs).toBe(3);
  });

  it("very large rowsPerChunk keeps all in-flight", () => {
    const store = new LogStore({ rowsPerChunk: 100000 });
    for (let i = 0; i < 100; i++) store.append(resource, scope, rec(i));
    // All in-flight, no auto-freeze
    expect(store.stats().chunks).toBe(0);
    store.flush();
    expect(store.stats().chunks).toBe(1);
    expect(store.stats().totalLogs).toBe(100);
  });
});

describe("LogStore with TypedColumnarDrainPolicy", () => {
  it("uses typed columnar policy via policyFactory", () => {
    const store = new LogStore({
      rowsPerChunk: 8,
      policyFactory: () => new TypedColumnarDrainPolicy(),
    });
    for (let i = 0; i < 10; i++) store.append(resource, scope, rec(i));
    store.flush();

    const results = [...store.iterRecords()];
    const allRecords = results.flatMap((r) => r.records);
    expect(allRecords).toHaveLength(10);
    // Verify round-trip correctness
    expect(allRecords[0]!.body).toBe("log line 0");
    expect(allRecords[9]!.body).toBe("log line 9");
    expect(Number(allRecords[5]!.timeUnixNano)).toBe(1000000005);
  });
});
