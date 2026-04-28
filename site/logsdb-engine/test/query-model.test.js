// @ts-nocheck
import { describe, expect, it } from "vitest";
import { generateLogs } from "../js/data-gen.js";
import {
  buildQuerySpec,
  computeSeverityDistribution,
  computeServiceDistribution,
  createQueryState,
  executeQuery,
  formatBody,
  formatBodyPreview,
  formatTimestamp,
  severityColor,
  severityLabel,
} from "../js/query-model.js";
import { createStore, ingestRecords } from "../js/storage-model.js";

describe("query-model", () => {
  function makePopulatedStore(count = 500) {
    const { records } = generateLogs({ count, durationMinutes: 5 });
    const store = createStore({ rowsPerChunk: 128 });
    ingestRecords(store, records);
    return store;
  }

  describe("createQueryState", () => {
    it("returns default state with limit enabled", () => {
      const state = createQueryState();
      expect(state.limit.enabled).toBe(true);
      expect(state.limit.value).toBe(100);
      expect(state.severity.enabled).toBe(false);
      expect(state.bodyContains.enabled).toBe(false);
    });
  });

  describe("buildQuerySpec", () => {
    it("builds empty spec when nothing enabled", () => {
      const state = createQueryState();
      state.limit.enabled = false;
      const spec = buildQuerySpec(state);
      expect(spec).toEqual({});
    });

    it("includes severity filter when enabled", () => {
      const state = createQueryState();
      state.severity.enabled = true;
      state.severity.min = "ERROR";
      const spec = buildQuerySpec(state);
      expect(spec.severityGte).toBe(17);
    });

    it("includes body contains when enabled", () => {
      const state = createQueryState();
      state.bodyContains.enabled = true;
      state.bodyContains.value = "timeout";
      const spec = buildQuerySpec(state);
      expect(spec.bodyContains).toBe("timeout");
    });

    it("includes resource equals when enabled", () => {
      const state = createQueryState();
      state.resourceEquals.enabled = true;
      state.resourceEquals.key = "service.name";
      state.resourceEquals.value = "database";
      const spec = buildQuerySpec(state);
      expect(spec.resourceEquals).toEqual({ "service.name": "database" });
    });

    it("includes limit when enabled", () => {
      const state = createQueryState();
      state.limit.enabled = true;
      state.limit.value = 50;
      const spec = buildQuerySpec(state);
      expect(spec.limit).toBe(50);
    });
  });

  describe("executeQuery", () => {
    it("returns results with stats", () => {
      const store = makePopulatedStore(2000);
      const state = createQueryState();
      state.severity.enabled = true;
      state.severity.min = "WARN";
      const result = executeQuery(store, state);
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.records.length).toBeLessThanOrEqual(100);
      expect(result.stats.totalTimeMs).toBeDefined();
      expect(result.stats.chunksScanned).toBeGreaterThan(0);
      // All returned records should be WARN or above
      for (const r of result.records) {
        expect(r.severityNumber).toBeGreaterThanOrEqual(13);
      }
    });

    it("filters by service name", () => {
      const store = makePopulatedStore(1000);
      const state = createQueryState();
      state.resourceEquals.enabled = true;
      state.resourceEquals.key = "service.name";
      state.resourceEquals.value = "database";
      const result = executeQuery(store, state);
      expect(result.records.length).toBeGreaterThan(0);
    });

    it("filters by body substring", () => {
      const store = makePopulatedStore(1000);
      const state = createQueryState();
      state.bodyContains.enabled = true;
      state.bodyContains.value = "Deadlock";
      const result = executeQuery(store, state);
      for (const r of result.records) {
        expect(String(r.body)).toContain("Deadlock");
      }
    });
  });

  describe("formatting helpers", () => {
    it("severityLabel maps correctly", () => {
      expect(severityLabel(1)).toBe("TRACE");
      expect(severityLabel(9)).toBe("INFO");
      expect(severityLabel(13)).toBe("WARN");
      expect(severityLabel(17)).toBe("ERROR");
      expect(severityLabel(21)).toBe("FATAL");
    });

    it("severityColor returns valid colors", () => {
      expect(severityColor(1)).toContain("#");
      expect(severityColor(17)).toContain("#");
    });

    it("formatTimestamp produces ISO-like string", () => {
      const ts = 1714280000000000000n; // some nano timestamp
      const result = formatTimestamp(ts);
      expect(result).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("formatBody handles different types", () => {
      expect(formatBody("hello")).toBe("hello");
      expect(formatBody(null)).toBe("");
      expect(formatBody({ a: 1 })).toBe('{\n  "a": 1\n}');
      expect(formatBody(new Uint8Array(5))).toBe("<binary 5 bytes>");
    });

    it("formatBodyPreview truncates long strings", () => {
      const long = "a".repeat(200);
      const preview = formatBodyPreview(long, 50);
      expect(preview.length).toBeLessThanOrEqual(51); // 50 + "…"
    });
  });

  describe("distribution helpers", () => {
    it("computeSeverityDistribution counts correctly", () => {
      const records = [
        { severityNumber: 9 },
        { severityNumber: 9 },
        { severityNumber: 17 },
        { severityNumber: 21 },
      ];
      const dist = computeSeverityDistribution(records);
      expect(dist.INFO).toBe(2);
      expect(dist.ERROR).toBe(1);
      expect(dist.FATAL).toBe(1);
    });

    it("computeServiceDistribution groups by service", () => {
      const records = [
        { attributes: [{ key: "service.name", value: "a" }] },
        { attributes: [{ key: "service.name", value: "a" }] },
        { attributes: [{ key: "service.name", value: "b" }] },
      ];
      const dist = computeServiceDistribution(records);
      expect(dist.a).toBe(2);
      expect(dist.b).toBe(1);
    });
  });
});
