import type { OtlpLogsDocument, OtlpMetricsDocument, OtlpTracesDocument } from "../src/index.js";

export const metricsDocument: OtlpMetricsDocument = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "logfwd" } },
          { key: "pipeline", value: { stringValue: "main" } },
        ],
      },
      scopeMetrics: [
        {
          scope: {
            name: "logfwd.pipeline",
            version: "1.0.0",
            attributes: [{ key: "scope.kind", value: { stringValue: "telemetry" } }],
          },
          metrics: [
            {
              name: "logfwd.inflight_batches",
              unit: "1",
              gauge: {
                dataPoints: [
                  {
                    attributes: [{ key: "output", value: { stringValue: "elasticsearch" } }],
                    timeUnixNano: "2000000000",
                    asInt: "3",
                  },
                  {
                    attributes: [{ key: "output", value: { stringValue: "loki" } }],
                    timeUnixNano: "3000000000",
                    asInt: "4",
                  },
                ],
              },
            },
            {
              name: "logfwd.retry_total",
              unit: "1",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [{ key: "output", value: { stringValue: "elasticsearch" } }],
                    startTimeUnixNano: "1000000000",
                    timeUnixNano: "3000000000",
                    asInt: "2",
                  },
                ],
              },
            },
            {
              name: "logfwd.output.duration",
              unit: "ms",
              histogram: {
                aggregationTemporality: 2,
                dataPoints: [
                  {
                    attributes: [
                      { key: "output", value: { stringValue: "elasticsearch" } },
                      { key: "status", value: { stringValue: "ok" } },
                    ],
                    startTimeUnixNano: "1000000000",
                    timeUnixNano: "2000000000",
                    count: "2",
                    sum: 14,
                    bucketCounts: ["1", "1"],
                    explicitBounds: [5, 10],
                    min: 4,
                    max: 10,
                    exemplars: [
                      {
                        filteredAttributes: [{ key: "sample", value: { boolValue: true } }],
                        timeUnixNano: "1500000000",
                        asDouble: 4.5,
                        spanId: "child-1",
                        traceId: "trace-1",
                      },
                    ],
                  },
                ],
              },
            },
            {
              name: "logfwd.queue.latency",
              unit: "ms",
              summary: {
                dataPoints: [
                  {
                    attributes: [{ key: "worker", value: { stringValue: "0" } }],
                    timeUnixNano: "4000000000",
                    count: "2",
                    sum: 12,
                    quantileValues: [
                      { quantile: 0.5, value: 5 },
                      { quantile: 0.99, value: 7 },
                    ],
                  },
                ],
              },
            },
            {
              name: "logfwd.flush.delay",
              unit: "ms",
              exponentialHistogram: {
                aggregationTemporality: 2,
                dataPoints: [
                  {
                    attributes: [{ key: "reason", value: { stringValue: "timeout" } }],
                    timeUnixNano: "5000000000",
                    count: "3",
                    sum: 24,
                    scale: "1",
                    zeroCount: "0",
                    positive: {
                      offset: "1",
                      bucketCounts: ["1", "2"],
                    },
                    negative: {
                      offset: "0",
                      bucketCounts: [],
                    },
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

export const tracesDocument: OtlpTracesDocument = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "logfwd" } }],
      },
      scopeSpans: [
        {
          scope: {
            name: "logfwd.pipeline",
            version: "1.0.0",
          },
          spans: [
            {
              traceId: "trace-1",
              spanId: "root-1",
              name: "batch",
              kind: 1,
              startTimeUnixNano: "4000000000",
              endTimeUnixNano: "9000000000",
              attributes: [{ key: "batch.id", value: { stringValue: "batch-1" } }],
              status: { code: 1 },
              events: [
                {
                  timeUnixNano: "5000000000",
                  name: "checkpoint.persisted",
                  attributes: [{ key: "result", value: { stringValue: "ok" } }],
                },
              ],
              links: [
                {
                  traceId: "trace-0",
                  spanId: "link-1",
                  attributes: [{ key: "kind", value: { stringValue: "previous" } }],
                },
              ],
            },
            {
              traceId: "trace-1",
              spanId: "child-1",
              parentSpanId: "root-1",
              name: "output",
              kind: 3,
              startTimeUnixNano: "6000000000",
              endTimeUnixNano: "8000000000",
              attributes: [{ key: "output", value: { stringValue: "elasticsearch" } }],
              status: { code: 2, message: "retry" },
            },
          ],
        },
      ],
    },
  ],
};

export const logsDocument: OtlpLogsDocument = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "logfwd" } }],
      },
      scopeLogs: [
        {
          scope: {
            name: "logfwd.runtime",
            version: "1.0.0",
          },
          logRecords: [
            {
              timeUnixNano: "7000000000",
              observedTimeUnixNano: "7000000100",
              severityNumber: 13,
              severityText: "WARN",
              body: { stringValue: "retry scheduled" },
              attributes: [
                { key: "output", value: { stringValue: "elasticsearch" } },
                { key: "error.type", value: { stringValue: "timeout" } },
              ],
              traceId: "trace-1",
              spanId: "child-1",
              flags: 1,
            },
          ],
        },
      ],
    },
  ],
};
