import type { OtlpMetricsDocument } from "@otlpkit/otlpjson";

const SECOND_IN_NANOS = 1_000_000_000n;

function timeUnixNano(second: number): string {
  return (BigInt(second) * SECOND_IN_NANOS).toString();
}

function gaugePoints(
  values: readonly [number, number][],
  dimensionKey: string,
  dimensionValue: string
) {
  return values.map(([second, value]) => ({
    timeUnixNano: timeUnixNano(second),
    attributes: [{ key: dimensionKey, value: { stringValue: dimensionValue } }],
    asInt: String(value),
  }));
}

function gaugeDoublePoints(
  values: readonly [number, number][],
  dimensionKey: string,
  dimensionValue: string
) {
  return values.map(([second, value]) => ({
    timeUnixNano: timeUnixNano(second),
    attributes: [{ key: dimensionKey, value: { stringValue: dimensionValue } }],
    asDouble: value,
  }));
}

function singlePoint(second: number, value: number, dimensionKey: string, dimensionValue: string) {
  return {
    timeUnixNano: timeUnixNano(second),
    attributes: [{ key: dimensionKey, value: { stringValue: dimensionValue } }],
    asDouble: value,
  };
}

const requestDurationHistogramPoints = [
  { second: 5, count: 16, sum: 1740, route: "/checkout" },
  { second: 6, count: 14, sum: 1450, route: "/checkout" },
  { second: 7, count: 17, sum: 2160, route: "/checkout" },
  { second: 8, count: 15, sum: 1410, route: "/inventory" },
  { second: 9, count: 16, sum: 1490, route: "/inventory" },
  { second: 10, count: 15, sum: 1320, route: "/inventory" },
  { second: 11, count: 14, sum: 1270, route: "/payment" },
  { second: 12, count: 16, sum: 1510, route: "/payment" },
  { second: 13, count: 15, sum: 1360, route: "/payment" },
].map(({ second, count, sum, route }) => ({
  timeUnixNano: timeUnixNano(second),
  startTimeUnixNano: timeUnixNano(Math.max(1, second - 1)),
  attributes: [{ key: "route", value: { stringValue: route } }],
  count: String(count),
  sum,
  bucketCounts: ["2", "4", "5", String(Math.max(0, count - 11))],
  explicitBounds: [80, 120, 180, 260],
  min: 58,
  max: 320,
}));

export const demoMetricsDocument: OtlpMetricsDocument = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "octo-shop" } },
          { key: "service.version", value: { stringValue: "2.9.3" } },
          { key: "deployment.environment", value: { stringValue: "demo-night-shift" } },
        ],
      },
      scopeMetrics: [
        {
          scope: {
            name: "demo.storyline.telemetry",
            version: "1.0.0",
          },
          metrics: [
            {
              name: "checkout.inflight_requests",
              unit: "1",
              gauge: {
                dataPoints: [
                  ...gaugePoints(
                    [
                      [1, 42],
                      [2, 48],
                      [3, 54],
                      [4, 61],
                      [5, 66],
                      [6, 64],
                      [7, 58],
                      [8, 53],
                      [9, 45],
                      [10, 39],
                    ],
                    "route",
                    "/checkout"
                  ),
                  ...gaugePoints(
                    [
                      [1, 33],
                      [2, 36],
                      [3, 44],
                      [4, 57],
                      [5, 63],
                      [6, 60],
                      [7, 49],
                      [8, 44],
                      [9, 38],
                      [10, 30],
                    ],
                    "route",
                    "/inventory"
                  ),
                  ...gaugePoints(
                    [
                      [1, 21],
                      [2, 26],
                      [3, 33],
                      [4, 48],
                      [5, 52],
                      [6, 47],
                      [7, 41],
                      [8, 35],
                      [9, 28],
                      [10, 23],
                    ],
                    "route",
                    "/payment"
                  ),
                ],
              },
            },
            {
              name: "checkout.error_rate",
              unit: "%",
              gauge: {
                dataPoints: [
                  singlePoint(10, 2.4, "route", "/checkout"),
                  singlePoint(10, 1.6, "route", "/inventory"),
                  singlePoint(10, 3.2, "route", "/payment"),
                ],
              },
            },
            {
              name: "checkout.retry_rate",
              unit: "%",
              gauge: {
                dataPoints: [
                  ...gaugeDoublePoints(
                    [
                      [1, 0.8],
                      [2, 0.9],
                      [3, 1.2],
                      [4, 1.8],
                      [5, 2.4],
                      [6, 2.1],
                      [7, 1.7],
                      [8, 1.4],
                      [9, 1.2],
                      [10, 0.9],
                    ],
                    "route",
                    "/checkout"
                  ),
                  ...gaugeDoublePoints(
                    [
                      [1, 0.6],
                      [2, 0.7],
                      [3, 0.9],
                      [4, 1.3],
                      [5, 1.5],
                      [6, 1.3],
                      [7, 1.1],
                      [8, 1.0],
                      [9, 0.8],
                      [10, 0.7],
                    ],
                    "route",
                    "/inventory"
                  ),
                  ...gaugeDoublePoints(
                    [
                      [1, 1.1],
                      [2, 1.2],
                      [3, 1.5],
                      [4, 2.5],
                      [5, 3.4],
                      [6, 3.1],
                      [7, 2.8],
                      [8, 2.2],
                      [9, 1.7],
                      [10, 1.4],
                    ],
                    "route",
                    "/payment"
                  ),
                ],
              },
            },
            {
              name: "checkout.request.duration_ms",
              unit: "ms",
              histogram: {
                aggregationTemporality: 2,
                dataPoints: requestDurationHistogramPoints,
              },
            },
            {
              name: "collector.cpu_percent",
              unit: "%",
              gauge: {
                dataPoints: [
                  ...gaugePoints(
                    [
                      [1, 28],
                      [2, 31],
                      [3, 34],
                      [4, 39],
                      [5, 43],
                      [6, 41],
                      [7, 37],
                      [8, 35],
                      [9, 30],
                      [10, 26],
                    ],
                    "pod",
                    "collector-a"
                  ),
                  ...gaugePoints(
                    [
                      [1, 25],
                      [2, 27],
                      [3, 32],
                      [4, 35],
                      [5, 39],
                      [6, 36],
                      [7, 33],
                      [8, 31],
                      [9, 28],
                      [10, 24],
                    ],
                    "pod",
                    "collector-b"
                  ),
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};
