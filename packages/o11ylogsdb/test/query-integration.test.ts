import { describe, it, expect } from "vitest";
import { LogStore } from "../src/engine.js";
import { DefaultChunkPolicy, readRecords, readRecordsFromRaw } from "../src/chunk.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import { query, queryStream } from "../src/query.js";
import { defaultRegistry } from "stardb";
import type { LogRecord, Resource, InstrumentationScope } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "svc", value: "test" }] };
const scope: InstrumentationScope = { name: "test" };
const registry = defaultRegistry();

function textRecord(body: string, sev = 9, ts = 1000000000n): LogRecord {
  return { timeUnixNano: ts, severityNumber: sev, severityText: "INFO", body, attributes: [] };
}

describe("readRecordsFromRaw: correctness", () => {
  it("produces identical results to readRecords for NDJSON policy", () => {
    const policy = new DefaultChunkPolicy("zstd-3");
    const store = new LogStore({ rowsPerChunk: 16, policy });
    for (let i = 0; i < 10; i++) store.append(resource, scope, textRecord(`line ${i}`, 9, BigInt(i)));
    store.flush();

    const chunks = store.streams.chunksOf(store.streams.ids()[0]!);
    const chunk = chunks[0]!;

    // Standard path
    const standard = readRecords(chunk, registry, policy);

    // From-raw path (decompress manually, then decode)
    const codec = registry.get(chunk.header.codecName);
    const raw = codec.decode(chunk.payload);
    const fromRaw = readRecordsFromRaw(raw, chunk.header, policy);

    expect(fromRaw).toEqual(standard);
  });

  it("produces identical results to readRecords for TypedColumnar policy", () => {
    const policy = new TypedColumnarDrainPolicy();
    const store = new LogStore({ rowsPerChunk: 16, policyFactory: () => policy });
    for (let i = 0; i < 10; i++) store.append(resource, scope, textRecord(`log event ${i}`, 9, BigInt(i * 1000)));
    store.flush();

    const chunks = store.streams.chunksOf(store.streams.ids()[0]!);
    const chunk = chunks[0]!;

    const standard = readRecords(chunk, registry, policy);
    const codec = registry.get(chunk.header.codecName);
    const raw = codec.decode(chunk.payload);
    const fromRaw = readRecordsFromRaw(raw, chunk.header, policy);

    expect(fromRaw).toEqual(standard);
  });
});

describe("query engine: body fast path uses readRecordsFromRaw", () => {
  it("bodyContains on NDJSON store produces correct results", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    const records = [
      textRecord("user login from 192.168.1.1", 9, 1n),
      textRecord("user logout from 192.168.1.2", 9, 2n),
      textRecord("system heartbeat", 9, 3n),
      textRecord("user login from 10.0.0.1", 9, 4n),
    ];
    for (const r of records) store.append(resource, scope, r);
    store.flush();

    const { records: hits } = query(store, { bodyContains: "login" });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.body).toContain("login");
    expect(hits[1]!.body).toContain("login");
  });

  it("bodyContains + limit on NDJSON store", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    for (let i = 0; i < 50; i++) store.append(resource, scope, textRecord(`event ${i}`, 9, BigInt(i)));
    store.flush();

    const { records: hits, stats } = query(store, { bodyContains: "event", limit: 5 });
    expect(hits).toHaveLength(5);
    expect(stats.recordsEmitted).toBe(5);
  });

  it("bodyContains with no matches skips all chunks via raw scan", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    for (let i = 0; i < 50; i++) store.append(resource, scope, textRecord(`line ${i}`, 9, BigInt(i)));
    store.flush();

    const { records: hits, stats } = query(store, { bodyContains: "NONEXISTENT_xyz" });
    expect(hits).toHaveLength(0);
    expect(stats.chunksPruned).toBeGreaterThan(0);
    expect(stats.recordsScanned).toBe(0); // no records decoded
  });

  it("bodyContains combined with severity filter (uses standard path)", () => {
    const store = new LogStore({
      rowsPerChunk: 16,
      policyFactory: () => new TypedColumnarDrainPolicy(),
    });
    const records = [
      textRecord("error connecting to db", 17, 1n),
      textRecord("error parsing request", 17, 2n),
      textRecord("error in background job", 9, 3n), // low severity
      textRecord("all systems nominal", 17, 4n), // no "error" in body
    ];
    for (const r of records) store.append(resource, scope, r);
    store.flush();

    // bodyContains + severityGte: body fast path applies (bodyLeafEquals not set)
    const { records: hits } = query(store, { bodyContains: "error", severityGte: 17 });
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.body).toContain("error");
      expect(h.severityNumber).toBeGreaterThanOrEqual(17);
    }
  });
});

