// @ts-nocheck
import { describe, expect, it } from "vitest";
import { generateLogs } from "../js/data-gen.js";
import {
  createStore,
  getChunkDetails,
  getServiceBreakdown,
  getStoreStats,
  ingestRecords,
} from "../js/storage-model.js";

describe("storage-model", () => {
  function makeStore(count = 500) {
    const { records } = generateLogs({ count, durationMinutes: 5 });
    const store = createStore({ rowsPerChunk: 128 });
    ingestRecords(store, records);
    return store;
  }

  it("creates a store and ingests records", () => {
    const { records } = generateLogs({ count: 100, durationMinutes: 5 });
    const store = createStore();
    const result = ingestRecords(store, records);
    expect(result.recordsIngested).toBe(100);
    expect(result.ingestTimeMs).toBeGreaterThan(0);
    expect(result.logsPerSecond).toBeGreaterThan(0);
  });

  it("getStoreStats returns valid metrics", () => {
    const store = makeStore(300);
    const stats = getStoreStats(store);
    expect(stats.totalLogs).toBe(300);
    expect(stats.streams).toBeGreaterThan(0);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.totalChunkBytes).toBeGreaterThan(0);
    expect(stats.bytesPerLog).toBeGreaterThan(0);
    expect(stats.compressionRatio).toBeGreaterThan(0);
  });

  it("getChunkDetails returns per-chunk info", () => {
    const store = makeStore(500);
    const chunks = getChunkDetails(store);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.service).toBeTruthy();
      expect(c.nLogs).toBeGreaterThan(0);
      expect(c.totalBytes).toBeGreaterThan(0);
      expect(c.timeRange.min).toBeTruthy();
      expect(c.timeRange.max).toBeTruthy();
    }
  });

  it("getServiceBreakdown shows all services", () => {
    const store = makeStore(1000);
    const services = getServiceBreakdown(store);
    expect(services.length).toBe(6);
    for (const s of services) {
      expect(s.name).toBeTruthy();
      expect(s.logs).toBeGreaterThan(0);
      expect(s.bytes).toBeGreaterThan(0);
      expect(s.chunks).toBeGreaterThan(0);
    }
    const totalLogs = services.reduce((s, x) => s + x.logs, 0);
    expect(totalLogs).toBe(1000);
  });

  it("round-trips records through the engine", () => {
    const { records } = generateLogs({ count: 50, durationMinutes: 5 });
    const store = createStore({ rowsPerChunk: 50 });
    ingestRecords(store, records);
    store.flush();

    // Read records back via the engine's iterator
    let decoded = 0;
    for (const { records: chunk } of store.iterRecords()) {
      decoded += chunk.length;
    }
    expect(decoded).toBe(50);
  });
});
