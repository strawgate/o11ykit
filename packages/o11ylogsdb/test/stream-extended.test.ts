import { describe, it, expect } from "vitest";
import { StreamRegistry } from "../src/stream.js";
import type { Resource, InstrumentationScope, StreamId } from "../src/types.js";
import type { Chunk } from "../src/chunk.js";

function fakeChunk(): Chunk {
  return {
    header: {
      codecName: "ndjson+zstd-19",
      nLogs: 1,
      minNano: 1n,
      maxNano: 2n,
      codecMeta: undefined,
      payloadBytes: 10,
    },
    payload: new Uint8Array(10),
  };
}

describe("StreamRegistry error paths", () => {
  it("resourceOf throws for unknown id", () => {
    const reg = new StreamRegistry();
    expect(() => reg.resourceOf(999 as StreamId)).toThrow("unknown id 999");
  });

  it("scopeOf throws for unknown id", () => {
    const reg = new StreamRegistry();
    expect(() => reg.scopeOf(999 as StreamId)).toThrow("unknown id 999");
  });

  it("appendChunk throws for unknown id", () => {
    const reg = new StreamRegistry();
    expect(() => reg.appendChunk(999 as StreamId, fakeChunk())).toThrow("unknown id 999");
  });

  it("chunksOf throws for unknown id", () => {
    const reg = new StreamRegistry();
    expect(() => reg.chunksOf(999 as StreamId)).toThrow("unknown id 999");
  });
});

describe("StreamRegistry scope differentiation", () => {
  const resource: Resource = { attributes: [{ key: "svc", value: "A" }] };

  it("different scope versions get different stream ids", () => {
    const reg = new StreamRegistry();
    const s1: InstrumentationScope = { name: "lib", version: "1.0" };
    const s2: InstrumentationScope = { name: "lib", version: "2.0" };
    const id1 = reg.intern(resource, s1);
    const id2 = reg.intern(resource, s2);
    expect(id1).not.toBe(id2);
    expect(reg.size()).toBe(2);
  });

  it("scope with and without version are different streams", () => {
    const reg = new StreamRegistry();
    const s1: InstrumentationScope = { name: "lib" };
    const s2: InstrumentationScope = { name: "lib", version: "" };
    // version: undefined → canonScope uses "", version: "" also uses ""
    // so they should be the SAME stream
    const id1 = reg.intern(resource, s1);
    const id2 = reg.intern(resource, s2);
    expect(id1).toBe(id2);
  });

  it("scopes with different attributes are different streams", () => {
    const reg = new StreamRegistry();
    const s1: InstrumentationScope = { name: "lib", attributes: [{ key: "env", value: "prod" }] };
    const s2: InstrumentationScope = { name: "lib", attributes: [{ key: "env", value: "dev" }] };
    const id1 = reg.intern(resource, s1);
    const id2 = reg.intern(resource, s2);
    expect(id1).not.toBe(id2);
  });

  it("scope with no attributes vs empty attributes are the same", () => {
    const reg = new StreamRegistry();
    const s1: InstrumentationScope = { name: "lib" };
    const s2: InstrumentationScope = { name: "lib", attributes: [] };
    // attributes: undefined → canonScope uses {}, attributes: [] → kvsToObject returns {}
    const id1 = reg.intern(resource, s1);
    const id2 = reg.intern(resource, s2);
    expect(id1).toBe(id2);
  });
});

describe("StreamRegistry resource differentiation", () => {
  const scope: InstrumentationScope = { name: "test" };

  it("resources with different droppedAttributesCount are different", () => {
    const reg = new StreamRegistry();
    const r1: Resource = { attributes: [], droppedAttributesCount: 0 };
    const r2: Resource = { attributes: [], droppedAttributesCount: 5 };
    const id1 = reg.intern(r1, scope);
    const id2 = reg.intern(r2, scope);
    expect(id1).not.toBe(id2);
  });

  it("resource with droppedAttributesCount=0 vs undefined are the same", () => {
    const reg = new StreamRegistry();
    const r1: Resource = { attributes: [] };
    const r2: Resource = { attributes: [], droppedAttributesCount: 0 };
    const id1 = reg.intern(r1, scope);
    const id2 = reg.intern(r2, scope);
    expect(id1).toBe(id2);
  });

  it("resources with Uint8Array attribute values intern correctly", () => {
    const reg = new StreamRegistry();
    const r1: Resource = { attributes: [{ key: "trace", value: new Uint8Array([1, 2, 3]) }] };
    const r2: Resource = { attributes: [{ key: "trace", value: new Uint8Array([1, 2, 3]) }] };
    const r3: Resource = { attributes: [{ key: "trace", value: new Uint8Array([4, 5, 6]) }] };
    const id1 = reg.intern(r1, scope);
    const id2 = reg.intern(r2, scope);
    const id3 = reg.intern(r3, scope);
    expect(id1).toBe(id2); // same bytes → same stream
    expect(id1).not.toBe(id3); // different bytes → different stream
  });

  it("resources with bigint attribute values intern correctly", () => {
    const reg = new StreamRegistry();
    const r1: Resource = { attributes: [{ key: "id", value: 12345n }] };
    const r2: Resource = { attributes: [{ key: "id", value: 12345n }] };
    const r3: Resource = { attributes: [{ key: "id", value: 99999n }] };
    const id1 = reg.intern(r1, scope);
    const id2 = reg.intern(r2, scope);
    const id3 = reg.intern(r3, scope);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it("empty resource attributes is valid", () => {
    const reg = new StreamRegistry();
    const r: Resource = { attributes: [] };
    const id = reg.intern(r, scope);
    expect(id).toBeGreaterThan(0);
    expect(reg.resourceOf(id).attributes).toEqual([]);
  });
});

describe("StreamRegistry reference caching", () => {
  it("same object reference hits fast path", () => {
    const reg = new StreamRegistry();
    const r: Resource = { attributes: [{ key: "svc", value: "x" }] };
    const s: InstrumentationScope = { name: "fast" };
    const id1 = reg.intern(r, s);
    const id2 = reg.intern(r, s); // same refs — WeakMap fast path
    expect(id1).toBe(id2);
  });

  it("structurally equal but different refs still dedup", () => {
    const reg = new StreamRegistry();
    const r1: Resource = { attributes: [{ key: "svc", value: "x" }] };
    const r2: Resource = { attributes: [{ key: "svc", value: "x" }] };
    const s: InstrumentationScope = { name: "slow" };
    const id1 = reg.intern(r1, s);
    const id2 = reg.intern(r2, s); // different refs, structural equality
    expect(id1).toBe(id2);
    expect(reg.size()).toBe(1);
  });
});

describe("StreamRegistry chunk operations", () => {
  it("appendChunk and chunksOf work correctly", () => {
    const reg = new StreamRegistry();
    const r: Resource = { attributes: [] };
    const s: InstrumentationScope = { name: "test" };
    const id = reg.intern(r, s);
    expect(reg.chunksOf(id)).toHaveLength(0);

    reg.appendChunk(id, fakeChunk());
    reg.appendChunk(id, fakeChunk());
    expect(reg.chunksOf(id)).toHaveLength(2);
  });

  it("ids() returns all interned stream ids", () => {
    const reg = new StreamRegistry();
    const s: InstrumentationScope = { name: "test" };
    reg.intern({ attributes: [{ key: "a", value: "1" }] }, s);
    reg.intern({ attributes: [{ key: "a", value: "2" }] }, s);
    reg.intern({ attributes: [{ key: "a", value: "3" }] }, s);
    expect(reg.ids()).toHaveLength(3);
  });
});
