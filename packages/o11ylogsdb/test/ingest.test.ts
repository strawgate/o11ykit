/**
 * Tests for the OTLP ingest bridge (`ingest.ts`).
 */

import { describe, expect, it } from "vitest";
import type { OtlpLogsDocument } from "../src/index.js";
import { ingestOtlpLogs, iterOtlpLogRecords, LogStore, query } from "../src/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const MINIMAL_DOC: OtlpLogsDocument = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "checkout" } }],
      },
      scopeLogs: [
        {
          scope: { name: "my-library", version: "1.2.3" },
          logRecords: [
            {
              timeUnixNano: "1700000000000000000",
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "Order placed successfully" },
              attributes: [
                { key: "order.id", value: { stringValue: "abc-123" } },
                { key: "user.id", value: { intValue: "42" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const MULTI_RECORD_DOC: OtlpLogsDocument = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "api" } }],
      },
      scopeLogs: [
        {
          scope: { name: "http" },
          logRecords: [
            {
              timeUnixNano: "1700000001000000000",
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "GET /users 200 45ms" },
              attributes: [
                { key: "http.method", value: { stringValue: "GET" } },
                { key: "http.status_code", value: { intValue: 200 } },
              ],
            },
            {
              timeUnixNano: "1700000002000000000",
              severityNumber: 13,
              severityText: "WARN",
              body: { stringValue: "GET /users 429 rate limited" },
              attributes: [
                { key: "http.method", value: { stringValue: "GET" } },
                { key: "http.status_code", value: { intValue: 429 } },
              ],
            },
            {
              timeUnixNano: "1700000003000000000",
              severityNumber: 17,
              severityText: "ERROR",
              body: { stringValue: "POST /orders 500 internal error" },
              attributes: [
                { key: "http.method", value: { stringValue: "POST" } },
                { key: "http.status_code", value: { intValue: 500 } },
              ],
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: "b7ad6b7169203331",
              flags: 1,
            },
          ],
        },
      ],
    },
  ],
};

