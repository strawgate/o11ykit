import { describe, expect, it } from "vitest";
import type { ChunkWireOptions } from "../src/index.js";
import { chunkWireSize, deserializeChunkWire, serializeChunkWire } from "../src/index.js";

const TEST_OPTS: ChunkWireOptions = {
  magic: new Uint8Array([0x54, 0x45, 0x53, 0x54]), // "TEST"
  version: 1,
  name: "testdb",
};

describe("serializeChunkWire / deserializeChunkWire", () => {
  it("round-trips a simple header + payload", () => {
    const header = { count: 10, codec: "zstd-3" };
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const wire = serializeChunkWire(header, payload, TEST_OPTS);
    const { header: h2, payload: p2 } = deserializeChunkWire<typeof header>(wire, TEST_OPTS);
    expect(h2).toEqual(header);
    expect(p2).toEqual(payload);
  });

  it("round-trips empty payload", () => {
    const header = { empty: true };
    const payload = new Uint8Array(0);
    const wire = serializeChunkWire(header, payload, TEST_OPTS);
    const { header: h2, payload: p2 } = deserializeChunkWire<typeof header>(wire, TEST_OPTS);
    expect(h2).toEqual(header);
    expect(p2.length).toBe(0);
  });

  it("round-trips complex header with nested objects", () => {
    const header = {
      timeRange: { min: "1000", max: "2000" },
      attributes: [{ key: "host", value: "web-1" }],
      count: 1024,
    };
    const payload = new Uint8Array(100);
    payload.fill(0xab);
    const wire = serializeChunkWire(header, payload, TEST_OPTS);
    const { header: h2, payload: p2 } = deserializeChunkWire<typeof header>(wire, TEST_OPTS);
    expect(h2).toEqual(header);
    expect(p2).toEqual(payload);
  });

  it("wire starts with magic bytes", () => {
    const wire = serializeChunkWire({ x: 1 }, new Uint8Array(0), TEST_OPTS);
    expect(wire[0]).toBe(0x54); // T
    expect(wire[1]).toBe(0x45); // E
    expect(wire[2]).toBe(0x53); // S
    expect(wire[3]).toBe(0x54); // T
  });

  it("wire byte 4 is version", () => {
    const wire = serializeChunkWire({ x: 1 }, new Uint8Array(0), TEST_OPTS);
    expect(wire[4]).toBe(1);
  });

  it("works with different magic bytes", () => {
    const opts2: ChunkWireOptions = {
      magic: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
      version: 2,
      name: "other",
    };
    const header = { v: "hello" };
    const payload = new Uint8Array([99]);
    const wire = serializeChunkWire(header, payload, opts2);
    const result = deserializeChunkWire<typeof header>(wire, opts2);
    expect(result.header).toEqual(header);
    expect(result.payload).toEqual(payload);
  });

  it("throws on buffer too small", () => {
    const buf = new Uint8Array(5);
    expect(() => deserializeChunkWire(buf, TEST_OPTS)).toThrow("chunk too small");
  });

  it("throws on invalid magic", () => {
    const wire = serializeChunkWire({ x: 1 }, new Uint8Array(0), TEST_OPTS);
    wire[0] = 0xff; // corrupt magic
    expect(() => deserializeChunkWire(wire, TEST_OPTS)).toThrow("invalid chunk magic");
  });

  it("throws on wrong version", () => {
    const wire = serializeChunkWire({ x: 1 }, new Uint8Array(0), TEST_OPTS);
    wire[4] = 99; // wrong version
    expect(() => deserializeChunkWire(wire, TEST_OPTS)).toThrow("unsupported chunk version 99");
  });

  it("throws on truncated header", () => {
    const wire = serializeChunkWire({ x: 1 }, new Uint8Array(0), TEST_OPTS);
    // Truncate after the header length field but before header data
    const truncated = wire.subarray(0, 10);
    expect(() => deserializeChunkWire(truncated, TEST_OPTS)).toThrow("truncated header");
  });

  it("includes engine name in error messages", () => {
    const opts: ChunkWireOptions = { magic: new Uint8Array(4), version: 1, name: "myengine" };
    const buf = new Uint8Array(3);
    expect(() => deserializeChunkWire(buf, opts)).toThrow("myengine:");
  });
});

describe("chunkWireSize", () => {
  it("returns the correct total wire size", () => {
    const header = { count: 10 };
    const payload = new Uint8Array(50);
    const size = chunkWireSize(header, payload);
    const actual = serializeChunkWire(header, payload, TEST_OPTS);
    expect(size).toBe(actual.length);
  });

  it("matches for empty payload", () => {
    const header = { a: "b" };
    const payload = new Uint8Array(0);
    const size = chunkWireSize(header, payload);
    const actual = serializeChunkWire(header, payload, TEST_OPTS);
    expect(size).toBe(actual.length);
  });

  it("matches for large payload", () => {
    const header = { big: true, keys: [1, 2, 3] };
    const payload = new Uint8Array(10000);
    const size = chunkWireSize(header, payload);
    const actual = serializeChunkWire(header, payload, TEST_OPTS);
    expect(size).toBe(actual.length);
  });
});
