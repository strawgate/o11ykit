import { describe, expect, it } from "vitest";

import { LogStore } from "../src/engine.js";
import { query } from "../src/query.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

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

function buildStore(): { store: LogStore; resA: Resource; resB: Resource } {
  const resA: Resource = { attributes: [{ key: "service.name", value: "checkout" }] };
  const resB: Resource = { attributes: [{ key: "service.name", value: "payments" }] };
  const store = new LogStore({ rowsPerChunk: 4 });
  // checkout: 7 records spanning t=1000-7000, mixed severities
  store.append(
    resA,
    scope,
    rec({ timeUnixNano: 1000n, body: "request accepted", severityNumber: 9 })
  );
  store.append(
    resA,
    scope,
    rec({ timeUnixNano: 2000n, body: "validation failed", severityNumber: 13 })
  );
  store.append(
    resA,
    scope,
    rec({ timeUnixNano: 3000n, body: "request accepted", severityNumber: 9 })
  );
  store.append(
    resA,
    scope,
    rec({ timeUnixNano: 4000n, body: "internal error", severityNumber: 17 })
  );
  store.append(
    resA,
    scope,
    rec({ timeUnixNano: 5000n, body: "request accepted", severityNumber: 9 })
  );
  store.append(
    resA,
    scope,
    rec({ timeUnixNano: 6000n, body: "request accepted", severityNumber: 9 })
  );
  store.append(
    resA,
    scope,
    rec({ timeUnixNano: 7000n, body: "request accepted", severityNumber: 9 })
  );
  // payments: 4 records spanning t=10000-13000
  store.append(resB, scope, rec({ timeUnixNano: 10_000n, body: "charge ok", severityNumber: 9 }));
  store.append(
    resB,
    scope,
    rec({ timeUnixNano: 11_000n, body: "charge declined", severityNumber: 13 })
  );
  store.append(resB, scope, rec({ timeUnixNano: 12_000n, body: "charge ok", severityNumber: 9 }));
  store.append(resB, scope, rec({ timeUnixNano: 13_000n, body: "charge ok", severityNumber: 9 }));
  store.flush();
  return { store, resA, resB };
}

describe("query: time-range pruning", () => {
  it("returns only records whose timestamps fall in [from, to)", () => {
    const { store } = buildStore();
    const result = query(store, { range: { from: 2000n, to: 5000n } });
    expect(result.records.map((r) => r.timeUnixNano)).toEqual([2000n, 3000n, 4000n]);
  });

  it("prunes chunks that cannot contain any matching record", () => {
    const { store } = buildStore();
    // Range entirely within payments — checkout chunks get pruned.
    const result = query(store, { range: { from: 10_000n, to: 13_500n } });
    expect(result.records.length).toBe(4);
    // checkout has 2 chunks, payments has 1 — at least 2 should prune.
    expect(result.stats.chunksPruned).toBeGreaterThanOrEqual(2);
  });
});

describe("query: severity zone-map pruning", () => {
  it("returns only records at or above the threshold", () => {
    const { store } = buildStore();
    const result = query(store, { severityGte: 13 });
    expect(result.records.map((r) => r.severityNumber)).toEqual([13, 17, 13]);
  });

  it("prunes chunks whose maxSeverity is below the threshold", () => {
    const { store } = buildStore();
    // severityGte=20 — no chunk's max is that high, all should prune.
    const result = query(store, { severityGte: 20 });
    expect(result.records.length).toBe(0);
    expect(result.stats.chunksPruned).toBeGreaterThan(0);
  });
});

describe("query: resource attribute equality", () => {
  it("prunes streams whose resource attributes don't match", () => {
    const { store } = buildStore();
    const result = query(store, { resourceEquals: { "service.name": "payments" } });
    expect(result.records.length).toBe(4);
    expect(result.stats.streamsPruned).toBe(1);
  });

  it("returns nothing if no stream matches", () => {
    const { store } = buildStore();
    const result = query(store, { resourceEquals: { "service.name": "ghost" } });
    expect(result.records.length).toBe(0);
    expect(result.stats.streamsPruned).toBe(2);
  });
});

describe("query: body substring", () => {
  it("matches case-sensitively against string bodies", () => {
    const { store } = buildStore();
    const result = query(store, { bodyContains: "declined" });
    expect(result.records.length).toBe(1);
    expect(result.records[0]?.body).toBe("charge declined");
  });

  it("returns no records when a non-string body is asked to match", () => {
    const store = new LogStore({ rowsPerChunk: 4 });
    const r: Resource = { attributes: [{ key: "service.name", value: "x" }] };
    store.append(r, scope, rec({ timeUnixNano: 1n, body: { kind: "map" } }));
    store.flush();
    const result = query(store, { bodyContains: "map" });
    expect(result.records.length).toBe(0);
  });
});

describe("query: bodyLeafEquals", () => {
  it("matches dot-path leaves on KVList bodies", () => {
    const store = new LogStore({ rowsPerChunk: 4 });
    const r: Resource = { attributes: [{ key: "service.name", value: "api" }] };
    store.append(
      r,
      scope,
      rec({ timeUnixNano: 1n, body: { req: { method: "GET", status: 200 } } })
    );
    store.append(
      r,
      scope,
      rec({ timeUnixNano: 2n, body: { req: { method: "POST", status: 201 } } })
    );
    store.append(
      r,
      scope,
      rec({ timeUnixNano: 3n, body: { req: { method: "GET", status: 500 } } })
    );
    store.flush();
    const result = query(store, { bodyLeafEquals: { "body.req.method": "GET" } });
    expect(result.records.length).toBe(2);
    expect(result.records.map((rec) => rec.timeUnixNano)).toEqual([1n, 3n]);
  });

  it("rejects records with non-KVList bodies", () => {
    const { store } = buildStore();
    // bodies are strings — bodyLeafEquals should match nothing.
    const result = query(store, { bodyLeafEquals: { "body.x": "y" } });
    expect(result.records.length).toBe(0);
  });
});

describe("query: limit", () => {
  it("short-circuits after N records", () => {
    const { store } = buildStore();
    const result = query(store, { limit: 3 });
    expect(result.records.length).toBe(3);
  });
});

describe("query stats", () => {
  it("reports streamsScanned, chunksScanned, recordsScanned/Emitted", () => {
    const { store } = buildStore();
    const result = query(store, {});
    expect(result.stats.streamsScanned).toBe(2);
    expect(result.stats.chunksScanned).toBe(3); // checkout=2, payments=1
    expect(result.stats.recordsScanned).toBe(11);
    expect(result.stats.recordsEmitted).toBe(11);
  });
});
