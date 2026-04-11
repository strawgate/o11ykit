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
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
  traceWaterfallToLaneRows,
} from "../src/index.js";
import { histogramRows, pivotTimeSeriesFrame } from "../src/shared.js";

describe("@otlpkit/adapters", () => {
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
