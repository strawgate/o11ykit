/**
 * Tests for the selective sidecar decode optimization:
 * `decodeFilteredByBodyNeedle` skips JSON.parse of sidecar lines for
 * records whose bodies don't match the needle.
 */

import { defaultRegistry } from "stardb";
import { describe, expect, it } from "vitest";
import { readRecordsFilteredFromRaw, readRecordsFromRaw } from "../src/chunk.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import { LogStore } from "../src/engine.js";
import { query } from "../src/query.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "service.name", value: "api" }] };
const scope: InstrumentationScope = { name: "test" };
const registry = defaultRegistry();

function rec(body: string | Record<string, unknown>, sev = 9, ts = 0n): LogRecord {
  return {
    timeUnixNano: ts,
    severityNumber: sev,
    severityText: "INFO",
    body,
    attributes: [],
  };
}

function buildTypedStore(records: LogRecord[], rowsPerChunk = 64) {
  const store = new LogStore({
    rowsPerChunk,
    policyFactory: () => new TypedColumnarDrainPolicy(),
  });
  for (const r of records) store.append(resource, scope, r);
  store.flush();
  return store;
}

describe("decodeFilteredByBodyNeedle: correctness", () => {
  it("returns only records whose body contains the needle", () => {
    const records = [
      rec("connection established from 192.168.1.1", 9, 1n),
      rec("authentication failed for user bob", 9, 2n),
      rec("connection closed by 10.0.0.1", 9, 3n),
      rec("request completed in 42ms", 9, 4n),
    ];
    const store = buildTypedStore(records);
    const chunks = store.streams.chunksOf(store.streams.ids()[0]!);
    const chunk = chunks[0]!;
    const policy = store.policyFor(store.streams.ids()[0]!);
    const codec = registry.get(chunk.header.codecName);
    const raw = codec.decode(chunk.payload);

    const filtered = readRecordsFilteredFromRaw(raw, chunk.header, "connection", policy);
    const matches = filtered.filter((r) => r !== undefined);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.body).toContain("connection");
    expect(matches[1]!.body).toContain("connection");
  });

  it("returns empty sparse array when no bodies match", () => {
    const records = [rec("hello world", 9, 1n), rec("goodbye world", 9, 2n)];
    const store = buildTypedStore(records);
    const chunks = store.streams.chunksOf(store.streams.ids()[0]!);
    const chunk = chunks[0]!;
    const policy = store.policyFor(store.streams.ids()[0]!);
    const codec = registry.get(chunk.header.codecName);
    const raw = codec.decode(chunk.payload);

    const filtered = readRecordsFilteredFromRaw(raw, chunk.header, "NONEXISTENT", policy);
    const matches = filtered.filter((r) => r !== undefined);
    expect(matches).toHaveLength(0);
  });

  it("preserves sidecar fields (attributes, traceId, etc.) for matching records", () => {
    const store = new LogStore({
      rowsPerChunk: 64,
      policyFactory: () => new TypedColumnarDrainPolicy(),
    });
    const r: LogRecord = {
      timeUnixNano: 1n,
      severityNumber: 13,
      severityText: "WARN",
      body: "error in handler",
      attributes: [{ key: "method", value: "POST" }],
      traceId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      spanId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    store.append(resource, scope, r);
    store.append(resource, scope, rec("normal log", 9, 2n));
    store.flush();

    const chunks = store.streams.chunksOf(store.streams.ids()[0]!);
    const chunk = chunks[0]!;
    const policy = store.policyFor(store.streams.ids()[0]!);
    const codec = registry.get(chunk.header.codecName);
    const raw = codec.decode(chunk.payload);

    const filtered = readRecordsFilteredFromRaw(raw, chunk.header, "error", policy);
    const matches = filtered.filter((r) => r !== undefined);
    expect(matches).toHaveLength(1);
    const match = matches[0]!;
    expect(match.body).toBe("error in handler");
    expect(match.severityText).toBe("WARN");
    expect(match.attributes).toHaveLength(1);
    expect(match.attributes[0]!.key).toBe("method");
    expect(match.traceId).toBeDefined();
    expect(match.spanId).toBeDefined();
  });

  it("matches records identical to full decode + filter", () => {
    const records: LogRecord[] = [];
    for (let i = 0; i < 100; i++) {
      records.push(
        rec(
          i % 5 === 0 ? `error in service at step ${i}` : `processing item ${i} normally`,
          i % 10 === 0 ? 17 : 9,
          BigInt(i * 1000)
        )
      );
    }
    const store = buildTypedStore(records, 32);
    const needle = "error";

    // Full decode + filter (reference)
    const allRecords: LogRecord[] = [];
    for (const id of store.streams.ids()) {
      const policy = store.policyFor(id);
      for (const chunk of store.streams.chunksOf(id)) {
        const decoded = readRecordsFromRaw(
          registry.get(chunk.header.codecName).decode(chunk.payload),
          chunk.header,
          policy
        );
        for (const r of decoded) {
          if (typeof r.body === "string" && r.body.includes(needle)) allRecords.push(r);
        }
      }
    }

    // Filtered decode
    const filteredRecords: LogRecord[] = [];
    for (const id of store.streams.ids()) {
      const policy = store.policyFor(id);
      for (const chunk of store.streams.chunksOf(id)) {
        const raw = registry.get(chunk.header.codecName).decode(chunk.payload);
        const filtered = readRecordsFilteredFromRaw(raw, chunk.header, needle, policy);
        for (const r of filtered) {
          if (r !== undefined) filteredRecords.push(r);
        }
      }
    }

    expect(filteredRecords).toHaveLength(allRecords.length);
    for (let i = 0; i < allRecords.length; i++) {
      expect(filteredRecords[i]!.body).toBe(allRecords[i]!.body);
      expect(filteredRecords[i]!.timeUnixNano).toBe(allRecords[i]!.timeUnixNano);
      expect(filteredRecords[i]!.severityNumber).toBe(allRecords[i]!.severityNumber);
    }
  });
});

