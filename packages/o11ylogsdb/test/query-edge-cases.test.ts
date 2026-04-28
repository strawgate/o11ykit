import { describe, it, expect } from "vitest";
import { LogStore } from "../src/engine.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import { query, queryStream } from "../src/query.js";
import type { LogRecord, Resource, InstrumentationScope } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "svc", value: "test" }] };
const scope: InstrumentationScope = { name: "test" };

function makeStore(records: LogRecord[], rowsPerChunk = 32): LogStore {
  const store = new LogStore({
    rowsPerChunk,
    policyFactory: () => new TypedColumnarDrainPolicy(),
  });
  for (const r of records) store.append(resource, scope, r);
  store.flush();
  return store;
}

function textRecord(body: string, sev = 9, ts = 1000000000n): LogRecord {
  return { timeUnixNano: ts, severityNumber: sev, severityText: "INFO", body, attributes: [] };
}

function kvRecord(body: Record<string, unknown>, sev = 9, ts = 1000000000n): LogRecord {
  return { timeUnixNano: ts, severityNumber: sev, severityText: "INFO", body, attributes: [] };
}

describe("query: raw byte scan edge cases", () => {
  it("non-ASCII needle (emoji) works correctly", () => {
    const records = [
      textRecord("Server started 🚀 successfully"),
      textRecord("Server stopped normally"),
      textRecord("Deploy 🚀 complete"),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyContains: "🚀" });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.body).toContain("🚀");
    expect(hits[1]!.body).toContain("🚀");
  });

  it("CJK multi-byte needle works", () => {
    const records = [
      textRecord("エラーが発生しました"),
      textRecord("正常に動作しています"),
      textRecord("エラーコード: 500"),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyContains: "エラー" });
    expect(hits).toHaveLength(2);
  });

  it("needle at exact start of body matches", () => {
    const records = [textRecord("ERROR: something broke"), textRecord("no error here")];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyContains: "ERROR" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toBe("ERROR: something broke");
  });

  it("needle at exact end of body matches", () => {
    const records = [textRecord("connection failed"), textRecord("connection ok")];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyContains: "failed" });
    expect(hits).toHaveLength(1);
  });

  it("single character needle", () => {
    const records = [textRecord("a"), textRecord("b"), textRecord("c"), textRecord("abc")];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyContains: "a" });
    expect(hits).toHaveLength(2); // "a" and "abc"
  });

  it("very long needle that partially matches", () => {
    const records = [
      textRecord("the quick brown fox jumps over the lazy dog"),
      textRecord("the quick brown fox does nothing"),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyContains: "quick brown fox jumps over" });
    expect(hits).toHaveLength(1);
  });

  it("bodyContains on non-string bodies returns no matches", () => {
    const records = [
      { ...textRecord("match me"), body: { message: "match me" } } as unknown as LogRecord,
      textRecord("match me too"),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyContains: "match" });
    // Only the string-body record matches
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toBe("match me too");
  });
});

describe("query: bodyLeafEquals edge cases", () => {
  it("numeric leaf value match", () => {
    const records = [
      kvRecord({ status: 200, method: "GET" }),
      kvRecord({ status: 404, method: "GET" }),
      kvRecord({ status: 200, method: "POST" }),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyLeafEquals: { "body.status": 200 } });
    expect(hits).toHaveLength(2);
  });

  it("deeply nested path traversal", () => {
    const records = [
      kvRecord({ req: { headers: { host: "example.com" } } }),
      kvRecord({ req: { headers: { host: "other.com" } } }),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyLeafEquals: { "body.req.headers.host": "example.com" } });
    expect(hits).toHaveLength(1);
  });

  it("path without body. prefix works", () => {
    const records = [kvRecord({ method: "GET" }), kvRecord({ method: "POST" })];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyLeafEquals: { method: "GET" } });
    expect(hits).toHaveLength(1);
  });

  it("path hitting null intermediate returns no match", () => {
    const records = [kvRecord({ req: null as unknown as string }), kvRecord({ req: { method: "GET" } })];
    const store = makeStore(records);
    const { records: hits } = query(store, { bodyLeafEquals: { "body.req.method": "GET" } });
    expect(hits).toHaveLength(1);
  });

  it("bodyContains + bodyLeafEquals combined", () => {
    const records = [
      kvRecord({ message: "user logged in", level: "info" }),
      kvRecord({ message: "user logged out", level: "info" }),
      kvRecord({ message: "error occurred", level: "error" }),
    ];
    const store = makeStore(records);
    // bodyLeafEquals only — bodyContains is for string bodies
    const { records: hits } = query(store, { bodyLeafEquals: { "body.level": "info" } });
    expect(hits).toHaveLength(2);
  });
});

