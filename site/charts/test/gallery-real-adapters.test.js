import { describe, expect, it } from "vitest";
import { toAgChartsEngineTimeSeriesOptions } from "../../../packages/adapters/src/agcharts.js";
import { toApexChartsEngineLatestValuesOptions } from "../../../packages/adapters/src/apexcharts.js";
import { toChartJsEngineTimeSeriesConfig } from "../../../packages/adapters/src/chartjs.js";
import { toEChartsEngineHistogramOption } from "../../../packages/adapters/src/echarts.js";
import {
  toEngineHistogramModel,
  toEngineLatestValueModel,
  toEngineWideTableModel,
} from "../../../packages/adapters/src/engine.js";
import {
  toHighchartsEngineHistogramOptions,
  toHighchartsEngineTimeSeriesOptions,
} from "../../../packages/adapters/src/highcharts.js";
import { toNivoEngineBarModel } from "../../../packages/adapters/src/nivo.js";
import { toObservablePlotEngineModel } from "../../../packages/adapters/src/observable.js";
import { toPlotlyEngineLatestValuesModel } from "../../../packages/adapters/src/plotly.js";
import {
  toRechartsEngineHistogramModel,
  toRechartsEngineLatestValuesModel,
  toRechartsEngineScatterModel,
  toRechartsEngineTimeSeriesModel,
} from "../../../packages/adapters/src/recharts.js";
import {
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
} from "../../../packages/adapters/src/tremor.js";
import { toUPlotEngineTimeSeriesModel } from "../../../packages/adapters/src/uplot.js";
import { toVegaLiteEngineSpec } from "../../../packages/adapters/src/vegalite.js";
import { toVictoryEngineSeries } from "../../../packages/adapters/src/victory.js";
import { toVisxEngineXYChartModel } from "../../../packages/adapters/src/visx.js";
import {
  createEngineResult,
  createGalleryState,
  toEngineLatestValueModel as toGalleryLatestValueModel,
  toEngineWideTableModel as toGalleryWideTableModel,
} from "../js/gallery-data.js";

describe("chart gallery integration with real adapters", () => {
  it("keeps the gallery engine fixture aligned with package engine models", () => {
    const result = createEngineResult();
    const galleryWide = toGalleryWideTableModel(result);
    const packageWide = toEngineWideTableModel(result, {
      seriesLabel: gallerySeriesLabel,
    });
    const galleryLatest = toGalleryLatestValueModel(result);
    const packageLatest = toEngineLatestValueModel(result, {
      seriesLabel: gallerySeriesLabel,
    });

    expect(galleryWide.series.map(({ id, label }) => ({ id, label }))).toEqual(
      packageWide.series.map(({ id, label }) => ({ id, label }))
    );
    expect(galleryWide.rows).toEqual(packageWide.rows);
    expect(galleryLatest.rows.map(({ id, label, t, value }) => ({ id, label, t, value }))).toEqual(
      packageLatest.rows.map(({ id, label, t, value }) => ({ id, label, t, value }))
    );
  });

  it("backs the Tremor gallery examples with implemented prop adapters", () => {
    const result = createEngineResult();
    const wide = toEngineWideTableModel(result, { seriesLabel: gallerySeriesLabel });
    const latest = toEngineLatestValueModel(result, { seriesLabel: gallerySeriesLabel });
    const line = toTremorLineChartProps(wide);
    const donut = toTremorDonutChartProps(latest);
    const barList = toTremorBarListProps(latest);
    const galleryLine = createGalleryState("tremor", "line").adapterModel;

    expect(line.index).toBe("time");
    expect(line.categories).toEqual(galleryLine.categories);
    expect(line.data[0]?.time).toBe(wide.rows[0]?.t);
    for (const category of line.categories) {
      expect(line.data[0]?.[category]).toBe(galleryLine.data[0]?.[category]);
    }
    expect(line.meta.series.map((series) => series.id)).toEqual(
      wide.series.map((series) => series.id)
    );
    expect(donut.data).toEqual(createGalleryState("tremor", "donut").adapterModel.data);
    expect(barList.data).toEqual(createGalleryState("tremor", "barList").adapterModel.data);
  });

  it("backs the Recharts gallery examples with implemented row and dataKey adapters", () => {
    const result = createEngineResult();
    const wide = toEngineWideTableModel(result, { seriesLabel: gallerySeriesLabel });
    const latest = toEngineLatestValueModel(result, { seriesLabel: gallerySeriesLabel });
    const model = toRechartsEngineTimeSeriesModel(wide, { unit: "ms" });
    const galleryLine = createGalleryState("recharts", "line").adapterModel;

    expect(model.xAxisKey).toBe(galleryLine.xAxisKey);
    expect(model.tooltipKey).toBe(galleryLine.tooltipKey);
    expect(model.series).toEqual(galleryLine.series);
    expect(model.data).toEqual(galleryLine.data);
    expect(toRechartsEngineLatestValuesModel(latest)).toEqual(
      createGalleryState("recharts", "donut").adapterModel
    );
    expect(toRechartsEngineHistogramModel(toEngineHistogramModel(wide))).toEqual(
      createGalleryState("recharts", "histogram").adapterModel
    );
    expect(toRechartsEngineScatterModel(wide)).toEqual(
      createGalleryState("recharts", "scatter").adapterModel
    );
  });

  it("backs package-rendered gallery examples with exported engine adapters", () => {
    const result = createEngineResult();
    const wide = toEngineWideTableModel(result, { seriesLabel: gallerySeriesLabel });
    const latest = toEngineLatestValueModel(result, { seriesLabel: gallerySeriesLabel });
    const histogram = toEngineHistogramModel(wide);

    expect(toChartJsEngineTimeSeriesConfig(wide).data.datasets).toEqual(
      createGalleryState("chartjs", "line").adapterModel.data.datasets
    );
    expect(toEChartsEngineHistogramOption(histogram).dataset).toEqual(
      createGalleryState("echarts", "histogram").adapterModel.dataset
    );
    expect(toUPlotEngineTimeSeriesModel(wide).data).toEqual(
      createGalleryState("uplot", "line").adapterModel.data
    );
    expect(toNivoEngineBarModel(wide)).toEqual(createGalleryState("nivo", "bar").adapterModel);
    expect(toObservablePlotEngineModel(wide).marks).toEqual(
      createGalleryState("observable", "line").adapterModel.marks
    );
    expect(toPlotlyEngineLatestValuesModel(latest).data).toEqual(
      createGalleryState("plotly", "donut").adapterModel.data
    );
    expect(toApexChartsEngineLatestValuesOptions(latest, { chartType: "gauge" }).series).toEqual(
      createGalleryState("apexcharts", "gauge").adapterModel.series
    );
    expect(toVictoryEngineSeries(wide).map((series) => series.component)).toEqual(
      createGalleryState("victory", "line").adapterModel.map((series) => series.component)
    );
    expect(toAgChartsEngineTimeSeriesOptions(wide).series).toEqual(
      createGalleryState("agcharts", "line").adapterModel.series
    );
    expect(toHighchartsEngineTimeSeriesOptions(wide).series).toEqual(
      createGalleryState("highcharts", "line").adapterModel.series
    );
    expect(toHighchartsEngineHistogramOptions(histogram).series).toEqual(
      createGalleryState("highcharts", "histogram").adapterModel.series
    );
    expect(toVegaLiteEngineSpec(wide).mark).toBe(
      createGalleryState("vegalite", "line").adapterModel.mark
    );
    expect(toVisxEngineXYChartModel(wide).data[0]?.key).toBe(
      createGalleryState("visx", "line").adapterModel.data[0]?.key
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
