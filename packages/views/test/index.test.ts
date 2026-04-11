import { describe, expect, it } from "vitest";

import { logsDocument, metricsDocument, tracesDocument } from "../../otlpjson/test/fixtures.js";
import {
  appendTimeSeriesFrame,
  buildEventTimelineFrame,
  buildHistogramFrame,
  buildLatestValuesFrame,
  buildTimeSeriesFrame,
  buildTraceWaterfallFrame,
  createTelemetryStore,
  mergeTimeSeriesFrames,
} from "../src/index.js";
describe("@otlpkit/views", () => {
  it("builds time-series frames", () => {
    const frame = buildTimeSeriesFrame(metricsDocument, {
      metricName: "logfwd.inflight_batches",
      intervalMs: 1000,
      splitBy: "output",
    });

    expect(frame.kind).toBe("time-series");
    expect(frame.signal).toBe("metrics");
    expect(frame.series).toHaveLength(2);
    expect(frame.series[0]?.points[0]?.value).toBe(3);
  });

  it("builds latest-value and histogram frames", () => {
    const latest = buildLatestValuesFrame(metricsDocument, {
      metricName: "logfwd.inflight_batches",
      splitBy: "output",
    });
    const histogram = buildHistogramFrame(metricsDocument, {
      metricName: "logfwd.output.duration",
      binCount: 4,
    });
    const emptyHistogram = buildHistogramFrame(logsDocument, {
      signal: "logs",
      binCount: 2,
    });

    expect(latest.rows).toHaveLength(2);
    expect(histogram.bins.length).toBeGreaterThan(0);
    expect(emptyHistogram.bins).toHaveLength(0);
  });

  it("builds trace waterfall frames", () => {
    const waterfall = buildTraceWaterfallFrame(tracesDocument);

    expect(waterfall.traces).toHaveLength(1);
    expect(waterfall.traces[0]?.spans).toHaveLength(2);
    expect(waterfall.traces[0]?.spans[1]?.depth).toBe(1);
  });

  it("builds event timeline frames from logs and traces", () => {
    const traceEvents = buildEventTimelineFrame(tracesDocument);
    const logEvents = buildEventTimelineFrame(logsDocument, { signal: "logs" });

    expect(traceEvents.events).toHaveLength(1);
    expect(logEvents.events).toHaveLength(1);
    expect(logEvents.events[0]?.severityText).toBe("WARN");
  });

  it("covers automatic signal detection fallbacks", () => {
    expect(buildTimeSeriesFrame(metricsDocument, { signal: "metrics" }).signal).toBe("metrics");
    expect(buildTimeSeriesFrame(tracesDocument).signal).toBe("traces");
    expect(buildTimeSeriesFrame(logsDocument).signal).toBe("logs");
    expect(buildTimeSeriesFrame({}).signal).toBeNull();
  });

  it("covers split projections, explicit signals, and sparse traces", () => {
    const traceSeries = buildTimeSeriesFrame(tracesDocument, {
      signal: "traces",
      splitBy: "scope.name",
      valueFn: (record) => (record.signal === "traces" ? 1 : null),
    });
    const emptyLogs = buildTimeSeriesFrame([], {
      signal: "logs",
    });
    const resourceLatest = buildLatestValuesFrame(metricsDocument, {
      metricName: "logfwd.inflight_batches",
      splitBy: "resource.service.name",
    });
    const namedLatest = buildLatestValuesFrame(metricsDocument, {
      name: "logfwd.inflight_batches",
      splitBy: "missing",
    });
    const missingResourceSeries = buildTimeSeriesFrame(metricsDocument, {
      name: "logfwd.inflight_batches",
      splitBy: "resource.missing",
    });
    const missingScopeLatest = buildLatestValuesFrame(logsDocument, {
      signal: "logs",
      splitBy: "scope.missing",
      valueFn: () => 1,
    });
    const computedLatest = buildLatestValuesFrame(tracesDocument, {
      signal: "traces",
      valueFn: () => 5,
    });
    const namedHistogram = buildHistogramFrame(metricsDocument, {
      name: "logfwd.inflight_batches",
    });
    const defaultHistogram = buildHistogramFrame(metricsDocument, {
      filters: { name: "logfwd.inflight_batches" },
    });
    const equalHistogram = buildHistogramFrame(
      {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "equal.values",
                    gauge: {
                      dataPoints: [
                        { timeUnixNano: "100", asInt: "2" },
                        { timeUnixNano: "200", asInt: "2" },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        metricName: "equal.values",
        binCount: 2,
      }
    );
    const sparseWaterfall = buildTraceWaterfallFrame({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  startTimeUnixNano: "10",
                  endTimeUnixNano: "20",
                },
                {
                  traceId: "unknown",
                  endTimeUnixNano: "30",
                },
                {
                  traceId: "trace-z",
                  spanId: "child",
                  parentSpanId: "missing",
                  startTimeUnixNano: "5",
                  endTimeUnixNano: "15",
                },
              ],
            },
          ],
        },
      ],
    });
    const sparseTraceEvents = buildEventTimelineFrame(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    events: [
                      {
                        timeUnixNano: "5",
                        attributes: [],
                      },
                      {
                        timeUnixNano: "4",
                        attributes: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        title: "Sparse events",
      }
    );
    const multiLogEvents = buildEventTimelineFrame(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "7",
                    body: { stringValue: "later" },
                  },
                  {
                    timeUnixNano: "3",
                    body: { stringValue: "earlier" },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        signal: "logs",
      }
    );

    expect(traceSeries.signal).toBe("traces");
    expect(traceSeries.unit).toBe("ms");
    expect(emptyLogs.unit).toBeNull();
    expect(resourceLatest.rows[0]?.label).toBe("logfwd");
    expect(namedLatest.rows[0]?.label).toBe("unknown");
    expect(missingResourceSeries.series[0]?.label).toBe("unknown");
    expect(missingScopeLatest.rows[0]?.label).toBe("unknown");
    expect(computedLatest.rows[0]?.value).toBe(5);
    expect(namedHistogram.title).toBe("logfwd.inflight_batches");
    expect(defaultHistogram.title).toBe("Histogram");
    expect(defaultHistogram.bins).toHaveLength(10);
    expect(equalHistogram.bins.some((bin) => bin.count > 0)).toBe(true);
    expect(sparseWaterfall.traces[0]?.traceId).toBe("unknown");
    expect(sparseWaterfall.traces[1]?.traceId).toBe("trace-z");
    expect(sparseWaterfall.traces[0]?.spans[0]?.depth).toBe(0);
    expect(sparseWaterfall.traces[0]?.spans[1]?.startOffsetNanos).toBeNull();
    expect(sparseTraceEvents.title).toBe("Sparse events");
    expect(sparseTraceEvents.events).toHaveLength(2);
    expect(multiLogEvents.events[0]?.body).toBe("earlier");
  });

  it("covers invalid trace duration fallbacks", () => {
    const waterfall = buildTraceWaterfallFrame({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "bad-trace",
                  startTimeUnixNano: "nope",
                  endTimeUnixNano: "still-nope",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(waterfall.traces[0]?.durationNanos).toBeNull();
  });

  it("sorts null timestamps deterministically in waterfalls and timelines", () => {
    const waterfall = buildTraceWaterfallFrame({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace-sort",
                  spanId: "late",
                  startTimeUnixNano: "20",
                  endTimeUnixNano: "25",
                },
                {
                  traceId: "trace-sort",
                  spanId: "null-time",
                },
                {
                  traceId: "trace-sort",
                  spanId: "early",
                  startTimeUnixNano: "10",
                  endTimeUnixNano: "15",
                },
              ],
            },
          ],
        },
      ],
    });
    const logEvents = buildEventTimelineFrame(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    body: { stringValue: "late" },
                    timeUnixNano: "8",
                  },
                  {
                    body: { stringValue: "null" },
                  },
                  {
                    body: { stringValue: "early" },
                    timeUnixNano: "3",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        signal: "logs",
      }
    );
    const traceEvents = buildEventTimelineFrame({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace-events",
                  spanId: "span-1",
                  events: [
                    {
                      name: "late",
                      timeUnixNano: "8",
                    },
                    {
                      name: "null",
                    },
                    {
                      name: "early",
                      timeUnixNano: "3",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(waterfall.traces[0]?.spans[0]?.spanId).toBe("null-time");
    expect(logEvents.events[0]?.body).toBe("null");
    expect(traceEvents.events[0]?.name).toBe("null");
  });

  it("matches batch frame output through an incremental store", () => {
    const store = createTelemetryStore();
    store.ingest(metricsDocument);

    const batch = buildTimeSeriesFrame(metricsDocument, {
      metricName: "logfwd.inflight_batches",
      intervalMs: 1000,
      splitBy: "output",
    });
    const fromStore = store.selectTimeSeries({
      metricName: "logfwd.inflight_batches",
      intervalMs: 1000,
      splitBy: "output",
    });

    expect(fromStore).toEqual(batch);
  });

  it("supports append-only ingest across multiple calls", () => {
    const store = createTelemetryStore();

    const first = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "app.requests",
                  gauge: {
                    dataPoints: [{ timeUnixNano: "1000000", asInt: "3" }],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const second = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "app.requests",
                  gauge: {
                    dataPoints: [{ timeUnixNano: "2000000", asInt: "8" }],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(store.ingest(first).metrics).toBe(1);
    expect(store.ingest(second).metrics).toBe(1);
    expect(store.size().metrics).toBe(2);

    const frame = store.selectTimeSeries({
      metricName: "app.requests",
      intervalMs: 1,
    });
    expect(frame.series).toHaveLength(1);
    expect(frame.series[0]?.points).toHaveLength(2);
    expect(frame.series[0]?.points[1]?.value).toBe(8);
  });

  it("applies maxPoints retention per signal", () => {
    const store = createTelemetryStore({ maxPoints: 2 });

    store.ingest({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "queue.depth",
                  gauge: {
                    dataPoints: [
                      { timeUnixNano: "1000000", asInt: "1" },
                      { timeUnixNano: "2000000", asInt: "2" },
                      { timeUnixNano: "3000000", asInt: "3" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const frame = store.selectTimeSeries({
      metricName: "queue.depth",
      intervalMs: 1,
    });
    expect(store.size().metrics).toBe(2);
    expect(frame.series[0]?.points).toHaveLength(2);
    expect(frame.series[0]?.points[0]?.timeUnixNano).toBe("2000000");
    expect(frame.series[0]?.points[1]?.timeUnixNano).toBe("3000000");
  });

  it("applies maxAgeMs retention per signal", () => {
    const store = createTelemetryStore({ maxAgeMs: 2 });

    store.ingest({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "queue.latency",
                  gauge: {
                    dataPoints: [
                      { timeUnixNano: "6000000", asInt: "6" },
                      { timeUnixNano: "5000000", asInt: "5" },
                      { timeUnixNano: "1000000", asInt: "1" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const frame = store.selectTimeSeries({
      metricName: "queue.latency",
      intervalMs: 1,
    });
    expect(store.size().metrics).toBe(2);
    expect(frame.series[0]?.points).toHaveLength(2);
    expect(frame.series[0]?.points[0]?.timeUnixNano).toBe("5000000");
    expect(frame.series[0]?.points[1]?.timeUnixNano).toBe("6000000");
  });

  it("supports traces/logs selectors from incremental ingest", () => {
    const store = createTelemetryStore();
    store.ingest(tracesDocument);
    store.ingest(logsDocument);

    expect(store.selectTraceWaterfall().traces.length).toBeGreaterThan(0);
    expect(store.selectEventTimeline({ signal: "logs" }).events.length).toBeGreaterThan(0);
  });

  it("supports latest/histogram selectors and clear()", () => {
    const store = createTelemetryStore();
    store.ingest(metricsDocument);

    expect(
      store.selectLatestValues({ metricName: "logfwd.inflight_batches" }).rows.length
    ).toBeGreaterThan(0);
    expect(
      store.selectHistogram({ metricName: "logfwd.output.duration" }).bins.length
    ).toBeGreaterThan(0);

    store.clear();
    expect(store.size().total).toBe(0);
    expect(store.selectLatestValues({ metricName: "logfwd.inflight_batches" }).rows).toHaveLength(
      0
    );
  });

  it("keeps records with missing timestamps when maxAgeMs is set", () => {
    const store = createTelemetryStore({ maxAgeMs: 5 });
    store.ingest({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "untimed.metric",
                  gauge: {
                    dataPoints: [{ asInt: "42" }],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const latest = store.selectLatestValues({ metricName: "untimed.metric" });
    expect(latest.rows).toHaveLength(1);
    expect(latest.rows[0]?.value).toBe(42);
  });

  it("validates telemetry store retention options", () => {
    expect(() => createTelemetryStore({ maxPoints: 0 })).toThrow(
      /maxPoints must be a positive integer/
    );
    expect(() => createTelemetryStore({ maxAgeMs: 0 })).toThrow(
      /maxAgeMs must be a positive number/
    );
  });
  it("merges time-series frames for incremental updates", () => {
    const base = buildTimeSeriesFrame(metricsDocument, {
      metricName: "logfwd.inflight_batches",
      intervalMs: 1000,
      splitBy: "output",
    });

    const incomingDoc = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "logfwd.inflight_batches",
                  gauge: {
                    dataPoints: [
                      {
                        attributes: [{ key: "output", value: { stringValue: "elasticsearch" } }],
                        timeUnixNano: "4000000000",
                        asInt: "9",
                      },
                      {
                        attributes: [{ key: "output", value: { stringValue: "kafka" } }],
                        timeUnixNano: "4000000000",
                        asInt: "6",
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

    const incoming = buildTimeSeriesFrame(incomingDoc, {
      metricName: "logfwd.inflight_batches",
      intervalMs: 1000,
      splitBy: "output",
    });
    const merged = mergeTimeSeriesFrames(base, incoming);

    expect(merged.series.map((series) => series.key).sort()).toEqual([
      "elasticsearch",
      "kafka",
      "loki",
    ]);
    const elastic = merged.series.find((series) => series.key === "elasticsearch");
    expect(elastic?.points.map((point) => point.value)).toEqual([3, 9]);
  });

  it("supports conflict policy when merging incremental points", () => {
    const base = buildTimeSeriesFrame(metricsDocument, {
      metricName: "logfwd.inflight_batches",
      intervalMs: 1000,
      splitBy: "output",
    });

    const conflictingDoc = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "logfwd.inflight_batches",
                  gauge: {
                    dataPoints: [
                      {
                        attributes: [{ key: "output", value: { stringValue: "loki" } }],
                        timeUnixNano: "3000000000",
                        asInt: "44",
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

    const incoming = buildTimeSeriesFrame(conflictingDoc, {
      metricName: "logfwd.inflight_batches",
      intervalMs: 1000,
      splitBy: "output",
    });

    const replaced = mergeTimeSeriesFrames(base, incoming);
    const kept = mergeTimeSeriesFrames(base, incoming, { onConflict: "keep-existing" });

    const replacedLoki = replaced.series.find((series) => series.key === "loki");
    const keptLoki = kept.series.find((series) => series.key === "loki");
    expect(replacedLoki?.points[0]?.value).toBe(44);
    expect(keptLoki?.points[0]?.value).toBe(4);
  });

  it("appends incremental input directly onto an existing frame", () => {
    const base = buildTimeSeriesFrame(metricsDocument, {
      metricName: "logfwd.inflight_batches",
      intervalMs: 1000,
      splitBy: "output",
    });

    const nextSlice = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "logfwd.inflight_batches",
                  gauge: {
                    dataPoints: [
                      {
                        attributes: [{ key: "output", value: { stringValue: "loki" } }],
                        timeUnixNano: "6000000000",
                        asInt: "8",
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

    const appended = appendTimeSeriesFrame(base, nextSlice);

    const loki = appended.series.find((series) => series.key === "loki");
    expect(loki?.points.map((point) => point.value)).toEqual([4, 8]);
    expect(appended.intervalMs).toBe(1000);
    expect(appended.title).toBe(base.title);
    expect(appended.buildOptions?.metricName).toBe("logfwd.inflight_batches");
    expect(appended.buildOptions?.splitBy).toBe("output");
  });

  it("merges fallback metadata and preserves existing series labels", () => {
    const existing = {
      kind: "time-series" as const,
      signal: null,
      title: "Existing frame",
      unit: null,
      intervalMs: 1000,
      series: [
        {
          key: "svc-a",
          label: "Service A",
          points: [
            {
              timeUnixNano: "1000000000",
              timeMs: 1000,
              isoTime: "1970-01-01T00:00:01.000Z",
              value: 1,
              samples: 1,
            },
          ],
        },
      ],
    };
    const incoming = {
      kind: "time-series" as const,
      signal: "metrics" as const,
      title: "Incoming frame",
      unit: "ms",
      intervalMs: 2000,
      series: [
        {
          key: "svc-a",
          label: "",
          points: [
            {
              timeUnixNano: "2000000000",
              timeMs: 2000,
              isoTime: "1970-01-01T00:00:02.000Z",
              value: 3,
              samples: 1,
            },
          ],
        },
      ],
    };

    const merged = mergeTimeSeriesFrames(existing, incoming);

    expect(merged.signal).toBe("metrics");
    expect(merged.unit).toBe("ms");
    expect(merged.title).toBe("Existing frame");
    expect(merged.intervalMs).toBe(1000);
    expect(merged.series[0]?.label).toBe("Service A");
  });

  it("append supports explicit signal/unit overrides and null fallbacks", () => {
    const emptyBase = {
      kind: "time-series" as const,
      signal: null,
      title: "Empty",
      unit: null,
      intervalMs: 1000,
      series: [],
    };

    const explicit = appendTimeSeriesFrame(
      emptyBase,
      {},
      {
        signal: "logs",
        unit: "events",
      }
    );
    const inferredNull = appendTimeSeriesFrame(emptyBase, {});

    expect(explicit.signal).toBe("logs");
    expect(explicit.unit).toBe("events");
    expect(inferredNull.signal).toBeNull();
    expect(inferredNull.unit).toBeNull();
  });

  it("append falls back to existing signal/unit when build options are absent", () => {
    const manualBase = {
      kind: "time-series" as const,
      signal: "metrics" as const,
      title: "Manual",
      unit: "ms",
      intervalMs: 1000,
      series: [],
    };

    const appended = appendTimeSeriesFrame(manualBase, {});

    expect(appended.signal).toBe("metrics");
    expect(appended.unit).toBe("ms");
  });

  it("sorts merged series points when incoming data is older than existing data", () => {
    const existing = {
      kind: "time-series" as const,
      signal: "metrics" as const,
      title: "Ordered",
      unit: "ms",
      intervalMs: 1000,
      series: [
        {
          key: "svc-a",
          label: "Service A",
          points: [
            {
              timeUnixNano: "4000000000",
              timeMs: 4000,
              isoTime: "1970-01-01T00:00:04.000Z",
              value: 4,
              samples: 1,
            },
          ],
        },
      ],
    };
    const incoming = {
      kind: "time-series" as const,
      signal: "metrics" as const,
      title: "Ordered",
      unit: "ms",
      intervalMs: 1000,
      series: [
        {
          key: "svc-a",
          label: "Service A incoming",
          points: [
            {
              timeUnixNano: "not-a-nanos-value",
              timeMs: null,
              isoTime: null,
              value: 1,
              samples: 1,
            },
            {
              timeUnixNano: "2000000000",
              timeMs: 2000,
              isoTime: "1970-01-01T00:00:02.000Z",
              value: 2,
              samples: 1,
            },
          ],
        },
      ],
    };

    const merged = mergeTimeSeriesFrames(existing, incoming);

    expect(merged.series[0]?.points.map((point) => point.timeUnixNano)).toEqual([
      "not-a-nanos-value",
      "2000000000",
      "4000000000",
    ]);
  });

});
