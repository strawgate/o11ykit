import { describe, expect, it } from "vitest";

import { logsDocument, metricsDocument, tracesDocument } from "../../otlpjson/test/fixtures.js";
import {
  buildEventTimelineFrame,
  buildHistogramFrame,
  buildLatestValuesFrame,
  buildTimeSeriesFrame,
  buildTraceWaterfallFrame,
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
});
