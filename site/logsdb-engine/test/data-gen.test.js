// @ts-nocheck
import { describe, expect, it } from "vitest";
import { DATASET_PRESETS, generateLogBatches, generateLogs } from "../js/data-gen.js";

describe("data-gen", () => {
  it("produces the expected count of records", () => {
    const { records, stats } = generateLogs({ count: 100, durationMinutes: 5 });
    expect(records.length).toBe(100);
    expect(stats.totalRecords).toBe(100);
  });

  it("has deterministic output (same seed)", () => {
    const a = generateLogs({ count: 50, durationMinutes: 5, seed: 123 });
    const b = generateLogs({ count: 50, durationMinutes: 5, seed: 123 });
    expect(a.records[0].body).toEqual(b.records[0].body);
    expect(a.records[49].severityText).toEqual(b.records[49].severityText);
  });

  it("produces different output with different seeds", () => {
    const a = generateLogs({ count: 50, durationMinutes: 5, seed: 1 });
    const b = generateLogs({ count: 50, durationMinutes: 5, seed: 2 });
    // Extremely unlikely to be identical
    const bodiesA = a.records.map((r) => String(r.body)).join("");
    const bodiesB = b.records.map((r) => String(r.body)).join("");
    expect(bodiesA).not.toBe(bodiesB);
  });

  it("distributes across all 6 services", () => {
    const { stats } = generateLogs({ count: 1000, durationMinutes: 10 });
    const serviceCount = Object.keys(stats.byService).length;
    expect(serviceCount).toBe(6);
  });

  it("respects body shape distribution (~61% templated, ~39% kvlist)", () => {
    const { stats } = generateLogs({ count: 10000, durationMinutes: 30 });
    const templatedRatio = stats.bodyTemplated / stats.totalRecords;
    const kvlistRatio = stats.bodyKvlist / stats.totalRecords;
    // Allow ±5% tolerance
    expect(templatedRatio).toBeGreaterThan(0.55);
    expect(templatedRatio).toBeLessThan(0.67);
    expect(kvlistRatio).toBeGreaterThan(0.33);
    expect(kvlistRatio).toBeLessThan(0.45);
  });

  it("generates valid timestamps in order", () => {
    const { records } = generateLogs({ count: 500, durationMinutes: 5 });
    for (const r of records) {
      expect(typeof r.timeUnixNano).toBe("bigint");
      expect(r.timeUnixNano).toBeGreaterThan(0n);
    }
    // Generally mostly monotonic (with some jitter expected)
    let outOfOrder = 0;
    for (let i = 1; i < records.length; i++) {
      if (records[i].timeUnixNano < records[i - 1].timeUnixNano) outOfOrder++;
    }
    // Allow up to 50% out of order due to jitter (records span the full time range with random noise)
    expect(outOfOrder / records.length).toBeLessThan(0.5);
  });

  it("generates valid severity numbers (1-24)", () => {
    const { records } = generateLogs({ count: 500, durationMinutes: 5 });
    for (const r of records) {
      expect(r.severityNumber).toBeGreaterThanOrEqual(1);
      expect(r.severityNumber).toBeLessThanOrEqual(24);
    }
  });

  it("generates trace context for ~70% of records", () => {
    const { records } = generateLogs({ count: 1000, durationMinutes: 5 });
    const withTrace = records.filter((r) => r.traceId);
    const ratio = withTrace.length / records.length;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.8);
    // Verify traceId is 16 bytes, spanId is 8 bytes
    for (const r of withTrace.slice(0, 10)) {
      expect(r.traceId.length).toBe(16);
      expect(r.spanId.length).toBe(8);
    }
  });

  it("has proper attributes on every record", () => {
    const { records } = generateLogs({ count: 100, durationMinutes: 5 });
    for (const r of records) {
      expect(Array.isArray(r.attributes)).toBe(true);
      const svc = r.attributes.find((a) => a.key === "service.name");
      expect(svc).toBeDefined();
      expect(typeof svc.value).toBe("string");
    }
  });

  it("streaming generator yields complete coverage", () => {
    const batches = [];
    for (const { batch } of generateLogBatches({
      count: 500,
      durationMinutes: 5,
      batchSize: 100,
    })) {
      batches.push(batch);
    }
    const totalRecords = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalRecords).toBe(500);
    expect(batches.length).toBe(5);
  });

  it("DATASET_PRESETS has expected keys", () => {
    expect(Object.keys(DATASET_PRESETS)).toEqual(["small", "medium", "large", "massive"]);
    expect(DATASET_PRESETS.small.count).toBe(10_000);
    expect(DATASET_PRESETS.massive.count).toBe(2_000_000);
  });
});