describe("decodeFilteredByBodyNeedle: template-literal shortcut", () => {
  it("matches records where needle is in template literal", () => {
    // All records share a template with "sshd" as a literal token
    const records = [
      rec("sshd[1234]: Accepted publickey for user1", 9, 1n),
      rec("sshd[5678]: Failed password for user2", 9, 2n),
      rec("cron[9999]: running daily job", 9, 3n),
    ];
    const store = buildTypedStore(records);
    const chunks = store.streams.chunksOf(store.streams.ids()[0]!);
    const chunk = chunks[0]!;
    const policy = store.policyFor(store.streams.ids()[0]!);
    const codec = registry.get(chunk.header.codecName);
    const raw = codec.decode(chunk.payload);

    // "ssh" is a substring of the template literal "sshd" — definite match
    const filtered = readRecordsFilteredFromRaw(raw, chunk.header, "ssh", policy);
    const matches = filtered.filter((r) => r !== undefined);
    // Both sshd records should match (ssh is in "sshd")
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) {
      expect(typeof m.body === "string" && m.body.includes("ssh")).toBe(true);
    }
  });

  it("handles needle in variable values (not in template literal)", () => {
    // Template: "user <*> logged in from <*>"
    // Needle: "admin" — only in variable position
    const records = [
      rec("user admin logged in from 192.168.1.1", 9, 1n),
      rec("user guest logged in from 10.0.0.1", 9, 2n),
    ];
    const store = buildTypedStore(records);
    const chunks = store.streams.chunksOf(store.streams.ids()[0]!);
    const chunk = chunks[0]!;
    const policy = store.policyFor(store.streams.ids()[0]!);
    const codec = registry.get(chunk.header.codecName);
    const raw = codec.decode(chunk.payload);

    const filtered = readRecordsFilteredFromRaw(raw, chunk.header, "admin", policy);
    const matches = filtered.filter((r) => r !== undefined);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.body).toContain("admin");
  });
});

