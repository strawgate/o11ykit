import { describe, expect, it } from "vitest";

import { DefaultChunkPolicy } from "../src/chunk.js";
import { LogStore } from "../src/engine.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "service.name", value: "test" }] };
const scope: InstrumentationScope = { name: "test-scope" };

function rec(partial: Partial<LogRecord> & { timeUnixNano: bigint }): LogRecord {
  return {
    severityNumber: 9,
    severityText: "INFO",
    body: "hello",
    attributes: [],
    ...partial,
  };
}

describe("LogStore.append", () => {
  it("interns one stream per (resource, scope) tuple", () => {
    const store = new LogStore();
    store.append(resource, scope, rec({ timeUnixNano: 1n }));
    store.append(resource, scope, rec({ timeUnixNano: 2n }));
    expect(store.streams.size()).toBe(1);
  });

  it("interns separate streams for different resources", () => {
    const store = new LogStore();
    store.append(
      { attributes: [{ key: "service.name", value: "a" }] },
      scope,
      rec({ timeUnixNano: 1n })
    );
    store.append(
      { attributes: [{ key: "service.name", value: "b" }] },
      scope,
      rec({ timeUnixNano: 2n })
    );
    expect(store.streams.size()).toBe(2);
  });

  it("freezes a chunk when rowsPerChunk is reached", () => {
    const store = new LogStore({ rowsPerChunk: 4 });
    for (let i = 0; i < 4; i++) {
      store.append(resource, scope, rec({ timeUnixNano: BigInt(i) }));
    }
    const stats = store.stats();
    expect(stats.chunks).toBe(1);
    expect(stats.totalLogs).toBe(4);
  });

  it("does not freeze in-flight chunks until flush", () => {
    const store = new LogStore({ rowsPerChunk: 1024 });
    for (let i = 0; i < 5; i++) {
      store.append(resource, scope, rec({ timeUnixNano: BigInt(i) }));
    }
    expect(store.stats().chunks).toBe(0);
    store.flush();
    expect(store.stats().chunks).toBe(1);
    expect(store.stats().totalLogs).toBe(5);
  });
});

describe("LogStore.iterRecords", () => {
  it("round-trips appended records via the default policy", () => {
    const store = new LogStore({ rowsPerChunk: 4 });
    const inputs = [1n, 2n, 3n, 4n, 5n];
    for (const t of inputs) store.append(resource, scope, rec({ timeUnixNano: t, body: `r${t}` }));
    store.flush();
    const collected: LogRecord[] = [];
    for (const { records } of store.iterRecords()) collected.push(...records);
    expect(collected.length).toBe(inputs.length);
    expect(collected.map((r) => r.timeUnixNano)).toEqual(inputs);
  });
});

describe("LogStore.stats", () => {
  it("reports zero bytes per log when empty", () => {
    const store = new LogStore();
    const stats = store.stats();
    expect(stats.streams).toBe(0);
    expect(stats.totalLogs).toBe(0);
    expect(stats.bytesPerLog).toBe(0);
  });

  it("counts every chunk's wire size, including header overhead", () => {
    const store = new LogStore({ rowsPerChunk: 4 });
    for (let i = 0; i < 8; i++) {
      store.append(resource, scope, rec({ timeUnixNano: BigInt(i) }));
    }
    const stats = store.stats();
    expect(stats.chunks).toBe(2);
    expect(stats.totalLogs).toBe(8);
    expect(stats.totalChunkBytes).toBeGreaterThan(0);
    expect(stats.bytesPerLog).toBeCloseTo(stats.totalChunkBytes / stats.totalLogs);
  });
});

describe("LogStore.policyFactory", () => {
  it("creates exactly one policy per stream and reuses it across chunks", () => {
    const calls: string[] = [];
    const store = new LogStore({
      rowsPerChunk: 2,
      policyFactory: (_id, r) => {
        const name = r.attributes.find((kv) => kv.key === "service.name")?.value ?? "?";
        calls.push(String(name));
        return new DefaultChunkPolicy();
      },
    });
    const resA: Resource = { attributes: [{ key: "service.name", value: "A" }] };
    const resB: Resource = { attributes: [{ key: "service.name", value: "B" }] };
    // 4 records on A → 2 chunks via the same policy instance.
    for (let i = 0; i < 4; i++) store.append(resA, scope, rec({ timeUnixNano: BigInt(i) }));
    // 2 records on B → 1 chunk via a *separate* policy instance.
    for (let i = 0; i < 2; i++) store.append(resB, scope, rec({ timeUnixNano: BigInt(i) }));
    expect(calls).toEqual(["A", "B"]);
  });

  it("falls back to the configured policy when no factory is set", () => {
    const policy = new DefaultChunkPolicy();
    const store = new LogStore({ policy });
    const id = store.streams.intern(resource, scope);
    expect(store.policyFor(id)).toBe(policy);
  });
});
