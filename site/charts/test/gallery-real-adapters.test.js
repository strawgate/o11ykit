import { describe, expect, it } from "vitest";
import { toAgChartsTimeSeriesOptions } from "../../../packages/adapters/src/agcharts.js";
import { toApexChartsLatestValuesOptions } from "../../../packages/adapters/src/apexcharts.js";
import { toChartJsTimeSeriesConfig } from "../../../packages/adapters/src/chartjs.js";
import { toEChartsHistogramOption } from "../../../packages/adapters/src/echarts.js";
import {
  toHighchartsHistogramOptions,
  toHighchartsTimeSeriesOptions,
} from "../../../packages/adapters/src/highcharts.js";
import { toNivoBarData } from "../../../packages/adapters/src/nivo.js";
import { toObservablePlotOptions } from "../../../packages/adapters/src/observable.js";
import { toPlotlyLatestValuesFigure } from "../../../packages/adapters/src/plotly.js";
import {
  toRechartsHistogramData,
  toRechartsLatestValuesData,
  toRechartsScatterData,
  toRechartsTimeSeriesData,
} from "../../../packages/adapters/src/recharts.js";
import {
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
} from "../../../packages/adapters/src/tremor.js";
import { toUPlotTimeSeriesArgs } from "../../../packages/adapters/src/uplot.js";
import { toVegaLiteSpec } from "../../../packages/adapters/src/vegalite.js";
import { toVictorySeries } from "../../../packages/adapters/src/victory.js";
import { createEngineResult, createGalleryState } from "../js/gallery-data.js";

describe("chart gallery integration with real adapters", () => {
  it("backs the Tremor gallery examples with implemented prop adapters", () => {
    const result = createEngineResult();
    const line = toTremorLineChartProps(result, { seriesLabel: gallerySeriesLabel });
    const donut = toTremorDonutChartProps(result, { seriesLabel: gallerySeriesLabel });
    const barList = toTremorBarListProps(result, { seriesLabel: gallerySeriesLabel });
    const galleryLine = createGalleryState("tremor", "line").adapterOutput;

    expect(line.index).toBe("time");
    expect(line.categories).toEqual(galleryLine.categories);
    expect(line.data[0]?.time).toBe(Number((result.series[0]?.timestamps[0] ?? 0n) / 1_000_000n));
    for (const category of line.categories) {
      expect(line.data[0]?.[category]).toBe(galleryLine.data[0]?.[category]);
    }
    expect(line.meta.series).toHaveLength(result.series.length);
    expect(donut.data).toEqual(createGalleryState("tremor", "donut").adapterOutput.data);
    expect(barList.data).toEqual(createGalleryState("tremor", "barList").adapterOutput.data);
  });

  it("backs the Recharts gallery examples with implemented row and dataKey adapters", () => {
    const result = createEngineResult();
    const model = toRechartsTimeSeriesData(result, {
      seriesLabel: gallerySeriesLabel,
      unit: "ms",
    });
    const galleryLine = createGalleryState("recharts", "line").adapterOutput;

    expect(model.xAxisKey).toBe(galleryLine.xAxisKey);
    expect(model.tooltipKey).toBe(galleryLine.tooltipKey);
    expect(model.series).toEqual(galleryLine.series);
    expect(model.data).toEqual(galleryLine.data);
    expect(toRechartsLatestValuesData(result, { seriesLabel: gallerySeriesLabel })).toEqual(
      createGalleryState("recharts", "donut").adapterOutput
    );
    expect(toRechartsHistogramData(result, { seriesLabel: gallerySeriesLabel })).toEqual(
      createGalleryState("recharts", "histogram").adapterOutput
    );
    expect(toRechartsScatterData(result, { seriesLabel: gallerySeriesLabel })).toEqual(
      createGalleryState("recharts", "scatter").adapterOutput
    );
  });

  it("backs package-rendered gallery examples with exported engine adapters", () => {
    const result = createEngineResult();
    expect(
      toChartJsTimeSeriesConfig(result, { seriesLabel: gallerySeriesLabel }).data.datasets
    ).toEqual(createGalleryState("chartjs", "line").adapterOutput.data.datasets);
    expect(toEChartsHistogramOption(result, { seriesLabel: gallerySeriesLabel }).dataset).toEqual(
      createGalleryState("echarts", "histogram").adapterOutput.dataset
    );
    expect(toUPlotTimeSeriesArgs(result, { seriesLabel: gallerySeriesLabel }).data).toEqual(
      createGalleryState("uplot", "line").adapterOutput.data
    );
    expect(toNivoBarData(result, { seriesLabel: gallerySeriesLabel })).toEqual(
      createGalleryState("nivo", "bar").adapterOutput
    );
    expect(toObservablePlotOptions(result, { seriesLabel: gallerySeriesLabel }).marks).toEqual(
      createGalleryState("observable", "line").adapterOutput.marks
    );
    expect(toPlotlyLatestValuesFigure(result, { seriesLabel: gallerySeriesLabel }).data).toEqual(
      createGalleryState("plotly", "donut").adapterOutput.data
    );
    expect(
      toApexChartsLatestValuesOptions(result, {
        chartType: "gauge",
        seriesLabel: gallerySeriesLabel,
      }).series
    ).toEqual(createGalleryState("apexcharts", "gauge").adapterOutput.series);
    expect(
      toVictorySeries(result, { seriesLabel: gallerySeriesLabel }).map((series) => series.component)
    ).toEqual(
      createGalleryState("victory", "line").adapterOutput.map((series) => series.component)
    );
    expect(toAgChartsTimeSeriesOptions(result, { seriesLabel: gallerySeriesLabel }).series).toEqual(
      createGalleryState("agcharts", "line").adapterOutput.series
    );
    expect(
      toHighchartsTimeSeriesOptions(result, { seriesLabel: gallerySeriesLabel }).series
    ).toEqual(createGalleryState("highcharts", "line").adapterOutput.series);
    expect(
      toHighchartsHistogramOptions(result, { seriesLabel: gallerySeriesLabel }).series
    ).toEqual(createGalleryState("highcharts", "histogram").adapterOutput.series);
    expect(toVegaLiteSpec(result, { seriesLabel: gallerySeriesLabel }).mark).toBe(
      createGalleryState("vegalite", "line").adapterOutput.mark
    );
  });
});

function gallerySeriesLabel(series) {
  return [
    series.labels.get("service") ?? "service",
    series.labels.get("route") ?? "route",
    series.labels.get("status_class") ?? "status",
  ].join(" ");
}