const KVLIST_BODY_DOC: OtlpLogsDocument = {
  resourceLogs: [
    {
      resource: { attributes: [] },
      scopeLogs: [
        {
          scope: { name: "structured" },
          logRecords: [
            {
              timeUnixNano: "1700000000000000000",
              severityNumber: 9,
              severityText: "INFO",
              body: {
                kvlistValue: {
                  values: [
                    { key: "action", value: { stringValue: "login" } },
                    { key: "duration_ms", value: { doubleValue: 42.5 } },
                  ],
                },
              },
              attributes: [],
            },
          ],
        },
      ],
    },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────

describe("ingestOtlpLogs", () => {
  it("ingests a minimal document", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    const result = ingestOtlpLogs(store, MINIMAL_DOC);

    expect(result.recordsIngested).toBe(1);
    store.flush();
    const stats = store.stats();
    expect(stats.totalLogs).toBe(1);
    expect(stats.streams).toBe(1);
  });

  it("preserves timestamp as bigint", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, MINIMAL_DOC);
    store.flush();

    const records = [...store.iterRecords()].flatMap((s) => s.records);
    expect(records[0]!.timeUnixNano).toBe(1700000000000000000n);
  });

  it("converts string body", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, MINIMAL_DOC);
    store.flush();

    const records = [...store.iterRecords()].flatMap((s) => s.records);
    expect(records[0]!.body).toBe("Order placed successfully");
  });

  it("converts attributes to KeyValue[]", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, MINIMAL_DOC);
    store.flush();

    const records = [...store.iterRecords()].flatMap((s) => s.records);
    const attrs = records[0]!.attributes;
    expect(attrs).toHaveLength(2);
    expect(attrs[0]).toEqual({ key: "order.id", value: "abc-123" });
    expect(attrs[1]).toEqual({ key: "user.id", value: 42n });
  });

  it("ingests multiple records across a batch", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    const result = ingestOtlpLogs(store, MULTI_RECORD_DOC);

    expect(result.recordsIngested).toBe(3);
    store.flush();
    expect(store.stats().totalLogs).toBe(3);
  });

  it("converts trace_id and span_id hex to Uint8Array", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, MULTI_RECORD_DOC);
    store.flush();

    const records = [...store.iterRecords()].flatMap((s) => s.records);
    const errorRecord = records.find((r) => r.severityNumber === 17)!;
    expect(errorRecord.traceId).toBeInstanceOf(Uint8Array);
    expect(errorRecord.traceId!.length).toBe(16);
    expect(errorRecord.spanId).toBeInstanceOf(Uint8Array);
    expect(errorRecord.spanId!.length).toBe(8);
    expect(errorRecord.flags).toBe(1);
  });

  it("converts KVList body to object AnyValue", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, KVLIST_BODY_DOC);
    store.flush();

    const records = [...store.iterRecords()].flatMap((s) => s.records);
    expect(records[0]!.body).toEqual({ action: "login", duration_ms: 42.5 });
  });

  it("handles missing optional fields gracefully", () => {
    const doc: OtlpLogsDocument = {
      resourceLogs: [
        {
          resource: undefined,
          scopeLogs: [
            {
              scope: undefined,
              logRecords: [
                {
                  timeUnixNano: "1700000000000000000",
                  body: { stringValue: "bare record" },
                },
              ],
            },
          ],
        },
      ],
    };

    const store = new LogStore({ rowsPerChunk: 100 });
    const result = ingestOtlpLogs(store, doc);
    expect(result.recordsIngested).toBe(1);
    store.flush();

    const records = [...store.iterRecords()].flatMap((s) => s.records);
    expect(records[0]!.body).toBe("bare record");
    expect(records[0]!.severityNumber).toBe(9); // default INFO
  });

  it("handles numeric timeUnixNano", () => {
    const doc: OtlpLogsDocument = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: 1700000000000,
                  severityNumber: 5,
                  severityText: "DEBUG",
                  body: { stringValue: "numeric ts" },
                },
              ],
            },
          ],
        },
      ],
    };

    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, doc);
    store.flush();

    const records = [...store.iterRecords()].flatMap((s) => s.records);
    expect(records[0]!.timeUnixNano).toBe(1700000000000n);
  });
});

describe("iterOtlpLogRecords", () => {
  it("yields resource, scope, and record for each log", () => {
    const items = [...iterOtlpLogRecords(MULTI_RECORD_DOC)];
    expect(items).toHaveLength(3);
    expect(items[0]!.resource.attributes[0]!.key).toBe("service.name");
    expect(items[0]!.scope.name).toBe("http");
    expect(items[0]!.record.body).toBe("GET /users 200 45ms");
  });
});

describe("ingest + query integration", () => {
  it("ingested records are queryable by body substring", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, MULTI_RECORD_DOC);
    store.flush();

    const result = query(store, { bodyContains: "rate limited" });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.severityNumber).toBe(13);
  });

  it("ingested records are queryable by severity", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, MULTI_RECORD_DOC);
    store.flush();

    const result = query(store, { severityGte: 13 });
    expect(result.records).toHaveLength(2); // WARN + ERROR
  });

  it("ingested records are queryable by resource attribute", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, MULTI_RECORD_DOC);
    store.flush();

    const result = query(store, { resourceEquals: { "service.name": "api" } });
    expect(result.records).toHaveLength(3);

    const miss = query(store, { resourceEquals: { "service.name": "web" } });
    expect(miss.records).toHaveLength(0);
  });

  it("ingested records are queryable by time range", () => {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, MULTI_RECORD_DOC);
    store.flush();

    const result = query(store, {
      range: { from: 1700000002000000000n, to: 1700000003000000001n },
    });
    expect(result.records).toHaveLength(2); // WARN + ERROR
  });
});