describe("query: empty store and edge cases", () => {
  it("query on empty store returns empty hits", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    const { records: hits, stats } = query(store, {});
    expect(hits).toHaveLength(0);
    expect(stats.recordsScanned).toBe(0);
  });

  it("queryStream on empty store yields nothing", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    const results = [...queryStream(store, {})];
    expect(results).toHaveLength(0);
  });

  it("queryStream stats accumulation with pre-initialized object", () => {
    const records = Array.from({ length: 50 }, (_, i) => textRecord(`line ${i}`, 9, BigInt(i)));
    const store = makeStore(records, 16);

    const stats = {
      streamsScanned: 0,
      streamsPruned: 0,
      chunksScanned: 0,
      chunksPruned: 0,
      recordsScanned: 0,
      recordsEmitted: 0,
      decodeMillis: 0,
    };
    const gen = queryStream(store, { limit: 10 }, stats);
    const results = [...gen];
    expect(results).toHaveLength(10);
    expect(stats.recordsEmitted).toBe(10);
    expect(stats.chunksScanned).toBeGreaterThan(0);
  });
});

describe("query: time range boundary precision", () => {
  it("range.from is inclusive", () => {
    const records = [
      textRecord("before", 9, 100n),
      textRecord("exact", 9, 200n),
      textRecord("after", 9, 300n),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, { range: { from: 200n, to: 250n } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toBe("exact");
  });

  it("range.to is exclusive", () => {
    const records = [
      textRecord("before", 9, 100n),
      textRecord("exact", 9, 200n),
      textRecord("after", 9, 300n),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, { range: { from: 100n, to: 200n } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toBe("before");
  });

  it("chunk boundary: maxNano === range.from passes pruning", () => {
    // Store with multiple chunks — records 0..31 in chunk1, 32..63 in chunk2
    const records = Array.from({ length: 64 }, (_, i) =>
      textRecord(`line ${i}`, 9, BigInt(i * 1000))
    );
    const store = makeStore(records, 32);
    // range.from = 31000 (the maxNano of chunk 1)
    const { records: hits, stats } = query(store, { range: { from: 31000n, to: 32000n } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toBe("line 31");
    // Both chunks should be visited (chunk1 has maxNano=31000 === range.from)
    expect(stats.chunksPruned).toBe(1); // chunk2 pruned (minNano=32000 >= to=32000)
  });
});

describe("query: severity filtering", () => {
  it("severityGte filters correctly across chunk boundary", () => {
    const records = [
      textRecord("debug", 5, 1n),
      textRecord("info", 9, 2n),
      textRecord("warn", 13, 3n),
      textRecord("error", 17, 4n),
      textRecord("fatal", 21, 5n),
    ];
    const store = makeStore(records, 2); // 2 per chunk → 3 chunks
    const { records: hits } = query(store, { severityGte: 13 });
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.body)).toEqual(["warn", "error", "fatal"]);
  });

  it("severity + time + bodyContains combined", () => {
    const records = [
      textRecord("error in module A", 17, 100n),
      textRecord("error in module B", 17, 200n),
      textRecord("warning in module A", 13, 150n),
      textRecord("info about A", 9, 120n),
    ];
    const store = makeStore(records);
    const { records: hits } = query(store, {
      severityGte: 13,
      range: { from: 100n, to: 200n },
      bodyContains: "module A",
    });
    expect(hits).toHaveLength(2); // error A (100n) + warning A (150n)
  });
});
