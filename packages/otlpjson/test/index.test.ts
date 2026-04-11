import { describe, expect, it } from "vitest";

import {
  attributeValueToJs,
  collectLogRecords,
  collectMetricPoints,
  collectSpans,
  detectSignal,
  durationNanos,
  flattenAttributes,
  isLogsDocument,
  isMetricsDocument,
  isTracesDocument,
  iterLogRecords,
  iterMetricPoints,
  iterSpans,
  makeEnvelope,
  nanosToIso,
  nanosToMillis,
  normalizeUnixNanos,
  parseOtlpJson,
  parseOtlpJsonLine,
  parseOtlpJsonLines,
  toNumber,
  toUnixNanos,
} from "../src/index.js";
import { logsDocument, metricsDocument, tracesDocument } from "./fixtures.js";

describe("@otlpkit/otlpjson", () => {
  it("detects OTLP document signals and type guards", () => {
    expect(detectSignal(metricsDocument)).toBe("metrics");
    expect(detectSignal(tracesDocument)).toBe("traces");
    expect(detectSignal(logsDocument)).toBe("logs");
    expect(detectSignal({ nope: true })).toBeNull();
    expect(isMetricsDocument(metricsDocument)).toBe(true);
    expect(isTracesDocument(tracesDocument)).toBe(true);
    expect(isLogsDocument(logsDocument)).toBe(true);
  });

  it("parses JSON, lines, and envelopes", () => {
    const jsonl = `${JSON.stringify(metricsDocument)}\n\n${JSON.stringify(tracesDocument)}\n`;
    const documents = parseOtlpJsonLines(jsonl);
    expect(documents).toHaveLength(2);
    expect(parseOtlpJson(JSON.stringify(logsDocument))).toEqual(logsDocument);
    expect(parseOtlpJsonLine("   ")).toBeNull();
    expect(() => parseOtlpJson({ invalid: true })).toThrowError(TypeError);
    const envelope = makeEnvelope(metricsDocument, { receivedAt: "2026-04-07T23:00:00.000Z" });
    expect(envelope.signal).toBe("metrics");
    expect(envelope.receivedAt).toBe("2026-04-07T23:00:00.000Z");
  });

  it("normalizes timestamps and scalar values", () => {
    expect(toUnixNanos("1234")).toBe(1234n);
    expect(toUnixNanos(new Date("1970-01-01T00:00:01.000Z"))).toBe(1_000_000_000n);
    expect(toUnixNanos(Number.NaN)).toBeNull();
    expect(normalizeUnixNanos("1234")).toBe("1234");
    expect(nanosToMillis("2000000000")).toBe(2000);
    expect(nanosToIso("7000000000")).toBe("1970-01-01T00:00:07.000Z");
    expect(durationNanos("1000", "2500")).toBe("1500");
    expect(durationNanos("bad", "2500")).toBeNull();
    expect(toNumber("2.5")).toBe(2.5);
    expect(toNumber("nope")).toBeNull();
  });

  it("converts OTLP any values and nested attributes", () => {
    expect(attributeValueToJs({ stringValue: "hello" })).toBe("hello");
    expect(attributeValueToJs({ boolValue: true })).toBe(true);
    expect(attributeValueToJs({ intValue: "3" })).toBe(3);
    expect(attributeValueToJs({ doubleValue: 2.5 })).toBe(2.5);
    expect(attributeValueToJs({ bytesValue: "YWJj" })).toBe("YWJj");
    expect(
      attributeValueToJs({
        arrayValue: {
          values: [{ stringValue: "a" }, { intValue: "2" }],
        },
      })
    ).toEqual(["a", 2]);
    expect(
      flattenAttributes([
        {
          key: "nested",
          value: {
            kvlistValue: {
              values: [
                { key: "flag", value: { boolValue: true } },
                { key: "count", value: { intValue: "3" } },
              ],
            },
          },
        },
      ])
    ).toEqual({
      nested: {
        flag: true,
        count: 3,
      },
    });
    expect(attributeValueToJs({ unknown: true })).toBeNull();
  });

  it("materializes metrics, traces, and logs into typed records", () => {
    const metricPoints = collectMetricPoints(metricsDocument);
    const spans = collectSpans(tracesDocument);
    const logs = collectLogRecords(logsDocument);

    expect(metricPoints).toHaveLength(6);
    expect(metricPoints[0]?.resource).toEqual({
      "service.name": "logfwd",
      pipeline: "main",
    });
    expect(metricPoints[3]?.point.kind).toBe("histogram");
    expect(metricPoints[3]?.point.exemplars[0]?.value).toBe(4.5);
    expect(metricPoints[4]?.point.kind).toBe("summary");
    expect(metricPoints[5]?.point.kind).toBe("exponentialHistogram");

    expect(spans).toHaveLength(2);
    expect(spans[0]?.durationNanos).toBe("5000000000");
    expect(spans[0]?.events[0]?.isoTime).toBe("1970-01-01T00:00:05.000Z");
    expect(spans[1]?.status.message).toBe("retry");

    expect(logs).toHaveLength(1);
    expect(logs[0]?.body).toBe("retry scheduled");
    expect(logs[0]?.observedTimeUnixNano).toBe("7000000100");
  });

  it("covers sparse optional fields and guard failures", () => {
    const sparseMetrics = {
      resourceMetrics: [
        {},
        {
          scopeMetrics: [
            {
              scope: {},
            },
          ],
        },
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "sparse.gauge",
                  gauge: {
                    dataPoints: [
                      {
                        exemplars: [
                          {
                            asInt: "4",
                          },
                          {},
                        ],
                      },
                    ],
                  },
                },
                {
                  name: "sparse.sum",
                  sum: {
                    dataPoints: [{}],
                  },
                },
                {
                  name: "sparse.histogram",
                  histogram: {
                    dataPoints: [{}],
                  },
                },
                {
                  name: "sparse.summary",
                  summary: {
                    dataPoints: [{}, { quantileValues: [{}] }],
                  },
                },
                {
                  name: "sparse.exp",
                  exponentialHistogram: {
                    dataPoints: [{}],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const sparseTraces = {
      resourceSpans: [
        {},
        {
          scopeSpans: [
            {
              scope: {},
            },
          ],
        },
        {
          scopeSpans: [{}],
        },
        {
          scopeSpans: [
            {
              spans: [
                {
                  links: [{}],
                  events: [{}],
                },
              ],
            },
          ],
        },
      ],
    };
    const sparseLogs = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              scope: {},
            },
          ],
        },
        {},
        {
          scopeLogs: [{}],
        },
        {
          scopeLogs: [
            {
              logRecords: [{}],
            },
          ],
        },
      ],
    };

    const sparseMetricPoints = collectMetricPoints(sparseMetrics);
    const sparseSpan = collectSpans(sparseTraces)[0];
    const sparseLog = collectLogRecords(sparseLogs)[0];

    expect(sparseMetricPoints[0]?.scope.name).toBeNull();
    expect(sparseMetricPoints[0]?.metric.unit).toBeNull();
    expect(sparseMetricPoints[0]?.point.exemplars[0]).toEqual({
      filteredAttributes: {},
      timeUnixNano: null,
      spanId: null,
      traceId: null,
      value: 4,
    });
    expect(sparseMetricPoints[0]?.point.exemplars[1]?.value).toBeNull();
    expect(sparseMetricPoints[1]?.metric.aggregationTemporality).toBeNull();
    expect(sparseMetricPoints[1]?.metric.isMonotonic).toBeNull();
    expect(sparseMetricPoints[1]?.point.value).toBeNull();
    expect(sparseMetricPoints[2]?.point.kind).toBe("histogram");
    expect(sparseMetricPoints[2]?.point.bucketCounts).toEqual([]);
    expect(sparseMetricPoints[2]?.point.explicitBounds).toEqual([]);
    expect(sparseMetricPoints[2]?.point.min).toBeNull();
    expect(sparseMetricPoints[2]?.point.max).toBeNull();
    expect(sparseMetricPoints[3]?.point.kind).toBe("summary");
    expect(sparseMetricPoints[3]?.point.quantileValues).toEqual([]);
    expect(sparseMetricPoints[4]?.point.quantileValues[0]).toEqual({
      quantile: null,
      value: null,
    });
    expect(sparseMetricPoints[5]?.point.kind).toBe("exponentialHistogram");
    expect(sparseMetricPoints[5]?.point.positive.bucketCounts).toEqual([]);
    expect(sparseSpan?.traceId).toBeNull();
    expect(sparseSpan?.links[0]).toEqual({
      traceId: null,
      spanId: null,
      attributes: {},
    });
    expect(sparseSpan?.events[0]?.name).toBeNull();
    expect(sparseSpan?.status.code).toBe(0);
    expect(sparseLog?.severityText).toBeNull();
    expect(sparseLog?.flags).toBeNull();

    expect(() => [...iterMetricPoints({} as never)]).toThrowError(TypeError);
    expect(() => [...iterSpans({} as never)]).toThrowError(TypeError);
    expect(() => [...iterLogRecords({} as never)]).toThrowError(TypeError);
    expect(() => makeEnvelope({ invalid: true } as never)).toThrowError(TypeError);
  });

  it("covers primitive conversion and timestamp fallbacks", () => {
    expect(attributeValueToJs("plain")).toBe("plain");
    expect(attributeValueToJs(null)).toBeNull();
    expect(toUnixNanos(12n)).toBe(12n);
    expect(toUnixNanos(12)).toBe(12n);
    expect(toUnixNanos("1970-01-01T00:00:01.000Z")).toBe(1_000_000_000n);
    expect(toUnixNanos({})).toBeNull();
    expect(nanosToMillis(null)).toBeNull();
    expect(nanosToIso(null)).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(attributeValueToJs({ stringValue: undefined })).toBeNull();
    expect(attributeValueToJs({ boolValue: undefined })).toBe(false);
    expect(attributeValueToJs({ intValue: undefined })).toBeNull();
    expect(attributeValueToJs({ doubleValue: undefined })).toBeNull();
    expect(attributeValueToJs({ bytesValue: undefined })).toBeNull();
    expect(attributeValueToJs({ arrayValue: {} })).toEqual([]);
    expect(attributeValueToJs({ kvlistValue: {} })).toEqual({});
  });
});