describe("query engine: resourceEquals stream pruning", () => {
  it("filters streams by resource attribute", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    const r1: Resource = { attributes: [{ key: "service", value: "api" }] };
    const r2: Resource = { attributes: [{ key: "service", value: "worker" }] };
    store.append(r1, scope, textRecord("api log 1", 9, 1n));
    store.append(r1, scope, textRecord("api log 2", 9, 2n));
    store.append(r2, scope, textRecord("worker log 1", 9, 3n));
    store.flush();

    const { records: hits, stats } = query(store, { resourceEquals: { service: "api" } });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.body).toBe("api log 1");
    expect(stats.streamsPruned).toBe(1);
  });

  it("resourceEquals with multiple keys requires all to match", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    const r1: Resource = { attributes: [{ key: "service", value: "api" }, { key: "env", value: "prod" }] };
    const r2: Resource = { attributes: [{ key: "service", value: "api" }, { key: "env", value: "dev" }] };
    store.append(r1, scope, textRecord("prod api", 9, 1n));
    store.append(r2, scope, textRecord("dev api", 9, 2n));
    store.flush();

    const { records: hits } = query(store, { resourceEquals: { service: "api", env: "prod" } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toBe("prod api");
  });

  it("resourceEquals with non-matching key prunes all streams", () => {
    const store = new LogStore({ rowsPerChunk: 16 });
    store.append(resource, scope, textRecord("test", 9, 1n));
    store.flush();

    const { records: hits, stats } = query(store, { resourceEquals: { nonexistent: "value" } });
    expect(hits).toHaveLength(0);
    expect(stats.streamsPruned).toBe(1);
    expect(stats.chunksScanned).toBe(0);
  });
});

describe("query engine: queryStream generator behavior", () => {
  it("generator stops after limit without decoding remaining chunks", () => {
    const store = new LogStore({
      rowsPerChunk: 4,
      policyFactory: () => new TypedColumnarDrainPolicy(),
    });
    // 20 records → 5 chunks of 4
    for (let i = 0; i < 20; i++) store.append(resource, scope, textRecord(`line ${i}`, 9, BigInt(i)));
    store.flush();

    const stats = {
      streamsScanned: 0, streamsPruned: 0,
      chunksScanned: 0, chunksPruned: 0,
      recordsScanned: 0, recordsEmitted: 0, decodeMillis: 0,
    };
    const gen = queryStream(store, { limit: 3 }, stats);
    const results = [...gen];
    expect(results).toHaveLength(3);
    // Should only have scanned 1 chunk (4 records) to get 3 results
    expect(stats.chunksScanned).toBe(1);
    expect(stats.recordsScanned).toBe(3); // stops after 3rd match
  });

  it("generator yields records in chunk order", () => {
    const store = new LogStore({ rowsPerChunk: 4 });
    for (let i = 0; i < 12; i++) store.append(resource, scope, textRecord(`line ${i}`, 9, BigInt(i)));
    store.flush();

    const results = [...queryStream(store, {})];
    expect(results).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      expect(results[i]!.body).toBe(`line ${i}`);
    }
  });
});
