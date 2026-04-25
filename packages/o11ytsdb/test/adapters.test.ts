import { describe, expect, it } from "vitest";
import {
  toTsdbLatestValueModel,
  toTsdbLineSeriesModel,
  toTsdbWideTableModel,
} from "../src/adapters.js";
import type { QueryResult } from "../src/types.js";

function labels(entries: readonly [string, string][]): ReadonlyMap<string, string> {
  return new Map(entries);
}

describe("native TSDB adapters", () => {
  const result: QueryResult = {
    scannedSeries: 2,
    scannedSamples: 5,
    series: [
      {
        labels: labels([
          ["__name__", "cpu"],
          ["host", "a"],
        ]),
        timestamps: new BigInt64Array([1_000_000n, 2_000_000n, 3_000_000n]),
        values: new Float64Array([1, 2, 3]),
      },
      {
        labels: labels([
          ["__name__", "cpu"],
          ["host", "b"],
        ]),
        timestamps: new BigInt64Array([2_000_000n, 3_000_000n]),
        values: new Float64Array([20, 30]),
      },
    ],
  };

  it("builds line-series points directly from QueryResult", () => {
    const model = toTsdbLineSeriesModel(result);

    expect(model.kind).toBe("tsdb-line-series");
    expect(model.series).toHaveLength(2);
    expect(model.series[0]?.label).toBe("cpu{host=a}");
    expect(model.series[0]?.points).toEqual([
      { t: 1, v: 1 },
      { t: 2, v: 2 },
      { t: 3, v: 3 },
    ]);
  });

  it("builds a timestamp-aligned wide table", () => {
    const model = toTsdbWideTableModel(result);

    expect(model.columns).toEqual(["t", "cpu{host=a}", "cpu{host=b}"]);
    expect(model.rows).toEqual([
      { t: 1, values: [1, null] },
      { t: 2, values: [2, 20] },
      { t: 3, values: [3, 30] },
    ]);
  });

  it("builds latest-value rows with custom labels and timestamp units", () => {
    const model = toTsdbLatestValueModel(result, {
      timestampUnit: "milliseconds",
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });

    expect(model.rows).toEqual([
      {
        id: "__name__=cpu\0host=a",
        label: "a",
        labels: result.series[0]?.labels,
        t: 3_000_000,
        value: 3,
      },
      {
        id: "__name__=cpu\0host=b",
        label: "b",
        labels: result.series[1]?.labels,
        t: 3_000_000,
        value: 30,
      },
    ]);
  });

  it("rejects malformed query results with mismatched point arrays", () => {
    const bad: QueryResult = {
      scannedSeries: 1,
      scannedSamples: 1,
      series: [
        {
          labels: labels([["__name__", "bad"]]),
          timestamps: new BigInt64Array([1n, 2n]),
          values: new Float64Array([1]),
        },
      ],
    };

    expect(() => toTsdbLineSeriesModel(bad)).toThrow(/mismatched/);
  });
});
