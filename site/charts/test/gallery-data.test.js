import { describe, expect, it } from "vitest";

import {
  CHART_TYPES,
  createEngineResult,
  createGalleryState,
  createLibraryGalleryState,
  getSupportedChart,
  LIBRARIES,
  serializableAdapterModel,
  toEngineLatestValueModel,
  toEngineWideTableModel,
  toHistogramModel,
} from "../js/gallery-data.js";

describe("chart gallery data", () => {
  it("builds one deterministic engine-shaped result for every gallery adapter", () => {
    const result = createEngineResult();
    const wide = toEngineWideTableModel(result);
    const latest = toEngineLatestValueModel(result);
    const histogram = toHistogramModel(wide);

    expect(result.series).toHaveLength(4);
    expect(wide.rows).toHaveLength(18);
    expect(LIBRARIES).toHaveLength(14);
    expect(CHART_TYPES).toHaveLength(9);
    expect(wide.series.map((series) => series.label)).toEqual([
      "checkout /cart 2xx",
      "checkout /pay 5xx",
      "api /search 2xx",
      "worker /jobs 2xx",
    ]);
    expect(latest.rows).toHaveLength(4);
    expect(histogram.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(72);
  });

  it("creates library-native adapter previews for each supported chart type", () => {
    for (const library of LIBRARIES) {
      for (const chart of library.charts) {
        const gallery = createGalleryState(library.id, chart);
        const output = serializableAdapterModel(gallery.adapterModel);

        expect(gallery.library.id).toBe(library.id);
        expect(gallery.chartType).toBe(chart);
        expect(output).toBeTruthy();
        expect(gallery.snippets.query).toContain("engine.query");
        expect(gallery.snippets.adapter).toContain("toEngine");
      }
    }
  });

  it("builds a full gallery from one shared engine result per library", () => {
    for (const library of LIBRARIES) {
      const gallery = createLibraryGalleryState(library.id);

      expect(gallery.library.id).toBe(library.id);
      expect(gallery.charts.map((chart) => chart.chartType)).toEqual(library.charts);
      for (const chart of gallery.charts) {
        expect(chart.result).toBe(gallery.result);
        expect(chart.wide).toBe(gallery.wide);
        expect(chart.latest).toBe(gallery.latest);
        expect(chart.histogram).toBe(gallery.histogram);
        expect(serializableAdapterModel(chart.adapterModel)).toBeTruthy();
      }
    }
  });

  it("marks exported adapter snippets separately from adapter-shape-only sketches", () => {
    for (const library of LIBRARIES) {
      const gallery = createGalleryState(library.id, library.charts[0]);

      expect(library.package).toBeTruthy();
      if (library.status === "implemented" || library.status === "exported") {
        expect(library.package).toContain("@otlpkit/adapters/");
        expect(gallery.snippets.adapter).toContain(library.package);
        expect(gallery.snippets.adapter).not.toContain("not exported yet");
      } else {
        expect(library.package).not.toContain("@otlpkit/adapters/");
        expect(gallery.snippets.adapter).toContain("not exported yet");
      }
    }
  });

  it("falls back to the first natural chart type when a library does not support a shape", () => {
    expect(getSupportedChart("uplot", "donut")).toBe("line");
    expect(getSupportedChart("tremor", "donut")).toBe("donut");
  });

  it("emits recognizable native shapes for key libraries", () => {
    expect(createGalleryState("tremor", "line").adapterModel).toMatchObject({
      index: "time",
      categories: expect.arrayContaining(["checkout /cart 2xx"]),
    });
    expect(createGalleryState("recharts", "line").adapterModel).toMatchObject({
      xAxisKey: "time",
      series: expect.arrayContaining([
        expect.objectContaining({
          dataKey: "__name__=http.server.duration,route=/cart,service=checkout,status_class=2xx",
        }),
      ]),
    });
    expect(createGalleryState("echarts", "line").adapterModel.dataset[0].dimensions).toEqual([
      "time",
      "checkout /cart 2xx",
      "checkout /pay 5xx",
      "api /search 2xx",
      "worker /jobs 2xx",
    ]);
    expect(createGalleryState("uplot", "line").adapterModel.data).toHaveLength(5);
    expect(createGalleryState("plotly", "donut").adapterModel.data[0].type).toBe("pie");
    expect(createGalleryState("apexcharts", "gauge").adapterModel.chart.type).toBe("radialBar");
    expect(createGalleryState("nivo", "bar").adapterModel).toMatchObject({
      indexBy: "time",
      keys: expect.arrayContaining([
        "__name__=http.server.duration,route=/cart,service=checkout,status_class=2xx",
      ]),
    });
    expect(createGalleryState("observable", "sparkline").adapterModel.marks[0].mark).toBe("lineY");
    expect(createGalleryState("victory", "bar").adapterModel[0]).toMatchObject({
      x: "checkout /cart 2xx",
      y: expect.any(Number),
    });
    expect(createGalleryState("agcharts", "area").adapterModel.series[0].type).toBe("area");
    expect(createGalleryState("highcharts", "scatter").adapterModel.chart.type).toBe("scatter");
    expect(createGalleryState("vegalite", "scatter").adapterModel.mark).toBe("point");
  });

  it("changes preview values during live updates without changing adapter shape", () => {
    const first = createGalleryState("chartjs", "line", 0);
    const next = createGalleryState("chartjs", "line", 4);

    expect(first.adapterModel.type).toBe(next.adapterModel.type);
    expect(first.adapterModel.data.datasets[0].data[0].y).not.toBe(
      next.adapterModel.data.datasets[0].data[0].y
    );
  });

  it("advances live data as a stable sliding append window", () => {
    const first = createEngineResult(0);
    const next = createEngineResult(1);

    for (let seriesIndex = 0; seriesIndex < first.series.length; seriesIndex++) {
      const firstSeries = first.series[seriesIndex];
      const nextSeries = next.series[seriesIndex];

      expect(nextSeries.timestamps.slice(0, -1)).toEqual(firstSeries.timestamps.slice(1));
      expect(Array.from(nextSeries.values.slice(0, -1))).toEqual(
        Array.from(firstSeries.values.slice(1))
      );
      expect(Math.max(...nextSeries.values)).toBeLessThanOrEqual(180);
    }
  });

  it("keeps the coverage model aligned with declared chart types", () => {
    const chartIds = new Set(CHART_TYPES.map((chart) => chart.id));
    for (const library of LIBRARIES) {
      expect(library.charts.length).toBeGreaterThan(0);
      for (const chart of library.charts) {
        expect(chartIds.has(chart)).toBe(true);
      }
    }
  });
});
