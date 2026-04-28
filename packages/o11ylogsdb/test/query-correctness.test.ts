import { describe, expect, it } from "vitest";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import { LogStore } from "../src/engine.js";
import { type QuerySpec, query, queryStream } from "../src/query.js";
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

function buildMultiChunkStore(): { store: LogStore; resource: Resource } {
  const resource: Resource = { attributes: [{ key: "service.name", value: "svc" }] };
  const store = new LogStore({
    rowsPerChunk: 8,
    policyFactory: () => new TypedColumnarDrainPolicy(),
  });
  // 56 records: 7 chunks of 8 records each
  for (let i = 0; i < 56; i++) {
    const body =
      i % 7 === 0
        ? `error processing request ${i}`
        : i % 3 === 0
          ? `user alice completed action ${i}`
          : `request ${i} accepted by gateway`;
    store.append(
      resource,
      scope,
      rec({
        timeUnixNano: BigInt(1000 + i * 100),
        body,
        severityNumber: i % 7 === 0 ? 17 : i % 3 === 0 ? 13 : 9,
      })
    );
  }
  store.flush();
  return { store, resource };
}

describe("query correctness: bodyContains", () => {
  it("matches partial substrings", () => {
    const { store } = buildMultiChunkStore();
    const result = query(store, { bodyContains: "error" });
    expect(result.records.length).toBe(8); // every 7th of 56 records
    for (const r of result.records) {
      expect(r.body).toContain("error");
    }
  });

  it("returns nothing when no match exists", () => {
    const { store } = buildMultiChunkStore();
    const result = query(store, { bodyContains: "NONEXISTENT_NEEDLE" });
    expect(result.records.length).toBe(0);
  });

  it("returns all string records when needle is empty string", () => {
    const { store } = buildMultiChunkStore();
    const result = query(store, { bodyContains: "" });
    // Empty string is contained in every string — all 56 records match
    expect(result.records.length).toBe(56);
  });

  it("matches against raw string bodies (non-templated)", () => {
    const resource: Resource = { attributes: [{ key: "service.name", value: "raw" }] };
    const store = new LogStore({
      rowsPerChunk: 4,
      policyFactory: () => new TypedColumnarDrainPolicy(),
    });
    // Each record has a unique body — no templates can form
    store.append(resource, scope, rec({ timeUnixNano: 1n, body: "alpha bravo charlie" }));
    store.append(resource, scope, rec({ timeUnixNano: 2n, body: "delta echo foxtrot" }));
    store.append(resource, scope, rec({ timeUnixNano: 3n, body: "golf hotel india" }));
    store.append(resource, scope, rec({ timeUnixNano: 4n, body: "juliet kilo lima" }));
    store.flush();

    const result = query(store, { bodyContains: "echo" });
    expect(result.records.length).toBe(1);
    expect(result.records[0]?.body).toBe("delta echo foxtrot");
  });

  it("matches against templated bodies (Drain-processed)", () => {
    const resource: Resource = { attributes: [{ key: "service.name", value: "drain" }] };
    const store = new LogStore({
      rowsPerChunk: 16,
      policyFactory: () => new TypedColumnarDrainPolicy(),
    });
    // Highly templated: same structure, different user IDs
    for (let i = 0; i < 16; i++) {
      store.append(
        resource,
        scope,
        rec({ timeUnixNano: BigInt(i), body: `user user_${i} logged in successfully` })
      );
    }
    store.flush();

    const result = query(store, { bodyContains: "logged in" });
    expect(result.records.length).toBe(16);
  });

  it("does not match non-string bodies", () => {
    const resource: Resource = { attributes: [{ key: "service.name", value: "kvl" }] };
    const store = new LogStore({ rowsPerChunk: 4 });
    store.append(resource, scope, rec({ timeUnixNano: 1n, body: { msg: "hello world" } }));
    store.append(resource, scope, rec({ timeUnixNano: 2n, body: "hello world" }));
    store.flush();

    const result = query(store, { bodyContains: "hello" });
    expect(result.records.length).toBe(1);
    expect(result.records[0]?.body).toBe("hello world");
  });
});

describe("query correctness: combined predicates", () => {
  it("combines time + severity + bodyContains", () => {
    const { store } = buildMultiChunkStore();
    const result = query(store, {
      range: { from: 1000n, to: 3000n }, // records 0..19
      severityGte: 13,
      bodyContains: "error",
    });
    // In the first 20 records (t=1000..2900), errors at index 0,7,14
    // severity for error records is 17, which >= 13
    for (const r of result.records) {
      expect(Number(r.timeUnixNano)).toBeGreaterThanOrEqual(1000);
      expect(Number(r.timeUnixNano)).toBeLessThan(3000);
      expect(r.severityNumber).toBeGreaterThanOrEqual(13);
      expect(r.body).toContain("error");
    }
  });

  it("progressively narrows results with more predicates", () => {
    const { store } = buildMultiChunkStore();
    const allResult = query(store, {});
    const timeOnly = query(store, { range: { from: 1000n, to: 4000n } });
    const timeAndSev = query(store, { range: { from: 1000n, to: 4000n }, severityGte: 13 });
    const timeAndSevAndBody = query(store, {
      range: { from: 1000n, to: 4000n },
      severityGte: 13,
      bodyContains: "error",
    });

    expect(allResult.records.length).toBeGreaterThan(timeOnly.records.length);
    expect(timeOnly.records.length).toBeGreaterThanOrEqual(timeAndSev.records.length);
    expect(timeAndSev.records.length).toBeGreaterThanOrEqual(timeAndSevAndBody.records.length);
  });

  it("combines resource filtering with body predicate", () => {
    const resA: Resource = { attributes: [{ key: "service.name", value: "frontend" }] };
    const resB: Resource = { attributes: [{ key: "service.name", value: "backend" }] };
    const store = new LogStore({ rowsPerChunk: 4 });
    store.append(resA, scope, rec({ timeUnixNano: 1n, body: "user clicked button" }));
    store.append(resA, scope, rec({ timeUnixNano: 2n, body: "page rendered" }));
    store.append(resB, scope, rec({ timeUnixNano: 3n, body: "user query executed" }));
    store.append(resB, scope, rec({ timeUnixNano: 4n, body: "db connection pool" }));
    store.flush();

    const result = query(store, {
      resourceEquals: { "service.name": "backend" },
      bodyContains: "user",
    });
    expect(result.records.length).toBe(1);
    expect(result.records[0]?.body).toBe("user query executed");
  });
});

