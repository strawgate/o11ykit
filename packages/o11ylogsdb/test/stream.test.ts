import { defaultRegistry } from "stardb";
import { describe, expect, it } from "vitest";
import { ChunkBuilder, DefaultChunkPolicy } from "../src/chunk.js";
import { StreamRegistry } from "../src/stream.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const registry = defaultRegistry();

function makeResource(serviceName: string): Resource {
  return { attributes: [{ key: "service.name", value: serviceName }] };
}

function makeScope(name: string): InstrumentationScope {
  return { name };
}

function makeChunk(resource: Resource, scope: InstrumentationScope, ts: bigint) {
  const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
  const record: LogRecord = {
    timeUnixNano: ts,
    severityNumber: 9,
    severityText: "INFO",
    body: "hello",
    attributes: [],
  };
  builder.append(record);
  return builder.freeze();
}

describe("StreamRegistry.intern", () => {
  it("returns the same id for the same (resource, scope) reference", () => {
    const reg = new StreamRegistry();
    const resource = makeResource("a");
    const scope = makeScope("s");
    expect(reg.intern(resource, scope)).toBe(reg.intern(resource, scope));
  });

  it("returns the same id for structurally equal resources/scopes", () => {
    const reg = new StreamRegistry();
    const id1 = reg.intern(makeResource("a"), makeScope("s"));
    const id2 = reg.intern(makeResource("a"), makeScope("s"));
    expect(id1).toBe(id2);
  });

  it("returns different ids for different services", () => {
    const reg = new StreamRegistry();
    const id1 = reg.intern(makeResource("a"), makeScope("s"));
    const id2 = reg.intern(makeResource("b"), makeScope("s"));
    expect(id1).not.toBe(id2);
  });

  it("returns different ids for different scopes", () => {
    const reg = new StreamRegistry();
    const resource = makeResource("a");
    const id1 = reg.intern(resource, makeScope("s1"));
    const id2 = reg.intern(resource, makeScope("s2"));
    expect(id1).not.toBe(id2);
  });
});

describe("StreamRegistry chunk lists", () => {
  it("appends chunks in insertion order", () => {
    const reg = new StreamRegistry();
    const resource = makeResource("a");
    const scope = makeScope("s");
    const id = reg.intern(resource, scope);
    reg.appendChunk(id, makeChunk(resource, scope, 1n));
    reg.appendChunk(id, makeChunk(resource, scope, 2n));
    reg.appendChunk(id, makeChunk(resource, scope, 3n));
    const chunks = reg.chunksOf(id);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.header.timeRange.minNano)).toEqual(["1", "2", "3"]);
  });

  it("chunksOf throws for an unknown stream id", () => {
    const reg = new StreamRegistry();
    expect(() => reg.chunksOf(999)).toThrow(/unknown id/);
  });

  it("ids() lists every interned stream and size() agrees", () => {
    const reg = new StreamRegistry();
    reg.intern(makeResource("a"), makeScope("s"));
    reg.intern(makeResource("b"), makeScope("s"));
    reg.intern(makeResource("c"), makeScope("s"));
    expect(reg.ids().length).toBe(3);
    expect(reg.size()).toBe(3);
  });

  it("resourceOf and scopeOf return the originals", () => {
    const reg = new StreamRegistry();
    const resource = makeResource("checkout");
    const scope = makeScope("server");
    const id = reg.intern(resource, scope);
    expect(reg.resourceOf(id)).toEqual(resource);
    expect(reg.scopeOf(id)).toEqual(scope);
  });
});
