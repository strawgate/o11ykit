import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, nowMillis, StreamRegistry } from "../src/index.js";

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
