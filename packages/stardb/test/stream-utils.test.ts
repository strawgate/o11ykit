import { describe, expect, it } from "vitest";
import {
  bytesEqual,
  bytesToHex,
  bytesToUuid,
  fnv1aBytes,
  hexToBytes,
  nowMillis,
  StreamRegistry,
  timeRangeOverlaps,
  uuidToBytes,
} from "../src/index.js";

describe("StreamRegistry (shared)", () => {
  const resource = { attributes: [{ key: "host", value: "web-1" }] };
  const scope = { name: "test", version: "1.0.0" };

  it("interns a stream and returns a stable id", () => {
    const reg = new StreamRegistry();
    const id1 = reg.intern(resource, scope);
    const id2 = reg.intern(resource, scope);
    expect(id1).toBe(id2);
    expect(reg.size()).toBe(1);
  });

  it("returns different ids for different resources", () => {
    const reg = new StreamRegistry();
    const id1 = reg.intern(resource, scope);
    const id2 = reg.intern({ attributes: [{ key: "host", value: "web-2" }] }, scope);
    expect(id1).not.toBe(id2);
    expect(reg.size()).toBe(2);
  });

  it("returns different ids for different scopes", () => {
    const reg = new StreamRegistry();
    const id1 = reg.intern(resource, scope);
    const id2 = reg.intern(resource, { name: "other", version: "2.0.0" });
    expect(id1).not.toBe(id2);
  });

  it("stores and retrieves resource/scope by id", () => {
    const reg = new StreamRegistry();
    const id = reg.intern(resource, scope);
    expect(reg.resourceOf(id)).toBe(resource);
    expect(reg.scopeOf(id)).toBe(scope);
  });

  it("appends and retrieves chunks", () => {
    const reg = new StreamRegistry();
    const id = reg.intern(resource, scope);
    const chunk = { header: { id: 1 }, payload: new Uint8Array([1, 2, 3]) };
    reg.appendChunk(id, chunk);
    expect(reg.chunksOf(id)).toEqual([chunk]);
  });

  it("removes chunks and cleans up empty streams", () => {
    const reg = new StreamRegistry();
    const id = reg.intern(resource, scope);
    const chunk = { header: { id: 1 }, payload: new Uint8Array([1]) };
    reg.appendChunk(id, chunk);
    reg.removeChunk(id, chunk);
    // Stream entry is cleaned up when last chunk is removed
    expect(reg.size()).toBe(0);
  });

  it("handles reference-identity fast path", () => {
    const reg = new StreamRegistry();
    // Same object refs → fast path hit
    const id1 = reg.intern(resource, scope);
    const id2 = reg.intern(resource, scope);
    expect(id1).toBe(id2);
  });

  it("handles structurally-equal but different refs", () => {
    const reg = new StreamRegistry();
    const id1 = reg.intern(resource, scope);
    // Different object, same shape
    const resource2 = { attributes: [{ key: "host", value: "web-1" }] };
    const scope2 = { name: "test", version: "1.0.0" };
    const id2 = reg.intern(resource2, scope2);
    expect(id1).toBe(id2);
  });

  it("lists all ids", () => {
    const reg = new StreamRegistry();
    reg.intern(resource, scope);
    reg.intern({ attributes: [{ key: "host", value: "web-2" }] }, scope);
    expect(reg.ids()).toHaveLength(2);
  });

  it("throws on unknown id", () => {
    const reg = new StreamRegistry();
    expect(() => reg.resourceOf(999)).toThrow("unknown id 999");
    expect(() => reg.scopeOf(999)).toThrow("unknown id 999");
    expect(() => reg.appendChunk(999, {})).toThrow("unknown id 999");
    expect(() => reg.chunksOf(999)).toThrow("unknown id 999");
  });

  it("handles stale ref after removeChunk", () => {
    const reg = new StreamRegistry();
    const id = reg.intern(resource, scope);
    const chunk = { data: "x" };
    reg.appendChunk(id, chunk);
    reg.removeChunk(id, chunk);
    // Stream was cleaned up, but re-interning should work
    const id2 = reg.intern(resource, scope);
    expect(id2).toBeGreaterThan(0);
    expect(reg.size()).toBe(1);
  });
});

describe("bytesToHex / hexToBytes", () => {
  it("round-trips bytes through hex", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("00010f10ff");
    expect(hexToBytes(hex)).toEqual(bytes);
  });

  it("handles empty input", () => {
    expect(bytesToHex(new Uint8Array(0))).toBe("");
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });

  it("handles 16-byte trace id", () => {
    const traceId = new Uint8Array(16);
    traceId.fill(0xab);
    const hex = bytesToHex(traceId);
    expect(hex).toBe("abababababababababababababababab");
    expect(hexToBytes(hex)).toEqual(traceId);
  });
});

