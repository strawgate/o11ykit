import type { OtlpMetricsDocument } from "@otlpkit/otlpjson";

export const sampleMetricsDocument: OtlpMetricsDocument = {
  resourceMetrics: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "logfwd" } }],
      },
      scopeMetrics: [
        {
          scope: {
            name: "logfwd.pipeline",
            version: "1.0.0",
          },
          metrics: [
            {
              name: "logfwd.inflight_batches",
              unit: "1",
              gauge: {
                dataPoints: [
                  {
                    timeUnixNano: "1000000000",
                    attributes: [{ key: "output", value: { stringValue: "elasticsearch" } }],
                    asInt: "2",
                  },
                  {
                    timeUnixNano: "2000000000",
                    attributes: [{ key: "output", value: { stringValue: "elasticsearch" } }],
                    asInt: "3",
                  },
                  {
                    timeUnixNano: "1000000000",
                    attributes: [{ key: "output", value: { stringValue: "loki" } }],
                    asInt: "1",
                  },
                  {
                    timeUnixNano: "2000000000",
                    attributes: [{ key: "output", value: { stringValue: "loki" } }],
                    asInt: "4",
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