describe("query correctness: body-only fast path equivalence", () => {
  it("bodyContains fast path produces identical results to full scan + filter", () => {
    const { store } = buildMultiChunkStore();
    const needle = "gateway";

    // Query with bodyContains (uses fast path)
    const fastResult = query(store, { bodyContains: needle });

    // Manually collect all records and filter
    const allResult = query(store, {});
    const expected = allResult.records.filter(
      (r) => typeof r.body === "string" && r.body.includes(needle)
    );

    expect(fastResult.records.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(fastResult.records[i]?.timeUnixNano).toBe(expected[i]?.timeUnixNano);
      expect(fastResult.records[i]?.body).toBe(expected[i]?.body);
    }
  });

  it("combined time+bodyContains fast path still correct", () => {
    const { store } = buildMultiChunkStore();
    const result = query(store, {
      range: { from: 2000n, to: 4000n },
      bodyContains: "gateway",
    });
    for (const r of result.records) {
      expect(Number(r.timeUnixNano)).toBeGreaterThanOrEqual(2000);
      expect(Number(r.timeUnixNano)).toBeLessThan(4000);
      expect(r.body).toContain("gateway");
    }
  });
});

describe("query correctness: limit", () => {
  it("limit=1 returns exactly first matching record", () => {
    const { store } = buildMultiChunkStore();
    const unlimited = query(store, { bodyContains: "error" });
    const limited = query(store, { bodyContains: "error", limit: 1 });
    expect(limited.records.length).toBe(1);
    expect(limited.records[0]?.timeUnixNano).toBe(unlimited.records[0]?.timeUnixNano);
  });

  it("limit at exact boundary returns correct count", () => {
    const { store } = buildMultiChunkStore();
    const unlimited = query(store, { bodyContains: "error" });
    const count = unlimited.records.length;
    // limit = exact count should yield same results
    const limited = query(store, { bodyContains: "error", limit: count });
    expect(limited.records.length).toBe(count);
  });

  it("limit greater than matches returns all matches", () => {
    const { store } = buildMultiChunkStore();
    const unlimited = query(store, { bodyContains: "error" });
    const limited = query(store, { bodyContains: "error", limit: 9999 });
    expect(limited.records.length).toBe(unlimited.records.length);
  });
});

describe("query correctness: queryStream equivalence", () => {
  it("queryStream produces same results as query()", () => {
    const { store } = buildMultiChunkStore();
    const spec: QuerySpec = { bodyContains: "accepted", severityGte: 9 };
    const syncResult = query(store, spec);

    const streamRecords: LogRecord[] = [];
    for (const r of queryStream(store, spec)) {
      streamRecords.push(r);
    }
    expect(streamRecords.length).toBe(syncResult.records.length);
    for (let i = 0; i < syncResult.records.length; i++) {
      expect(streamRecords[i]?.timeUnixNano).toBe(syncResult.records[i]?.timeUnixNano);
      expect(streamRecords[i]?.body).toBe(syncResult.records[i]?.body);
    }
  });

  it("queryStream can be stopped early via break", () => {
    const { store } = buildMultiChunkStore();
    const records: LogRecord[] = [];
    for (const r of queryStream(store, {})) {
      records.push(r);
      if (records.length >= 3) break;
    }
    expect(records.length).toBe(3);
  });
});

describe("query correctness: API shape regression", () => {
  it("query accepts (store, spec) signature — not the old 4-arg form", () => {
    const { store } = buildMultiChunkStore();
    // This must compile and run: exactly 2 args
    const result = query(store, { bodyContains: "error" });
    expect(result.records).toBeDefined();
    expect(result.stats).toBeDefined();
  });

  it("QueryResult has records and stats fields", () => {
    const { store } = buildMultiChunkStore();
    const result = query(store, {});
    expect(Array.isArray(result.records)).toBe(true);
    expect(typeof result.stats.chunksScanned).toBe("number");
    expect(typeof result.stats.chunksPruned).toBe("number");
    expect(typeof result.stats.recordsScanned).toBe("number");
    expect(typeof result.stats.recordsEmitted).toBe("number");
    expect(typeof result.stats.streamsScanned).toBe("number");
    expect(typeof result.stats.streamsPruned).toBe("number");
  });
});
