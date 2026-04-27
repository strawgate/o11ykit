import { defaultRegistry } from "stardb";
import { describe, expect, it } from "vitest";
import { ChunkBuilder, type ChunkPolicy, DefaultChunkPolicy, readRecords } from "../src/chunk.js";
import { ColumnarDrainPolicy, ColumnarRawPolicy } from "../src/codec-columnar.js";
import { DrainChunkPolicy } from "../src/codec-drain.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "service.name", value: "test" }] };
const scope: InstrumentationScope = { name: "test-scope" };
const registry = defaultRegistry();

function makeRecords(): LogRecord[] {
  // Mix of templated lines (similar shape) and a varied body — exercises
  // every policy's body classifier path.
  const records: LogRecord[] = [];
  const userIds = ["alice", "bob", "carol", "dave", "eve"];
  for (let i = 0; i < 60; i++) {
    records.push({
      timeUnixNano: BigInt(1_000_000_000 + i * 1000),
      severityNumber: i % 3 === 0 ? 13 : 9,
      severityText: i % 3 === 0 ? "WARN" : "INFO",
      body: `user ${userIds[i % userIds.length]} request ${i} completed`,
      attributes: [{ key: "host", value: `node-${i % 3}` }],
    });
  }
  return records;
}

function freezeWith(policy: ChunkPolicy, records: readonly LogRecord[]) {
  const builder = new ChunkBuilder(resource, scope, policy, registry);
  for (const r of records) builder.append(r);
  return builder.freeze();
}

interface PolicyCase {
  name: string;
  make: () => ChunkPolicy;
}

const policies: PolicyCase[] = [
  { name: "DefaultChunkPolicy", make: () => new DefaultChunkPolicy() },
  { name: "ColumnarRawPolicy", make: () => new ColumnarRawPolicy() },
  { name: "ColumnarDrainPolicy", make: () => new ColumnarDrainPolicy() },
  { name: "DrainChunkPolicy", make: () => new DrainChunkPolicy() },
  { name: "TypedColumnarDrainPolicy", make: () => new TypedColumnarDrainPolicy() },
];

describe.each(policies)("$name", ({ make }) => {
  it("round-trips a templated-text chunk", () => {
    const policy = make();
    const records = makeRecords();
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    expect(decoded.length).toBe(records.length);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.timeUnixNano).toBe(records[i]?.timeUnixNano);
      expect(decoded[i]?.severityNumber).toBe(records[i]?.severityNumber);
      // Body is canonicalized through Drain whitespace normalization on
      // policies that template; our records have only single spaces, so
      // strict equality holds for the templated path too.
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("round-trips an empty chunk", () => {
    const policy = make();
    const chunk = freezeWith(policy, []);
    const decoded = readRecords(chunk, registry, policy);
    expect(decoded.length).toBe(0);
  });

  it("round-trips a single-record chunk", () => {
    const policy = make();
    const record: LogRecord = {
      timeUnixNano: 42n,
      severityNumber: 9,
      severityText: "INFO",
      body: "single record",
      attributes: [],
    };
    const chunk = freezeWith(policy, [record]);
    const decoded = readRecords(chunk, registry, policy);
    expect(decoded.length).toBe(1);
    expect(decoded[0]?.body).toBe(record.body);
    expect(decoded[0]?.timeUnixNano).toBe(record.timeUnixNano);
  });
});

describe("TypedColumnarDrainPolicy slot detectors", () => {
  it("round-trips PREFIXED_INT64 slots (e.g., blk_<int>)", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 80; i++) {
      records.push({
        timeUnixNano: BigInt(i),
        severityNumber: 9,
        severityText: "INFO",
        body: `block blk_${1_000_000 + i} replicated to node 7`,
        attributes: [],
      });
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    expect(decoded.length).toBe(records.length);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("round-trips UUID slots", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    const uuids = [
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440001",
      "550e8400-e29b-41d4-a716-446655440002",
    ];
    for (let i = 0; i < 80; i++) {
      records.push({
        timeUnixNano: BigInt(i),
        severityNumber: 9,
        severityText: "INFO",
        body: `request ${uuids[i % uuids.length]} accepted`,
        attributes: [],
      });
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("round-trips SIGNED_INT slots", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 80; i++) {
      records.push({
        timeUnixNano: BigInt(i),
        severityNumber: 9,
        severityText: "INFO",
        body: `processed ${i * 7 - 13} items in pool`,
        attributes: [],
      });
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("falls back to STRING for slots below the typed threshold", () => {
    // Below TYPED_SLOT_MIN_RECORDS=50; should still round-trip.
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push({
        timeUnixNano: BigInt(i),
        severityNumber: 9,
        severityText: "INFO",
        body: `block blk_${1_000_000 + i} replicated to node 7`,
        attributes: [],
      });
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });
});
