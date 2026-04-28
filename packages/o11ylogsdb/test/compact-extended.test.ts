import { describe, it, expect } from "vitest";
import { LogStore } from "../src/engine.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import { query } from "../src/query.js";
import { compactChunk } from "../src/compact.js";
import { defaultRegistry } from "stardb";
import { ChunkBuilder, DefaultChunkPolicy, readRecords } from "../src/chunk.js";
import type { LogRecord, Resource, InstrumentationScope } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "svc", value: "test" }] };
const scope: InstrumentationScope = { name: "test" };

function rec(body: unknown, sev = 9, ts = 1000000000n): LogRecord {
  return {
    timeUnixNano: ts,
    severityNumber: sev,
    severityText: "INFO",
    body: body as LogRecord["body"],
    attributes: [{ key: "idx", value: 0 }],
  };
}

describe("compact: codec diversity", () => {
  it("compact from gzip-6 to zstd-19", () => {
    const registry = defaultRegistry();
    const policy = new DefaultChunkPolicy("gzip-6");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    for (let i = 0; i < 16; i++) builder.append(rec(`line ${i}`, 9, BigInt(i)));
    const chunk = builder.freeze();
    expect(chunk.header.codecName).toBe("gzip-6");

    const result = compactChunk(chunk, registry, "zstd-19");
    expect(result.chunk.header.codecName).toBe("zstd-19");
    expect(result.chunk.header.nLogs).toBe(16);

    // Verify records round-trip
    const records = readRecords(result.chunk, registry, policy);
    expect(records).toHaveLength(16);
    expect(records[0]!.body).toBe("line 0");
    expect(records[15]!.body).toBe("line 15");
  });

  it("compact from zstd-19 to zstd-3 (lower compression)", () => {
    const registry = defaultRegistry();
    const policy = new DefaultChunkPolicy("zstd-19");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    for (let i = 0; i < 32; i++) builder.append(rec(`log entry number ${i} with some padding text`, 9, BigInt(i)));
    const chunk = builder.freeze();

    const result = compactChunk(chunk, registry, "zstd-3");
    expect(result.chunk.header.codecName).toBe("zstd-3");

    const records = readRecords(result.chunk, registry, policy);
    expect(records).toHaveLength(32);
    expect(records[0]!.body).toBe("log entry number 0 with some padding text");
  });

  it("compact preserves non-string bodies (kvlist)", () => {
    const registry = defaultRegistry();
    const policy = new DefaultChunkPolicy("zstd-19");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append(rec({ method: "GET", status: 200 }));
    builder.append(rec({ method: "POST", status: 201 }));
    builder.append(rec("plain string body"));
    const chunk = builder.freeze();

    const result = compactChunk(chunk, registry, "zstd-3");
    const records = readRecords(result.chunk, registry, policy);
    expect(records).toHaveLength(3);
    expect(records[0]!.body).toEqual({ method: "GET", status: 200 });
    expect(records[1]!.body).toEqual({ method: "POST", status: 201 });
    expect(records[2]!.body).toBe("plain string body");
  });

  it("compact preserves rich metadata (traceId, spanId, eventName)", () => {
    const registry = defaultRegistry();
    const policy = new DefaultChunkPolicy("zstd-19");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 17,
      severityText: "ERROR",
      body: "request failed",
      attributes: [{ key: "url", value: "/api/users" }],
      traceId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      spanId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      eventName: "http.request",
      flags: 1,
      droppedAttributesCount: 2,
    });
    const chunk = builder.freeze();

    const result = compactChunk(chunk, registry, "gzip-6");
    const records = readRecords(result.chunk, registry, policy);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.body).toBe("request failed");
    expect(r.severityNumber).toBe(17);
    expect(r.eventName).toBe("http.request");
    expect(r.flags).toBe(1);
    expect(r.attributes).toEqual([{ key: "url", value: "/api/users" }]);
    // traceId/spanId round-trip through NDJSON as hex strings or arrays
    expect(r.traceId).toBeDefined();
    expect(r.spanId).toBeDefined();
  });

  it("compact stats report timing", () => {
    const registry = defaultRegistry();
    const policy = new DefaultChunkPolicy("zstd-19");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    for (let i = 0; i < 64; i++) builder.append(rec(`line ${i}`, 9, BigInt(i)));
    const chunk = builder.freeze();

    const result = compactChunk(chunk, registry, "gzip-6");
    expect(result.stats.decodeMillis).toBeGreaterThanOrEqual(0);
    expect(result.stats.encodeMillis).toBeGreaterThanOrEqual(0);
    expect(result.stats.inputBytes).toBeGreaterThan(0);
    expect(result.stats.outputBytes).toBeGreaterThan(0);
  });
});

describe("compact: TypedColumnar chunks", () => {
  it("compact TypedColumnar chunk to different zstd level", () => {
    const registry = defaultRegistry();
    const policy = new TypedColumnarDrainPolicy();
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    for (let i = 0; i < 16; i++) {
      builder.append(rec(`Connection from 192.168.1.${i} port ${3000 + i}`, 9, BigInt(i * 1000)));
    }
    const chunk = builder.freeze();

    // Compact from zstd-19 to zstd-3
    const result = compactChunk(chunk, registry, "zstd-3");
    expect(result.chunk.header.nLogs).toBe(16);
    expect(result.chunk.header.codecName).toBe("zstd-3");

    // Read back with policy (needed because typed columnar needs codec meta)
    const records = readRecords(result.chunk, registry, policy);
    expect(records).toHaveLength(16);
    expect(records[0]!.body).toContain("192.168.1.0");
    expect(records[15]!.body).toContain("192.168.1.15");
  });
});

describe("compact + query integration", () => {
  it("query works on compacted chunks", () => {
    const store = new LogStore({
      rowsPerChunk: 8,
      policyFactory: () => new TypedColumnarDrainPolicy(),
    });
    for (let i = 0; i < 20; i++) {
      store.append(resource, scope, rec(`user ${i % 2 === 0 ? "login" : "logout"} event`, i < 10 ? 9 : 17, BigInt(i * 100)));
    }
    store.flush();

    const { records } = query(store, { bodyContains: "login", severityGte: 17 });
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.body).toContain("login");
      expect(r.severityNumber).toBeGreaterThanOrEqual(17);
    }
  });
});
