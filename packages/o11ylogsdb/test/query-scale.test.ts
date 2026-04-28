import { describe, expect, it } from "vitest";

import { LogStore } from "../src/engine.js";
import { query } from "../src/query.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
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

function build10kStore(): {
  store: LogStore;
  resources: Resource[];
  rareCount: number;
  commonCount: number;
} {
  const resources: Resource[] = [
    { attributes: [{ key: "service.name", value: "api" }] },
    { attributes: [{ key: "service.name", value: "worker" }] },
    { attributes: [{ key: "service.name", value: "gateway" }] },
  ];
  const store = new LogStore({
    rowsPerChunk: 32,
    policy: new TypedColumnarDrainPolicy(),
  });

  let rareCount = 0;
  let commonCount = 0;

  for (let i = 0; i < 10_000; i++) {
    const resource = resources[i % 3] as Resource;
    let body: string;
    let severity: number;

    if (i % 1000 === 0) {
      // Rare: only 10 occurrences
      body = `CRITICAL_FAILURE in subsystem alpha at index ${i}`;
      severity = 21;
      rareCount++;
    } else if (i % 5 === 0) {
      // Common: 2000 occurrences (every 5th that isn't every 1000th)
      body = `request completed successfully in ${i}ms`;
      severity = 9;
      commonCount++;
    } else {
      body = `processing item ${i} in batch queue`;
      severity = i % 10 < 3 ? 13 : 9;
    }

    store.append(resource, scope, rec({ timeUnixNano: BigInt(i * 1000), body, severityNumber: severity }));
  }
  store.flush();
  return { store, resources, rareCount, commonCount };
}

describe("query at scale: hit counts", () => {
  it("returns correct total count with no filters on 10K records", () => {
    const { store } = build10kStore();
    const result = query(store, {});
    expect(result.records.length).toBe(10_000);
    expect(result.stats.recordsEmitted).toBe(10_000);
  });

  it("selective query (rare needle) returns exact match count", () => {
    const { store, rareCount } = build10kStore();
    const result = query(store, { bodyContains: "CRITICAL_FAILURE" });
    expect(result.records.length).toBe(rareCount);
  });

  it("non-selective query (common needle) returns exact match count", () => {
    const { store, commonCount } = build10kStore();
    const result = query(store, { bodyContains: "request completed" });
    expect(result.records.length).toBe(commonCount);
  });

  it("resource filter isolates stream correctly across 10K records", () => {
    const { store } = build10kStore();
    const allResult = query(store, {});
    const result = query(store, { resourceEquals: { "service.name": "api" } });
    // api stream gets every 3rd record starting at index 0: indices 0, 3, 6, ...
    // With round-robin assignment, each of 3 streams gets ~3333 records
    expect(result.records.length).toBeGreaterThan(3000);
    expect(result.records.length).toBeLessThan(allResult.records.length);
  });
});

describe("query at scale: time-range pruning", () => {
  it("time-range prunes chunks that are out of bounds", () => {
    const { store } = build10kStore();
    // First 1000 records: t = 0..999000
    const result = query(store, { range: { from: 0n, to: 100_000n } });
    // Should have pruned most chunks (those covering later time ranges)
    expect(result.stats.chunksPruned).toBeGreaterThan(0);
    // All returned records must be in range
    for (const r of result.records) {
      expect(Number(r.timeUnixNano)).toBeLessThan(100_000);
    }
  });

  it("narrow time range prunes most chunks", () => {
    const { store } = build10kStore();
    // Very narrow range: only a few records
    const result = query(store, { range: { from: 5_000_000n, to: 5_100_000n } });
    // With 10K records over 0..9_999_000, and 32 rows/chunk = ~313 chunks total
    // A range of 100K ns covers ~100 records → ~3 chunks scanned
    expect(result.stats.chunksPruned).toBeGreaterThan(result.stats.chunksScanned - 10);
    for (const r of result.records) {
      expect(Number(r.timeUnixNano)).toBeGreaterThanOrEqual(5_000_000);
      expect(Number(r.timeUnixNano)).toBeLessThan(5_100_000);
    }
  });

  it("range covering all data prunes nothing", () => {
    const { store } = build10kStore();
    const result = query(store, { range: { from: 0n, to: 99_999_999n } });
    expect(result.records.length).toBe(10_000);
    expect(result.stats.chunksPruned).toBe(0);
  });
});

describe("query at scale: severity pruning", () => {
  it("prunes chunks whose max severity is below threshold", () => {
    const { store } = build10kStore();
    // severity 21 only at every 1000th record — most chunks have max <= 13
    const result = query(store, { severityGte: 21 });
    expect(result.records.length).toBe(10); // 10K / 1000 = 10
    // chunks scanned should be less than total because some get pruned
    expect(result.stats.chunksPruned).toBeGreaterThan(0);
  });

  it("severity filter that passes all chunks prunes none", () => {
    const { store } = build10kStore();
    const result = query(store, { severityGte: 1 });
    expect(result.records.length).toBe(10_000);
    expect(result.stats.chunksPruned).toBe(0);
  });
});

describe("query at scale: stats accuracy", () => {
  it("chunksScanned equals total chunks when no streams pruned", () => {
    const { store } = build10kStore();
    const allResult = query(store, {});
    const totalChunks = allResult.stats.chunksScanned;

    // A time-range query that doesn't prune streams should still see all chunks
    const result = query(store, { range: { from: 0n, to: 500_000n } });
    // chunksScanned counts every chunk visited; chunksPruned is a subset
    expect(result.stats.chunksScanned).toBe(totalChunks);
    expect(result.stats.chunksPruned).toBeLessThanOrEqual(result.stats.chunksScanned);
    expect(result.stats.chunksPruned).toBeGreaterThan(0);
  });

  it("streamsScanned equals total streams and streamsPruned is subset", () => {
    const { store } = build10kStore();
    const totalStreams = store.streams.size();
    const result = query(store, { resourceEquals: { "service.name": "api" } });
    // streamsScanned counts every stream visited; streamsPruned is a subset
    expect(result.stats.streamsScanned).toBe(totalStreams);
    // With 3 resources, filtering to one should prune the other 2
    expect(result.stats.streamsPruned).toBe(totalStreams - 1);
  });

  it("recordsEmitted <= recordsScanned", () => {
    const { store } = build10kStore();
    const result = query(store, { severityGte: 13 });
    expect(result.stats.recordsEmitted).toBeLessThanOrEqual(result.stats.recordsScanned);
    expect(result.stats.recordsEmitted).toBe(result.records.length);
  });
});
