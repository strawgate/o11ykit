import { describe, expect, it } from "vitest";

import { metricsDocument, tracesDocument } from "../../otlpjson/test/fixtures.js";
import {
  buildHistogramFrame,
  buildLatestValuesFrame,
  buildTimeSeriesFrame,
  buildTraceWaterfallFrame,
} from "../../views/src/index.js";
import {
  toEngineHistogramModel,
  toEngineLatestValueModel,
  toEngineLineSeriesModel,
  toEngineWideTableModel,
} from "../src/engine.js";
import * as adapterBarrel from "../src/index.js";
import {
  toAgChartsLatestValuesOptions,
  toAgChartsTimeSeriesOptions,
  toAgChartsUpdateDelta,
  toApexChartsLatestValuesOptions,
  toApexChartsSeriesUpdate,
  toApexChartsTimeSeriesOptions,
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsTimeSeriesConfig,
  toChartJsViewHistogramConfig,
  toChartJsViewLatestValuesConfig,
  toChartJsViewLineConfig,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toEChartsViewHistogramOption,
  toEChartsViewLatestValuesOption,
  toEChartsViewTimeSeriesOption,
  toHighchartsTimeSeriesOptions,
  toNivoBarData,
  toNivoBarProps,
  toNivoLineProps,
  toNivoLineSeries,
  toNivoPieProps,
  toObservablePlotOptions,
  toPlotlyHistogramFigure,
  toPlotlyLatestValuesFigure,
  toPlotlyTimeSeriesFigure,
  toRechartsHistogramData,
  toRechartsLatestValuesData,
  toRechartsScatterData,
  toRechartsTimeSeriesData,
  toRechartsViewHistogramData,
  toRechartsViewLatestValuesData,
  toRechartsViewTimeSeriesData,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
  toUPlotTimeSeriesArgs,
  toUPlotViewLatestValuesArgs,
  toUPlotViewTimeSeriesArgs,
  toVegaLiteSpec,
  toVictoryChartProps,
  toVictoryLatestData,
  toVictorySeries,
  toVisxHistogramModel,
  toVisxXYChartModel,
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
    const line = toChartJsViewLineConfig(timeSeriesFrame);
    const latest = toChartJsViewLatestValuesConfig(latestValuesFrame);
    const histogram = toChartJsViewHistogramConfig(histogramFrame);

    expect(line.type).toBe("line");
    expect(line.data.datasets).toHaveLength(2);
    expect(line.options.parsing).toBe(false);
    expect(latest.type).toBe("bar");
    expect(latest.data.labels).toHaveLength(2);
    expect(histogram.data.datasets[0]?.data.length).toBeGreaterThan(0);
  });

  it("builds native-feeling Recharts models", () => {
    const timeSeries = toRechartsViewTimeSeriesData(timeSeriesFrame);
    const latest = toRechartsViewLatestValuesData(latestValuesFrame);
    const histogram = toRechartsViewHistogramData(histogramFrame);

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

  it("builds exported engine adapters for package-rendered chart libraries", () => {
    const wide = toEngineWideTableModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const latest = toEngineLatestValueModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const histogram = toEngineHistogramModel(wide, { bucketCount: 3 });

    expect(toChartJsTimeSeriesConfig(wide).data.datasets[0]?.parsing).toBe(false);
    expect(toChartJsLatestValuesConfig(latest, { chartType: "donut" }).type).toBe("doughnut");
    expect(toChartJsHistogramConfig(histogram).data.labels).toHaveLength(3);
    expect(toEChartsTimeSeriesOption(wide).series[0]?.encode.x).toBe("time");
    expect(toEChartsLatestValuesOption(latest, { chartType: "gauge" }).series[0]?.type).toBe(
      "gauge"
    );
    expect(toEChartsHistogramOption(histogram).dataset[0]?.source).toHaveLength(3);
    expect(toUPlotTimeSeriesArgs(wide).data).toHaveLength(3);
    expect(toNivoBarData(wide).keys).toEqual(["__name__=cpu,host=a", "__name__=cpu,host=b"]);
    expect(toNivoLineProps(wide, { chartType: "sparkline" }).enablePoints).toBe(false);
    expect(toNivoPieProps(latest).value).toBe("value");
    expect(toObservablePlotOptions(wide).marks[0]?.mark).toBe("lineY");
    expect(toObservablePlotOptions(wide).options.color?.legend).toBe(true);
    expect(toPlotlyTimeSeriesFigure(wide).data[0]?.type).toBe("scatter");
    expect(toPlotlyTimeSeriesFigure(wide).data[0]?.uid).toMatch(/^engine-0-[a-z0-9]+$/);
    expect(toPlotlyTimeSeriesFigure(wide).data[0]?.name).toBe("a");
    expect(toPlotlyLatestValuesFigure(latest).config.responsive).toBe(true);
    expect(toRechartsHistogramData(histogram).valueKey).toBe("count");
    expect(toRechartsScatterData(wide).series.map((series) => series.name)).toEqual(["a", "b"]);
    expect(toApexChartsLatestValuesOptions(latest, { chartType: "gauge" }).chart.type).toBe(
      "radialBar"
    );
    expect(toApexChartsSeriesUpdate(toApexChartsLatestValuesOptions(latest)).series).toEqual([
      3, 30,
    ]);
    expect(toVictorySeries(wide, { chartType: "area" })[0]?.component).toBe("VictoryArea");
    expect(toVictoryChartProps(wide).scale.x).toBe("time");
    expect(toAgChartsTimeSeriesOptions(wide, { chartType: "area" }).series?.[0]?.type).toBe("area");
    expect(toAgChartsUpdateDelta(toAgChartsTimeSeriesOptions(wide)).data).toHaveLength(3);
    expect(toHighchartsTimeSeriesOptions(wide).chart.type).toBe("line");
    expect(toHighchartsTimeSeriesOptions(wide).xAxis?.type).toBe("datetime");
    expect(toVegaLiteSpec(wide, { mark: "scatter" }).mark).toBe("point");
    expect(toVegaLiteSpec(wide).$schema).toContain("vega-lite");
    expect(toVisxXYChartModel(wide).data[0]?.data[0]).toEqual({ x: 1, y: 1 });
    expect(toVisxHistogramModel(histogram).xScale.type).toBe("band");
  });

  it("lets package-rendered chart adapters accept engine query results directly", () => {
    const options = {
      seriesLabel: (series: (typeof engineResult.series)[number]) =>
        series.labels.get("host") ?? "unknown",
    };

    expect(toChartJsTimeSeriesConfig(engineResult, options).data.datasets[0]?.label).toBe("a");
    expect(toChartJsLatestValuesConfig(engineResult, options).data.labels).toEqual(["a", "b"]);
    expect(
      toChartJsHistogramConfig(engineResult, { ...options, bucketCount: 3 }).data.labels
    ).toHaveLength(3);
    expect(toEChartsTimeSeriesOption(engineResult, options).dataset[0]?.source[0]?.a).toBe(1);
    expect(toEChartsLatestValuesOption(engineResult, options).dataset[0]?.source).toEqual([
      { label: "a", value: 3 },
      { label: "b", value: 30 },
    ]);
    expect(
      toEChartsHistogramOption(engineResult, { ...options, bucketCount: 3 }).series[0]?.type
    ).toBe("bar");
    expect(toUPlotTimeSeriesArgs(engineResult, options).options.series[1]?.label).toBe("a");
    expect(toNivoLineSeries(engineResult, options)[0]?.id).toBe("a");
    expect(toNivoBarData(engineResult, options).keys).toEqual([
      "__name__=cpu,host=a",
      "__name__=cpu,host=b",
    ]);
    expect(toNivoBarProps(engineResult, options).data[0]?.["__name__=cpu,host=a"]).toBe(1);
    expect(toObservablePlotOptions(engineResult, options).data[0]?.series).toBe("a");
    expect(toPlotlyTimeSeriesFigure(engineResult, options).data[0]?.name).toBe("a");
    expect(
      toPlotlyHistogramFigure(engineResult, { ...options, bucketCount: 3 }).data[0]?.type
    ).toBe("bar");
    expect(toRechartsTimeSeriesData(engineResult, options).series[0]?.name).toBe("a");
    expect(toRechartsLatestValuesData(engineResult, options).data[1]?.value).toBe(30);
    expect(toRechartsHistogramData(engineResult, { ...options, bucketCount: 3 }).data).toHaveLength(
      3
    );
    expect(toApexChartsTimeSeriesOptions(engineResult, options).series[0]?.name).toBe("a");
    expect(toApexChartsLatestValuesOptions(engineResult, options).labels).toEqual(["a", "b"]);
    expect(toVictorySeries(engineResult, options)[0]?.label).toBe("a");
    expect(toVictoryLatestData(engineResult, options)).toEqual([
      { x: "a", y: 3 },
      { x: "b", y: 30 },
    ]);
    expect(toAgChartsTimeSeriesOptions(engineResult, options).series?.[0]?.yName).toBe("a");
    expect(toAgChartsLatestValuesOptions(engineResult, options).data).toEqual([
      { label: "a", value: 3 },
      { label: "b", value: 30 },
    ]);
    expect(toHighchartsTimeSeriesOptions(engineResult, options).series?.[0]?.name).toBe("a");
    expect(toVegaLiteSpec(engineResult, options).data.values[0]?.series).toBe("a");
  });

  it("handles engine timestamp units, point budgets, and invalid query results", () => {
    const wide = toEngineWideTableModel(engineResult, {
      maxPoints: 1,
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const emptyWide = toEngineWideTableModel(engineResult, {
      maxPoints: 0,
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
    const largeNanoseconds = toEngineLineSeriesModel({
      series: [
        {
          labels: new Map([["__name__", "requests"]]),
          timestamps: new BigInt64Array([9_007_199_254_740_993_000n]),
          values: new Float64Array([10]),
        },
      ],
    });
    const safeBoundaries = toEngineLineSeriesModel(
      {
        series: [
          {
            labels: new Map([["__name__", "safe"]]),
            timestamps: new BigInt64Array([
              BigInt(Number.MIN_SAFE_INTEGER),
              BigInt(Number.MAX_SAFE_INTEGER),
            ]),
            values: new Float64Array([1, 2]),
          },
        ],
      },
      { timestampUnit: "milliseconds" }
    );

    expect(wide.rows).toEqual([{ t: 3, values: [3, 30] }]);
    expect(emptyWide.rows).toEqual([]);
    expect(seconds.series[0]?.points.map((point) => point.t)).toEqual([1000, 2000]);
    expect(milliseconds.series[0]?.points.map((point) => point.t)).toEqual([1, 2]);
    expect(largeNanoseconds.series[0]?.points[0]?.t).toBe(9_007_199_254_740);
    expect(safeBoundaries.series[0]?.points.map((point) => point.t)).toEqual([
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ]);
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
    expect(() =>
      toEngineLineSeriesModel(
        {
          series: [
            {
              labels: new Map([["__name__", "unsafe"]]),
              timestamps: new BigInt64Array([BigInt(Number.MAX_SAFE_INTEGER) + 1n]),
              values: new Float64Array([1]),
            },
          ],
        },
        { timestampUnit: "milliseconds" }
      )
    ).toThrow(/cannot be represented safely/);
    expect(() =>
      toEngineLineSeriesModel(
        {
          series: [
            {
              labels: new Map([["__name__", "unsafe"]]),
              timestamps: new BigInt64Array([BigInt(Number.MIN_SAFE_INTEGER) - 1n]),
              values: new Float64Array([1]),
            },
          ],
        },
        { timestampUnit: "milliseconds" }
      )
    ).toThrow(/cannot be represented safely/);
  });

  it("canonicalizes engine series ids and default labels", () => {
    const first = toEngineLineSeriesModel({
      series: [
        {
          labels: new Map([
            ["__name__", "latency"],
            ["route", "/checkout"],
            ["service", "api"],
          ]),
          timestamps: new BigInt64Array([1_000_000n]),
          values: new Float64Array([1]),
        },
      ],
    });
    const second = toEngineLineSeriesModel({
      series: [
        {
          labels: new Map([
            ["service", "api"],
            ["route", "/checkout"],
            ["__name__", "latency"],
          ]),
          timestamps: new BigInt64Array([1_000_000n]),
          values: new Float64Array([1]),
        },
      ],
    });

    expect(first.series[0]?.id).toBe("__name__=latency,route=/checkout,service=api");
    expect(first.series[0]?.id).toBe(second.series[0]?.id);
    expect(first.series[0]?.label).toBe("latency{route=/checkout,service=api}");
    expect(first.series[0]?.label).toBe(second.series[0]?.label);
  });

  it("builds engine-backed Recharts models", () => {
    const wide = toEngineWideTableModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const latest = toEngineLatestValueModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const histogram = toEngineHistogramModel(wide, { bucketCount: 3 });
    const timeSeries = toRechartsTimeSeriesData(wide, { unit: "%" });
    const latestValues = toRechartsLatestValuesData(latest, { unit: "%" });
    const histogramModel = toRechartsHistogramData(histogram, { unit: "count" });
    const scatter = toRechartsScatterData(wide, { unit: "%" });

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
    expect(histogramModel.data).toEqual(
      histogram.buckets.map((bucket) => ({
        label: bucket.label,
        count: bucket.count,
        start: bucket.start,
        end: bucket.end,
      }))
    );
    expect(histogramModel.unit).toBe("count");
    expect(scatter.xAxisKey).toBe("time");
    expect(scatter.yAxisKey).toBe("value");
    expect(scatter.seriesKey).toBe("series");
    expect(scatter.data[0]).toEqual({
      time: 1,
      value: 1,
      series: "a",
      id: "__name__=cpu,host=a",
    });
    expect(scatter.data[1]).toEqual({
      time: 1,
      value: null,
      series: "b",
      id: "__name__=cpu,host=b",
    });
  });

  it("keeps engine-backed Recharts data keys distinct from axis and tooltip keys", () => {
    const wide = toEngineWideTableModel({
      series: [
        {
          labels: new Map([["__name__", "time"]]),
          timestamps: new BigInt64Array([1_000_000n]),
          values: new Float64Array([1]),
        },
        {
          labels: new Map([["__name__", "tooltip"]]),
          timestamps: new BigInt64Array([1_000_000n]),
          values: new Float64Array([2]),
        },
      ],
    });
    const timeSeries = toRechartsTimeSeriesData(wide, {
      xAxisKey: "__name__=time",
      tooltipKey: "__name__=tooltip",
    });

    expect(timeSeries.xAxisKey).toBe("__name__=time");
    expect(timeSeries.tooltipKey).toBe("__name__=tooltip");
    expect(timeSeries.series.map((series) => series.dataKey)).toEqual([
      "__name__=time (2)",
      "__name__=tooltip (2)",
    ]);
    expect(timeSeries.data[0]?.["__name__=time"]).toBe(1);
    expect(timeSeries.data[0]?.["__name__=tooltip"]).toBe(1);
    expect(timeSeries.data[0]?.["__name__=time (2)"]).toBe(1);
    expect(timeSeries.data[0]?.["__name__=tooltip (2)"]).toBe(2);
  });

  it("keeps engine-backed Recharts scatter keys distinct", () => {
    const wide = toEngineWideTableModel(engineResult);

    expect(() =>
      toRechartsScatterData(wide, {
        xAxisKey: "value",
        yAxisKey: "value",
      })
    ).toThrow(/must be distinct/);
    expect(() =>
      toRechartsScatterData(wide, {
        xAxisKey: "time",
        seriesKey: "time",
      })
    ).toThrow(/must be distinct/);
  });

  it("builds Tremor-native props from engine models", () => {
    const wide = toEngineWideTableModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const latest = toEngineLatestValueModel(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const line = toTremorLineChartProps(wide, { connectNulls: false });
    const directLine = toTremorLineChartProps(engineResult, {
      connectNulls: false,
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const bar = toTremorBarChartProps(wide, { layout: "horizontal", type: "stacked" });
    const directBar = toTremorBarChartProps(engineResult, {
      layout: "horizontal",
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
      type: "stacked",
    });
    const donut = toTremorDonutChartProps(latest);
    const directDonut = toTremorDonutChartProps(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });
    const barList = toTremorBarListProps(latest);
    const directBarList = toTremorBarListProps(engineResult, {
      seriesLabel: (series) => series.labels.get("host") ?? "unknown",
    });

    expect(line.index).toBe("time");
    expect(directLine).toEqual(line);
    expect(line.categories).toEqual(["a", "b"]);
    expect(line.meta.series.map((series) => [series.id, series.key, series.label])).toEqual([
      ["__name__=cpu,host=a", "a", "a"],
      ["__name__=cpu,host=b", "b", "b"],
    ]);
    expect(line.data[1]?.a).toBeNull();
    expect(bar.layout).toBe("horizontal");
    expect(bar.type).toBe("stacked");
    expect(directBar).toEqual(bar);
    expect(donut.index).toBe("label");
    expect(donut.category).toBe("value");
    expect(directDonut).toEqual(donut);
    expect(barList.data).toEqual([
      { name: "a", value: 3 },
      { name: "b", value: 30 },
    ]);
    expect(directBarList).toEqual(barList);
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

  it("keeps Tremor data keys distinct from index and category keys", () => {
    const wide = toEngineWideTableModel(engineResult, {
      seriesLabel: () => "time",
    });
    const latest = toEngineLatestValueModel(engineResult);
    const line = toTremorLineChartProps(wide);

    expect(line.index).toBe("time");
    expect(line.categories).toEqual(["time (2)", "time (3)"]);
    expect(line.data[0]?.time).toBe(1);
    expect(line.data[0]?.["time (2)"]).toBe(1);
    expect(line.data[1]?.time).toBe(2);
    expect(line.data[1]?.["time (2)"]).toBeNull();
    expect(() =>
      toTremorDonutChartProps(latest, {
        index: "value",
        category: "value",
      })
    ).toThrow(/must be distinct/);
  });

  it("builds aligned uPlot models", () => {
    const timeSeries = toUPlotViewTimeSeriesArgs(timeSeriesFrame);
    const latest = toUPlotViewLatestValuesArgs(latestValuesFrame);

    expect(timeSeries.options.scales.x.time).toBe(true);
    expect(timeSeries.data).toHaveLength(timeSeriesFrame.series.length + 1);
    expect(timeSeries.options.series[1]?.label).toBe(timeSeriesFrame.series[0]?.label);
    expect(latest.labels).toHaveLength(latestValuesFrame.rows.length);
    expect(latest.data[0][1]).toBe(1);
    expect(latest.options.axes[1].label).toBe(latestValuesFrame.unit ?? "");
  });

  it("builds dataset-first ECharts options", () => {
    const timeSeries = toEChartsViewTimeSeriesOption(timeSeriesFrame);
    const latest = toEChartsViewLatestValuesOption(latestValuesFrame);
    const histogram = toEChartsViewHistogramOption(histogramFrame);

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

    expect(typeof adapterBarrel.adapterModules.toChartJsViewLineConfig).toBe("function");
    expect(typeof adapterBarrel.adapterModules.toAgChartsTimeSeriesOptions).toBe("function");
    expect(typeof adapterBarrel.adapterModules.toVegaLiteSpec).toBe("function");
    expect(typeof adapterBarrel.adapterModules.toVisxXYChartModel).toBe("function");
    expect("toEngineWideTableModel" in adapterBarrel.adapterModules).toBe(false);
    expect("toEngineWideTableModel" in adapterBarrel).toBe(false);
    expect(toChartJsViewLineConfig(sparseFrame).data.datasets[0]?.data[0]).toEqual({ x: 0, y: 1 });
    expect(toChartJsViewLineConfig(sparseFrame).options.scales.y.title.text).toBe("");
    expect(toEChartsViewTimeSeriesOption(sparseFrame).yAxis.name).toBe("");
    expect(toChartJsViewLatestValuesConfig(sparseLatest).options.scales.y.title.text).toBe("");
    expect(toEChartsViewLatestValuesOption(sparseLatest).yAxis.name).toBe("");
    expect(toRechartsViewTimeSeriesData(sparseFrame).data[0]?.timeMs).toBeNull();
    expect(toUPlotViewTimeSeriesArgs(sparseFrame).data[0]).toHaveLength(1);
    expect(toUPlotViewLatestValuesArgs(sparseLatest).options.axes[1].label).toBe("");
    expect(pivotTimeSeriesFrame(sparseFrame).rows).toHaveLength(2);
    expect(histogramRows(histogramFrame)[0]?.count).toBeGreaterThanOrEqual(0);
  });
});