describe("nowMillis", () => {
  it("returns a positive number", () => {
    const t = nowMillis();
    expect(t).toBeGreaterThan(0);
    expect(typeof t).toBe("number");
  });

  it("increases over time", async () => {
    const t1 = nowMillis();
    await new Promise((r) => setTimeout(r, 5));
    const t2 = nowMillis();
    expect(t2).toBeGreaterThan(t1);
  });
});

describe("fnv1aBytes", () => {
  it("returns a u32 for empty input", () => {
    const hash = fnv1aBytes(new Uint8Array(0));
    // FNV offset basis for empty input
    expect(hash).toBe(0x811c9dc5);
  });

  it("returns consistent results for same input", () => {
    const data = new TextEncoder().encode("hello world");
    const h1 = fnv1aBytes(data);
    const h2 = fnv1aBytes(data);
    expect(h1).toBe(h2);
  });

  it("returns different hashes for different inputs", () => {
    const enc = new TextEncoder();
    const h1 = fnv1aBytes(enc.encode("foo"));
    const h2 = fnv1aBytes(enc.encode("bar"));
    const h3 = fnv1aBytes(enc.encode("baz"));
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h2).not.toBe(h3);
  });

  it("produces known test vector for 'foobar'", () => {
    // Known FNV-1a 32-bit hash for "foobar": 0xbf9cf968
    const hash = fnv1aBytes(new TextEncoder().encode("foobar"));
    expect(hash).toBe(0xbf9cf968);
  });

  it("always returns non-negative u32", () => {
    const data = new TextEncoder().encode("test input that might produce negative signed int");
    const hash = fnv1aBytes(data);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("bytesEqual", () => {
  it("returns true for identical arrays", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(bytesEqual(a, a)).toBe(true);
  });

  it("returns true for equal content", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(bytesEqual(a, b)).toBe(true);
  });

  it("returns false for different lengths", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2]);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it("returns false for different content", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it("returns true for empty arrays", () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe("bytesToUuid / uuidToBytes", () => {
  it("formats 16 bytes as canonical UUID string", () => {
    const bytes = new Uint8Array([
      0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00,
      0x00,
    ]);
    expect(bytesToUuid(bytes)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("round-trips through uuidToBytes", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const bytes = uuidToBytes(uuid);
    expect(bytesToUuid(bytes)).toBe(uuid);
  });

  it("uuidToBytes handles no-dash format", () => {
    const noDash = "550e8400e29b41d4a716446655440000";
    const withDash = "550e8400-e29b-41d4-a716-446655440000";
    expect(uuidToBytes(noDash)).toEqual(uuidToBytes(withDash));
  });

  it("handles all-zeros UUID", () => {
    const bytes = new Uint8Array(16);
    expect(bytesToUuid(bytes)).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("handles all-ff UUID", () => {
    const bytes = new Uint8Array(16).fill(0xff);
    expect(bytesToUuid(bytes)).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });
});

describe("timeRangeOverlaps", () => {
  it("returns true when ranges fully overlap", () => {
    expect(timeRangeOverlaps(100n, 200n, 50n, 250n)).toBe(true);
  });

  it("returns true when chunk contains query range", () => {
    expect(timeRangeOverlaps(50n, 250n, 100n, 200n)).toBe(true);
  });

  it("returns true when ranges partially overlap", () => {
    expect(timeRangeOverlaps(100n, 200n, 150n, 250n)).toBe(true);
    expect(timeRangeOverlaps(100n, 200n, 50n, 150n)).toBe(true);
  });

  it("returns false when chunk is entirely before query", () => {
    expect(timeRangeOverlaps(100n, 200n, 300n, 400n)).toBe(false);
  });

  it("returns false when chunk is entirely after query", () => {
    expect(timeRangeOverlaps(300n, 400n, 100n, 200n)).toBe(false);
  });

  it("returns false when chunk.max == queryFrom - 1 (exclusive)", () => {
    expect(timeRangeOverlaps(100n, 199n, 200n, 300n)).toBe(false);
  });

  it("returns false when chunk.min == queryTo (half-open)", () => {
    expect(timeRangeOverlaps(200n, 300n, 100n, 200n)).toBe(false);
  });

  it("returns true when queryFrom is undefined", () => {
    expect(timeRangeOverlaps(100n, 200n, undefined, 300n)).toBe(true);
  });

  it("returns true when queryTo is undefined", () => {
    expect(timeRangeOverlaps(100n, 200n, 50n, undefined)).toBe(true);
  });

  it("returns true when both bounds are undefined", () => {
    expect(timeRangeOverlaps(100n, 200n, undefined, undefined)).toBe(true);
  });
});
