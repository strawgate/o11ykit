import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getOtlpMetricKind,
  getOtlpTemporality,
  otlpAttributesToRecord,
  parseOtlp as parseOtlpMetrics,
} from "./parse-otlp.js";

function makeDocument() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "benchkit.run_id", value: { stringValue: "run-123" } },
            { key: "benchkit.kind", value: { stringValue: "workflow" } },
            { key: "benchkit.source_format", value: { stringValue: "otlp" } },
            { key: "benchkit.ref", value: { stringValue: "refs/heads/main" } },
            { key: "benchkit.commit", value: { stringValue: "abcdef123456" } },
            { key: "benchkit.workflow", value: { stringValue: "Workflow Benchmark" } },
            { key: "benchkit.job", value: { stringValue: "workflow-bench" } },
            { key: "service.name", value: { stringValue: "mock-ingest" } },
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
                        { key: "benchkit.scenario", value: { stringValue: "json-ingest" } },
                        { key: "benchkit.series", value: { stringValue: "mock-http-ingest" } },
                        { key: "benchkit.metric.direction", value: { stringValue: "bigger_is_better" } },
                        { key: "benchkit.metric.role", value: { stringValue: "outcome" } },
                        { key: "benchkit.transport", value: { stringValue: "http" } },
                      ],
                      timeUnixNano: "1711929600000000000",
                      asDouble: 13240.5,
                    },
                    {
                      attributes: [
                        { key: "benchkit.scenario", value: { stringValue: "json-ingest" } },
                        { key: "benchkit.series", value: { stringValue: "mock-http-ingest" } },
                        { key: "benchkit.metric.direction", value: { stringValue: "bigger_is_better" } },
                        { key: "benchkit.metric.role", value: { stringValue: "outcome" } },
                        { key: "benchkit.transport", value: { stringValue: "http" } },
                      ],
                      timeUnixNano: "1711929660000000000",
                      asDouble: 14000,
                    },
                  ],
                },
              },
              {
                name: "_monitor.cpu_user_pct",
                unit: "%",
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      attributes: [
                        { key: "benchkit.scenario", value: { stringValue: "diagnostic" } },
                        { key: "benchkit.series", value: { stringValue: "system" } },
                        { key: "benchkit.metric.role", value: { stringValue: "diagnostic" } },
                        { key: "benchkit.metric.direction", value: { stringValue: "smaller_is_better" } },
                      ],
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
                      attributes: [
                        { key: "benchkit.scenario", value: { stringValue: "json-ingest" } },
                        { key: "benchkit.series", value: { stringValue: "mock-http-ingest" } },
                        { key: "benchkit.metric.direction", value: { stringValue: "smaller_is_better" } },
                      ],
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

describe("parseOtlpMetrics", () => {
  it("parses a valid OTLP metrics document", () => {
    const parsed = parseOtlpMetrics(JSON.stringify(makeDocument()));
    assert.equal(parsed.resourceMetrics.length, 1);
    assert.equal(parsed.resourceMetrics[0].scopeMetrics?.[0].metrics?.length, 3);
  });

  it("throws when resourceMetrics is missing", () => {
    assert.throws(() => parseOtlpMetrics("{}"), /resourceMetrics/);
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
    const document = parseOtlpMetrics(JSON.stringify(makeDocument()));
    const metrics = document.resourceMetrics[0].scopeMetrics?.[0].metrics ?? [];
    assert.equal(getOtlpMetricKind(metrics[0]), "gauge");
    assert.equal(getOtlpMetricKind(metrics[1]), "sum");
    assert.equal(getOtlpMetricKind(metrics[2]), "histogram");
    assert.equal(getOtlpTemporality(metrics[0]), "unspecified");
    assert.equal(getOtlpTemporality(metrics[1]), "cumulative");
  });
});


