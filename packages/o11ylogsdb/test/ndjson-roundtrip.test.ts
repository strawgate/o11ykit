import { defaultRegistry } from "stardb";
import { describe, expect, it } from "vitest";
import { ChunkBuilder, DefaultChunkPolicy, readRecords } from "../src/chunk.js";
import { LogStore } from "../src/engine.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "svc", value: "test" }] };
const scope: InstrumentationScope = { name: "test" };
const registry = defaultRegistry();

describe("NDJSON round-trip: falsy field preservation", () => {
  it("eventName='' (empty string) round-trips correctly", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: "test",
      attributes: [],
      eventName: "",
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.eventName).toBe("");
  });

  it("droppedAttributesCount=0 round-trips correctly", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: "test",
      attributes: [],
      droppedAttributesCount: 0,
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.droppedAttributesCount).toBe(0);
  });

  it("flags=0 round-trips correctly", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: "test",
      attributes: [],
      flags: 0,
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.flags).toBe(0);
  });

  it("all optional fields undefined stay undefined on round-trip", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: "test",
      attributes: [],
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.eventName).toBeUndefined();
    expect(records[0]!.droppedAttributesCount).toBeUndefined();
    expect(records[0]!.flags).toBeUndefined();
    expect(records[0]!.traceId).toBeUndefined();
    expect(records[0]!.spanId).toBeUndefined();
    expect(records[0]!.observedTimeUnixNano).toBeUndefined();
  });

  it("observedTimeUnixNano=0n round-trips correctly", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      observedTimeUnixNano: 0n,
      severityNumber: 9,
      severityText: "INFO",
      body: "test",
      attributes: [],
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.observedTimeUnixNano).toBe(0n);
  });

  it("traceId and spanId with all zeros round-trip", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: "test",
      attributes: [],
      traceId: new Uint8Array(16), // all zeros
      spanId: new Uint8Array(8), // all zeros
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.traceId).toEqual(new Uint8Array(16));
    expect(records[0]!.spanId).toEqual(new Uint8Array(8));
  });
});

describe("NDJSON round-trip: complex bodies", () => {
  it("null body round-trips", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: null,
      attributes: [],
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.body).toBeNull();
  });

  it("nested object body round-trips", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    const body = { req: { method: "GET", url: "/api", headers: { host: "example.com" } } };
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body,
      attributes: [],
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.body).toEqual(body);
  });

  it("numeric body round-trips", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: 42,
      attributes: [],
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.body).toBe(42);
  });

  it("boolean body round-trips", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: false,
      attributes: [],
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.body).toBe(false);
  });

  it("array body round-trips", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append({
      timeUnixNano: 100n,
      severityNumber: 9,
      severityText: "INFO",
      body: [1, "two", { three: 3 }],
      attributes: [],
    });
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry, policy);
    expect(records[0]!.body).toEqual([1, "two", { three: 3 }]);
  });
});

describe("LogStore: full pipeline round-trip with all fields", () => {
  it("rich record with all optional fields survives engine round-trip", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    const record: LogRecord = {
      timeUnixNano: 1234567890n,
      observedTimeUnixNano: 1234567891n,
      severityNumber: 17,
      severityText: "ERROR",
      body: "request failed with status 500",
      attributes: [
        { key: "url", value: "/api/users" },
        { key: "method", value: "POST" },
      ],
      droppedAttributesCount: 3,
      flags: 1,
      traceId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      spanId: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
      eventName: "http.error",
    };
    store.append(resource, scope, record);
    store.flush();

    const results = [...store.iterRecords()];
    const decoded = results[0]!.records[0]!;
    expect(decoded.timeUnixNano).toBe(1234567890n);
    expect(decoded.observedTimeUnixNano).toBe(1234567891n);
    expect(decoded.severityNumber).toBe(17);
    expect(decoded.severityText).toBe("ERROR");
    expect(decoded.body).toBe("request failed with status 500");
    expect(decoded.attributes).toEqual([
      { key: "url", value: "/api/users" },
      { key: "method", value: "POST" },
    ]);
    expect(decoded.droppedAttributesCount).toBe(3);
    expect(decoded.flags).toBe(1);
    expect(decoded.traceId).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    );
    expect(decoded.spanId).toEqual(new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]));
    expect(decoded.eventName).toBe("http.error");
  });
});
