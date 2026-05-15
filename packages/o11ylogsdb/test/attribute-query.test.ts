/**
 * Tests for the `attributeEquals` query predicate.
 */

import { describe, expect, it } from "vitest";
import type { OtlpLogsDocument } from "../src/index.js";
import { ingestOtlpLogs, LogStore, query } from "../src/index.js";

const DOC: OtlpLogsDocument = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "orders" } }],
      },
      scopeLogs: [
        {
          scope: { name: "http" },
          logRecords: [
            {
              timeUnixNano: "1700000001000000000",
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "GET /orders 200" },
              attributes: [
                { key: "http.method", value: { stringValue: "GET" } },
                { key: "http.route", value: { stringValue: "/orders" } },
                { key: "http.status_code", value: { intValue: 200 } },
              ],
            },
            {
              timeUnixNano: "1700000002000000000",
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "POST /orders 201" },
              attributes: [
                { key: "http.method", value: { stringValue: "POST" } },
                { key: "http.route", value: { stringValue: "/orders" } },
                { key: "http.status_code", value: { intValue: 201 } },
              ],
            },
            {
              timeUnixNano: "1700000003000000000",
              severityNumber: 17,
              severityText: "ERROR",
              body: { stringValue: "DELETE /orders/5 403" },
              attributes: [
                { key: "http.method", value: { stringValue: "DELETE" } },
                { key: "http.route", value: { stringValue: "/orders/:id" } },
                { key: "http.status_code", value: { intValue: 403 } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("attributeEquals predicate", () => {
  function makeStore() {
    const store = new LogStore({ rowsPerChunk: 100 });
    ingestOtlpLogs(store, DOC);
    store.flush();
    return store;
  }

  it("filters by single string attribute", () => {
    const store = makeStore();
    const result = query(store, { attributeEquals: { "http.method": "GET" } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.body).toBe("GET /orders 200");
  });

  it("filters by multiple attributes (AND semantics)", () => {
    const store = makeStore();
    const result = query(store, {
      attributeEquals: { "http.method": "POST", "http.route": "/orders" },
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.body).toBe("POST /orders 201");
  });

  it("returns empty when attribute value does not match", () => {
    const store = makeStore();
    const result = query(store, { attributeEquals: { "http.method": "PATCH" } });
    expect(result.records).toHaveLength(0);
  });

  it("returns empty when attribute key does not exist", () => {
    const store = makeStore();
    const result = query(store, { attributeEquals: { "nonexistent.key": "value" } });
    expect(result.records).toHaveLength(0);
  });

  it("combines with severity filter", () => {
    const store = makeStore();
    const result = query(store, {
      attributeEquals: { "http.route": "/orders/:id" },
      severityGte: 17,
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.body).toBe("DELETE /orders/5 403");
  });

  it("combines with bodyContains", () => {
    const store = makeStore();
    const result = query(store, {
      bodyContains: "200",
      attributeEquals: { "http.method": "GET" },
    });
    expect(result.records).toHaveLength(1);
  });
});