describe("decodeFilteredByBodyNeedle: non-string bodies", () => {
  it("does not match non-string bodies", () => {
    const store = new LogStore({
      rowsPerChunk: 64,
      policyFactory: () => new TypedColumnarDrainPolicy(),
    });
    store.append(resource, scope, rec("text with map in it", 9, 1n));
    store.append(resource, scope, rec({ key: "map value" }, 9, 2n));
    store.flush();

    const chunks = store.streams.chunksOf(store.streams.ids()[0]!);
    const chunk = chunks[0]!;
    const policy = store.policyFor(store.streams.ids()[0]!);
    const codec = registry.get(chunk.header.codecName);
    const raw = codec.decode(chunk.payload);

    const filtered = readRecordsFilteredFromRaw(raw, chunk.header, "map", policy);
    const matches = filtered.filter((r) => r !== undefined);
    // Only the string body "text with map in it" should match
    expect(matches).toHaveLength(1);
    expect(matches[0]!.body).toBe("text with map in it");
  });
});

describe("query engine integration with filtered decode", () => {
  it("bodyContains query uses filtered decode and returns correct results", () => {
    const records: LogRecord[] = [];
    for (let i = 0; i < 200; i++) {
      records.push(
        rec(
          i % 10 === 0 ? `CRITICAL error at step ${i}` : `normal operation ${i}`,
          i % 10 === 0 ? 21 : 9,
          BigInt(i * 1000)
        )
      );
    }
    const store = buildTypedStore(records, 32);
    const result = query(store, { bodyContains: "CRITICAL" });
    expect(result.records).toHaveLength(20); // every 10th record
    for (const r of result.records) {
      expect(typeof r.body === "string" && r.body.includes("CRITICAL")).toBe(true);
    }
  });

  it("bodyContains + time range uses filtered decode correctly", () => {
    const records: LogRecord[] = [];
    for (let i = 0; i < 100; i++) {
      records.push(rec(i % 5 === 0 ? `error at step ${i}` : `ok step ${i}`, 9, BigInt(i * 1000)));
    }
    const store = buildTypedStore(records, 32);
    const result = query(store, {
      bodyContains: "error",
      range: { from: 0n, to: 50_000n },
    });
    // First 50 records (0..49), every 5th has "error": 0,5,10,15,20,25,30,35,40,45 = 10
    expect(result.records).toHaveLength(10);
    for (const r of result.records) {
      expect(typeof r.body === "string" && r.body.includes("error")).toBe(true);
      expect(r.timeUnixNano).toBeLessThan(50_000n);
    }
  });

  it("bodyContains + severity uses filtered decode correctly", () => {
    const records: LogRecord[] = [];
    for (let i = 0; i < 64; i++) {
      const hasError = i % 4 === 0;
      const isWarn = i % 3 === 0;
      records.push(
        rec(
          hasError ? `error processing request ${i}` : `success for request ${i}`,
          isWarn ? 13 : 9,
          BigInt(i * 1000)
        )
      );
    }
    const store = buildTypedStore(records);
    const result = query(store, { bodyContains: "error", severityGte: 13 });
    // Records that have "error" in body AND severity >= 13
    for (const r of result.records) {
      expect(typeof r.body === "string" && r.body.includes("error")).toBe(true);
      expect(r.severityNumber).toBeGreaterThanOrEqual(13);
    }
  });

  it("stats.recordsScanned counts all records in decoded chunks", () => {
    const records: LogRecord[] = [];
    for (let i = 0; i < 64; i++) {
      records.push(rec(i === 0 ? "needle_xyz here" : `other ${i}`, 9, BigInt(i * 1000)));
    }
    const store = buildTypedStore(records);
    const result = query(store, { bodyContains: "needle_xyz" });
    expect(result.records).toHaveLength(1);
    expect(result.stats.recordsScanned).toBe(64);
  });
});
