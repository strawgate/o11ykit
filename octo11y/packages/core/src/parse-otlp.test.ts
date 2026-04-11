import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getOtlpMetricKind,
  getOtlpTemporality,
  otlpAttributesToRecord,
  parseOtlp,
} from "./parse-otlp.js";

function makeDocument() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "test-service" } },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "events_per_sec",
                unit: "events/sec",
                gauge: {
                  dataPoints: [
                    {
                      attributes: [
                        { key: "scenario", value: { stringValue: "json-ingest" } },
                      ],
                      timeUnixNano: "1711929600000000000",
                      asDouble: 13240.5,
                    },
                  ],
                },
              },
              {
                name: "cpu_user_pct",
                unit: "%",
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      attributes: [],
                      startTimeUnixNano: "1711929540000000000",
                      timeUnixNano: "1711929600000000000",
                      asDouble: 71.2,
                    },
                  ],
                },
              },
              {
                name: "request_latency_ms",
                unit: "ms",
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      attributes: [],
                      timeUnixNano: "1711929600000000000",
                      count: "15",
                      sum: 2148,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("parseOtlp", () => {
  it("parses a valid OTLP metrics document", () => {
    const parsed = parseOtlp(JSON.stringify(makeDocument()));
    assert.equal(parsed.resourceMetrics.length, 1);
    assert.equal(parsed.resourceMetrics[0].scopeMetrics?.[0].metrics?.length, 3);
  });

  it("throws when resourceMetrics is missing", () => {
    assert.throws(() => parseOtlp("{}"), /resourceMetrics/);
  });
});

describe("OTLP traversal helpers", () => {
  it("converts attributes to flat string records", () => {
    const record = otlpAttributesToRecord([
      { key: "a", value: { stringValue: "hello" } },
      { key: "b", value: { intValue: "42" } },
      { key: "c", value: { boolValue: true } },
    ]);
    assert.deepEqual(record, { a: "hello", b: "42", c: "true" });
  });

  it("reports metric kind and temporality", () => {
    const document = parseOtlp(JSON.stringify(makeDocument()));
    const metrics = document.resourceMetrics[0].scopeMetrics?.[0].metrics ?? [];
    assert.equal(getOtlpMetricKind(metrics[0]), "gauge");
    assert.equal(getOtlpMetricKind(metrics[1]), "sum");
    assert.equal(getOtlpMetricKind(metrics[2]), "histogram");
    assert.equal(getOtlpTemporality(metrics[0]), "unspecified");
    assert.equal(getOtlpTemporality(metrics[1]), "cumulative");
  });
});
