import { describe, expect, it } from "vitest";

import { metricsDocument, tracesDocument } from "../../otlpjson/test/fixtures.js";
import {
  buildHistogramFrame,
  buildLatestValuesFrame,
  buildTimeSeriesFrame,
  buildTraceWaterfallFrame,
} from "../../views/src/index.js";
import * as adapterBarrel from "../src/index.js";
import {
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsLineConfig,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toEngineLatestValueModel,
  toEngineLineSeriesModel,
  toEngineWideTableModel,
  toRechartsEngineLatestValuesModel,
  toRechartsEngineTimeSeriesModel,
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
  traceWaterfallToLaneRows,
} from "../src/index.js";
import { histogramRows, pivotTimeSeriesFrame } from "../src/shared.js";

describe("@otlpkit/adapters", () => {
  const engineResult = {
    scannedSeries: 2,
    scannedSamples: 5,
    series: [
      {
        labels: new Map([
          ["__name__", "cpu"],
          ["host", "a"],
        ]),
        timestamps: new BigInt64Array([1_000_000n, 2_000_000n, 3_000_000n]),
        values: new Float64Array([1, Number.NaN, 3]),
      },
      {
        labels: new Map([
          ["__name__", "cpu"],
          ["host", "b"],
        ]),
        timestamps: new BigInt64Array([2_000_000n, 3_000_000n]),
        values: new Float64Array([20, 30]),
      },
    ],
  };
  const timeSeriesFrame = buildTimeSeriesFrame(metricsDocument, {
    metricName: "logfwd.inflight_batches",
    intervalMs: 1000,
    splitBy: "output",
  });
  const latestValuesFrame = buildLatestValuesFrame(metricsDocument, {
    metricName: "logfwd.inflight_batches",
    splitBy: "output",
  });
  const histogramFrame = buildHistogramFrame(metricsDocument, {
    metricName: "logfwd.output.duration",
    binCount: 4,
  });

  it("builds native-feeling Chart.js configs", () => {
    const line = toChartJsLineConfig(timeSeriesFrame);
    const latest = toChartJsLatestValuesConfig(latestValuesFrame);
    const histogram = toChartJsHistogramConfig(histogramFrame);

    expect(line.type).toBe("line");
    expect(line.data.datasets).toHaveLength(2);
    expect(line.options.parsing).toBe(false);
    expect(latest.type).toBe("bar");
    expect(latest.data.labels).toHaveLength(2);
    expect(histogram.data.datasets[0]?.data.length).toBeGreaterThan(0);
  });

  it("builds native-feeling Recharts models", () => {
    const timeSeries = toRechartsTimeSeriesModel(timeSeriesFrame);
    const latest = toRechartsLatestValuesModel(latestValuesFrame);
    const histogram = toRechartsHistogramModel(histogramFrame);

    expect(timeSeries.xAxisKey).toBe("timeMs");
    expect(timeSeries.series).toHaveLength(2);
    expect(latest.categoryKey).toBe("label");
    expect(histogram.valueKey).toBe("count");
  });

  it("builds shared engine chart models from query results", () => {
    const line = toEngineLineSeriesModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const wide = toEngineWideTableModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const latest = toEngineLatestValueModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });

    expect(line.series[0]?.points).toEqual([
      { t: 1, v: 1 },
      { t: 2, v: null },
      { t: 3, v: 3 },
    ]);
    expect(wide.columns).toEqual(["t", "a", "b"]);
    expect(wide.rows).toEqual([
      { t: 1, values: [1, null] },
      { t: 2, values: [null, 20] },
      { t: 3, values: [3, 30] },
    ]);
    expect(latest.rows.map((row) => [row.label, row.value])).toEqual([
      ["a", 3],
      ["b", 30],
    ]);
  });

  it("handles engine timestamp units, point budgets, and invalid query results", () => {
    const wide = toEngineWideTableModel(engineResult, {
      maxPoints: 1,
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const seconds = toEngineLineSeriesModel(
      {
        series: [
          {
            labels: new Map([["__name__", "requests"]]),
            timestamps: new BigInt64Array([1n, 2n]),
            values: new Float64Array([10, 20]),
          },
        ],
      },
      { timestampUnit: "seconds" }
    );
    const milliseconds = toEngineLineSeriesModel(
      {
        series: [
          {
            labels: new Map([["__name__", "requests"]]),
            timestamps: new BigInt64Array([1n, 2n]),
            values: new Float64Array([10, 20]),
          },
        ],
      },
      { timestampUnit: "milliseconds" }
    );

    expect(wide.rows).toEqual([{ t: 3, values: [3, 30] }]);
    expect(seconds.series[0]?.points.map((point) => point.t)).toEqual([1000, 2000]);
    expect(milliseconds.series[0]?.points.map((point) => point.t)).toEqual([1, 2]);
    expect(() =>
      toEngineLineSeriesModel({
        series: [
          {
            labels: new Map([["__name__", "broken"]]),
            timestamps: new BigInt64Array([1n, 2n]),
            values: new Float64Array([1]),
          },
        ],
      })
    ).toThrow(/mismatched timestamps/);
  });

  it("builds engine-backed Recharts models", () => {
    const wide = toEngineWideTableModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const latest = toEngineLatestValueModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const timeSeries = toRechartsEngineTimeSeriesModel(wide, { unit: "%" });
    const latestValues = toRechartsEngineLatestValuesModel(latest, { unit: "%" });

    expect(timeSeries.xAxisKey).toBe("time");
    expect(timeSeries.series).toEqual([
      { id: "__name__=cpu,host=a", dataKey: "__name__=cpu,host=a", name: "a" },
      { id: "__name__=cpu,host=b", dataKey: "__name__=cpu,host=b", name: "b" },
    ]);
    expect(timeSeries.data[1]?.["__name__=cpu,host=a"]).toBeNull();
    expect(timeSeries.unit).toBe("%");
    expect(latestValues.data).toEqual([
      { label: "a", value: 3 },
      { label: "b", value: 30 },
    ]);
  });

  it("builds Tremor-native props from engine models", () => {
    const wide = toEngineWideTableModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const latest = toEngineLatestValueModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const line = toTremorLineChartProps(wide, { connectNulls: false });
    const bar = toTremorBarChartProps(wide, { layout: "horizontal", type: "stacked" });
    const donut = toTremorDonutChartProps(latest);
    const barList = toTremorBarListProps(latest);

    expect(line.index).toBe("time");
    expect(line.categories).toEqual(["a", "b"]);
    expect(line.meta.series.map((series) => [series.id, series.key, series.label])).toEqual([
      ["__name__=cpu,host=a", "a", "a"],
      ["__name__=cpu,host=b", "b", "b"],
    ]);
    expect(line.data[1]?.a).toBeNull();
    expect(bar.layout).toBe("horizontal");
    expect(bar.type).toBe("stacked");
    expect(donut.index).toBe("label");
    expect(donut.category).toBe("value");
    expect(barList.data).toEqual([
      { name: "a", value: 3 },
      { name: "b", value: 30 },
    ]);
  });

  it("keeps Tremor legends readable and filters null latest values", () => {
    const wide = toEngineWideTableModel(engineResult, {
      seriesLabel: () => "cpu",
    });
    const latest = toEngineLatestValueModel({
      series: [
        {
          labels: new Map([
            ["__name__", "cpu"],
            ["host", "a"],
          ]),
          timestamps: new BigInt64Array([1_000_000n]),
          values: new Float64Array([Number.NaN]),
        },
        {
          labels: new Map([
            ["__name__", "cpu"],
            ["host", "b"],
          ]),
          timestamps: new BigInt64Array([1_000_000n]),
          values: new Float64Array([30]),
        },
      ],
    });
    const line = toTremorLineChartProps(wide);
    const renamed = toTremorLineChartProps(wide, {
      categoryLabel: (_series, index) => `CPU ${index + 1}`,
    });
    const donut = toTremorDonutChartProps(latest);
    const barList = toTremorBarListProps(latest);

    expect(line.categories).toEqual(["cpu", "cpu (2)"]);
    expect(line.data[0]?.cpu).toBe(1);
    expect(line.data[0]?.["cpu (2)"]).toBeNull();
    expect(renamed.categories).toEqual(["CPU 1", "CPU 2"]);
    expect(donut.data).toEqual([{ label: "cpu{host=b}", value: 30 }]);
    expect(barList.data).toEqual([{ name: "cpu{host=b}", value: 30 }]);
  });

  it("builds aligned uPlot models", () => {
    const timeSeries = toUPlotTimeSeriesModel(timeSeriesFrame);
    const latest = toUPlotLatestValuesModel(latestValuesFrame);

    expect(timeSeries.options.scales.x.time).toBe(true);
    expect(timeSeries.data).toHaveLength(timeSeriesFrame.series.length + 1);
    expect(timeSeries.options.series[1]?.label).toBe(timeSeriesFrame.series[0]?.label);
    expect(latest.labels).toHaveLength(latestValuesFrame.rows.length);
    expect(latest.data[0][1]).toBe(1);
    expect(latest.options.axes[1].label).toBe(latestValuesFrame.unit ?? "");
  });

  it("builds dataset-first ECharts options", () => {
    const timeSeries = toEChartsTimeSeriesOption(timeSeriesFrame);
    const latest = toEChartsLatestValuesOption(latestValuesFrame);
    const histogram = toEChartsHistogramOption(histogramFrame);

    expect(timeSeries.dataset[0]?.id).toBe("telemetry");
    expect(timeSeries.series[0]?.encode.x).toBe("timeMs");
    expect(latest.series[0]?.type).toBe("bar");
    expect(histogram.dataset[0]?.source.length).toBeGreaterThan(0);
  });

  it("projects trace waterfalls into lane rows", () => {
    const lanes = traceWaterfallToLaneRows(buildTraceWaterfallFrame(tracesDocument));
    expect(lanes).toHaveLength(2);
    expect(lanes[1]?.depth).toBe(1);
  });

  it("covers barrel exports and null-unit fallbacks", () => {
    const sparseFrame = {
      kind: "time-series" as const,
      signal: "metrics" as const,
      title: "Sparse",
      unit: null,
      intervalMs: 1000,
      series: [
        {
          key: "a",
          label: "A",
          points: [
            {
              timeUnixNano: "1000",
              timeMs: null,
              isoTime: null,
              value: 1,
              samples: 1,
            },
            {
              timeUnixNano: "2000",
              timeMs: 2,
              isoTime: "1970-01-01T00:00:00.002Z",
              value: 2,
              samples: 1,
            },
          ],
        },
      ],
    };
    const sparseLatest = {
      kind: "latest-values" as const,
      signal: "metrics" as const,
      title: "Sparse latest",
      unit: null,
      rows: [
        {
          key: "a",
          label: "A",
          value: 1,
          timeUnixNano: null,
          timeMs: null,
          isoTime: null,
          attributes: {},
          resource: {},
          scope: {
            name: null,
            version: null,
            attributes: {},
          },
        },
      ],
    };

    expect(typeof adapterBarrel.adapterModules.toChartJsLineConfig).toBe("function");
    expect(toChartJsLineConfig(sparseFrame).data.datasets[0]?.data[0]).toEqual({ x: 0, y: 1 });
    expect(toChartJsLineConfig(sparseFrame).options.scales.y.title.text).toBe("");
    expect(toEChartsTimeSeriesOption(sparseFrame).yAxis.name).toBe("");
    expect(toChartJsLatestValuesConfig(sparseLatest).options.scales.y.title.text).toBe("");
    expect(toEChartsLatestValuesOption(sparseLatest).yAxis.name).toBe("");
    expect(toRechartsTimeSeriesModel(sparseFrame).data[0]?.timeMs).toBeNull();
    expect(toUPlotTimeSeriesModel(sparseFrame).data[0]).toHaveLength(1);
    expect(toUPlotLatestValuesModel(sparseLatest).options.axes[1].label).toBe("");
    expect(pivotTimeSeriesFrame(sparseFrame).rows).toHaveLength(2);
    expect(histogramRows(histogramFrame)[0]?.count).toBeGreaterThanOrEqual(0);
  });
});
