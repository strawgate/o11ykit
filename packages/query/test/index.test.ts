import { describe, expect, it } from "vitest";
import { makeEnvelope } from "../../otlpjson/src/index.js";
import { logsDocument, metricsDocument, tracesDocument } from "../../otlpjson/test/fixtures.js";
import {
  bucketTimeSeries,
  collectLogs,
  collectMetrics,
  collectTraces,
  defaultSeriesKey,
  defaultSeriesLabel,
  filterRecords,
  groupBy,
  latestBy,
  matchesAttributes,
  matchesValue,
  recordName,
  recordNumericValue,
  recordScope,
  recordTimestampNanos,
} from "../src/index.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected value to be present.");
  }
  return value;
}

describe("@otlpkit/query", () => {
  it("collects telemetry rows from documents, arrays, and envelopes", () => {
    expect(collectMetrics(metricsDocument)).toHaveLength(6);
    expect(collectTraces(tracesDocument)).toHaveLength(2);
    expect(collectLogs(logsDocument)).toHaveLength(1);
    expect(collectMetrics([metricsDocument, makeEnvelope(metricsDocument)])).toHaveLength(12);
    expect(collectMetrics(null)).toEqual([]);
    expect(collectMetrics(makeEnvelope(logsDocument))).toEqual([]);
    expect(collectTraces(collectTraces(tracesDocument)[0])).toHaveLength(1);
  });

  it("matches values and attributes flexibly", () => {
    expect(matchesValue("anything", null)).toBe(true);
    expect(matchesValue("error", /err/u)).toBe(true);
    expect(matchesValue("loki", ["elastic", "loki"])).toBe(true);
    expect(matchesValue(7, (value: unknown) => Number(value) > 5)).toBe(true);
    expect(matchesAttributes({ output: "elastic", status: "ok" }, { output: "elastic" })).toBe(
      true
    );
  });

  it("filters records and exposes record helpers", () => {
    const metrics = collectMetrics(metricsDocument);
    const traces = collectTraces(tracesDocument);
    const filtered = filterRecords(metrics, {
      name: "logfwd.inflight_batches",
      attributes: { output: "elasticsearch" },
      resource: { "service.name": "logfwd" },
      scopeName: "logfwd.pipeline",
      from: "1500000000",
      to: "2500000000",
    });
    expect(filtered).toHaveLength(1);
    const first = must(filtered[0]);
    expect(recordName(first)).toBe("logfwd.inflight_batches");
    expect(recordTimestampNanos(first)).toBe("2000000000");
    expect(recordScope(first).name).toBe("logfwd.pipeline");
    expect(recordName(must(traces[0]))).toBe("batch");
  });

  it("groups and selects latest records by series key", () => {
    const metrics = collectMetrics(metricsDocument);
    const grouped = groupBy(metrics, defaultSeriesKey);
    const latest = latestBy(metrics, defaultSeriesKey);
    const logs = latestBy(
      [
        {
          ...collectLogs(logsDocument)[0],
          timeUnixNano: null,
          observedTimeUnixNano: null,
        },
        collectLogs(logsDocument)[0],
      ],
      defaultSeriesKey
    );

    expect(grouped.size).toBe(6);
    expect(latest).toHaveLength(6);
    expect(logs).toHaveLength(1);
  });

  it("derives numeric values from different signal types", () => {
    const metrics = collectMetrics(metricsDocument);
    const traces = collectTraces(tracesDocument);
    const logs = collectLogs(logsDocument);
    const firstMetric = must(metrics[0]);
    const histogramMetric = must(metrics[3]);
    const exponentialMetric = must(metrics[5]);
    const firstTrace = must(traces[0]);
    const firstLog = must(logs[0]);

    expect(recordNumericValue(firstMetric)).toBe(3);
    expect(recordNumericValue(histogramMetric)).toBe(7);
    expect(recordNumericValue(exponentialMetric)).toBe(8);
    expect(recordNumericValue(firstTrace)).toBe(5000);
    expect(recordNumericValue(firstLog)).toBeNull();

    const zeroHistogram = must(
      collectMetrics({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "hist.zero",
                    histogram: {
                      dataPoints: [
                        {
                          count: "0",
                          sum: 10,
                        },
                      ],
                    },
                  },
                  {
                    name: "exp.zero",
                    exponentialHistogram: {
                      dataPoints: [
                        {
                          count: "0",
                          sum: 10,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      })[0]
    );
    const zeroExponential = must(
      collectMetrics({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "exp.zero",
                    exponentialHistogram: {
                      dataPoints: [
                        {
                          count: "0",
                          sum: 10,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      })[0]
    );
    const incompleteTrace = must(
      collectTraces({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    endTimeUnixNano: "10",
                  },
                ],
              },
            ],
          },
        ],
      })[0]
    );

    expect(recordNumericValue(zeroHistogram)).toBeNull();
    expect(recordNumericValue(zeroExponential)).toBeNull();
    expect(recordNumericValue(incompleteTrace)).toBeNull();
  });

  it("buckets time-series values with different reducers", () => {
    const inflight = filterRecords(collectMetrics(metricsDocument), {
      name: "logfwd.inflight_batches",
    });

    const sumSeries = bucketTimeSeries(inflight, { intervalMs: 1000, reduce: "sum" });
    const avgSeries = bucketTimeSeries(inflight, { intervalMs: 1000, reduce: "avg" });
    const countSeries = bucketTimeSeries(inflight, { intervalMs: 1000, reduce: "count" });
    const minSeries = bucketTimeSeries(inflight, { intervalMs: 1000, reduce: "min" });
    const maxSeries = bucketTimeSeries(inflight, { intervalMs: 1000, reduce: "max" });
    const lastSeries = bucketTimeSeries(inflight, { intervalMs: 1000, reduce: "last" });

    expect(sumSeries).toHaveLength(2);
    expect(avgSeries[0]?.points[0]?.value).toBe(3);
    expect(countSeries[0]?.points[0]?.value).toBe(1);
    expect(minSeries[0]?.points[0]?.value).toBe(3);
    expect(maxSeries[1]?.points[0]?.value).toBe(4);
    expect(lastSeries[1]?.points[0]?.value).toBe(4);
  });

  it("covers default labels, filters, and skipped buckets", () => {
    const trace = must(collectTraces(tracesDocument)[0]);
    const log = must(
      collectLogs({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    body: { stringValue: "plain" },
                  },
                ],
              },
            ],
          },
        ],
      })[0]
    );
    const sumMetric = must(collectMetrics(metricsDocument)[2]);

    expect(defaultSeriesLabel(log)).toBe("logs");
    expect(defaultSeriesKey(log)).toBe("logs");
    expect(recordTimestampNanos(sumMetric)).toBe("3000000000");
    expect(
      filterRecords([trace], { signal: "traces", traceId: "trace-1", spanId: "root-1" })
    ).toHaveLength(1);
    expect(filterRecords([trace], { traceId: "nope" })).toHaveLength(0);
    expect(filterRecords([trace], { spanId: "nope" })).toHaveLength(0);
    expect(filterRecords([trace], { scopeVersion: "missing" })).toHaveLength(0);
    expect(filterRecords([trace], { resource: { "service.name": "missing" } })).toHaveLength(0);
    expect(
      bucketTimeSeries([trace], {
        valueFn: () => null,
      })
    ).toEqual([]);
  });

  it("covers direct record materialization and default bucket options", () => {
    const duplicateMetrics = collectMetrics({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "metric.same",
                  gauge: {
                    dataPoints: [
                      {
                        timeUnixNano: "2000000",
                        attributes: [{ key: "output", value: { stringValue: "a" } }],
                        asInt: "1",
                      },
                      {
                        timeUnixNano: "1000000",
                        attributes: [{ key: "output", value: { stringValue: "a" } }],
                        asInt: "2",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const firstMetric = must(duplicateMetrics[0]);

    expect(collectMetrics(firstMetric)).toHaveLength(1);
    expect(collectLogs(must(collectLogs(logsDocument)[0]))).toHaveLength(1);
    expect(collectTraces(must(collectLogs(logsDocument)[0]))).toEqual([]);
    expect(collectLogs(must(collectTraces(tracesDocument)[0]))).toEqual([]);
    expect(collectMetrics({ weird: true })).toEqual([]);
    expect(filterRecords(duplicateMetrics, { from: "1500000" })).toHaveLength(1);
    expect(filterRecords(duplicateMetrics, { to: "1500000" })).toHaveLength(1);
    expect(filterRecords(duplicateMetrics, { signal: "traces" })).toHaveLength(0);
    expect(filterRecords(duplicateMetrics, { scopeName: "missing" })).toHaveLength(0);
    expect(filterRecords(duplicateMetrics, { traceId: "trace-1" })).toHaveLength(0);
    expect(filterRecords(duplicateMetrics, { spanId: "span-1" })).toHaveLength(0);
    expect(groupBy(duplicateMetrics, () => "same").get("same")).toHaveLength(2);
    expect(bucketTimeSeries(duplicateMetrics, { intervalMs: 1 })[0]?.points).toHaveLength(2);
    expect(latestBy(duplicateMetrics, () => "same")[0]?.record).toEqual(duplicateMetrics[0]);
    expect(
      bucketTimeSeries([...duplicateMetrics].reverse(), {
        intervalMs: 1,
        keyFn: () => "same",
      })[0]?.points[0]?.timeUnixNano
    ).toBe("1000000");
    expect(
      bucketTimeSeries(duplicateMetrics, {
        intervalMs: 1,
        reduce: "last",
      })[0]?.points.at(-1)?.value
    ).toBe(1);
  });

  it("covers timestamp fallbacks on sparse records", () => {
    const metric = must(
      collectMetrics({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "with-start-only",
                    gauge: {
                      dataPoints: [
                        {
                          startTimeUnixNano: "5",
                          asInt: "1",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      })[0]
    );
    const trace = must(
      collectTraces({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    endTimeUnixNano: "7",
                  },
                ],
              },
            ],
          },
        ],
      })[0]
    );

    expect(recordTimestampNanos(metric)).toBe("5");
    expect(recordTimestampNanos(trace)).toBe("7");
  });
});
