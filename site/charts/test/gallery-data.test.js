import { describe, expect, it } from "vitest";

import {
  CHART_TYPES,
  createEngineResult,
  createGalleryMetricStore,
  createGalleryState,
  createLibraryGalleryState,
  getSupportedChart,
  LIBRARIES,
  serializableAdapterOutput,
} from "../js/gallery-data.js";

describe("chart gallery data", () => {
  it("builds one deterministic TSDB engine result for every native chart preview", () => {
    const result = createEngineResult();
    const { store, query } = createGalleryMetricStore();
    const gallery = createLibraryGalleryState("tremor");

    expect(store.seriesCount).toBe(4);
    expect(store.sampleCount).toBeGreaterThanOrEqual(72);
    expect(store.name).toBe("chart-gallery-rowgroup");
    expect(query).toMatchObject({
      metric: "http.server.duration",
      maxPoints: 18,
    });
    expect(result.scannedSeries).toBe(4);
    expect(result.scannedSamples).toBe(72);
    expect(result.series).toHaveLength(4);
    expect(LIBRARIES).toHaveLength(13);
    expect(CHART_TYPES).toHaveLength(10);
    expect(gallery.seriesLegend.map((series) => series.label)).toEqual([
      "checkout /cart 2xx",
      "checkout /pay 5xx",
      "api /search 2xx",
      "worker /jobs 2xx",
    ]);
    expect(gallery.histogram.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(72);
  });

  it("creates library-native preview data through exported adapter calls", () => {
    for (const library of LIBRARIES) {
      for (const chart of library.charts) {
        const gallery = createGalleryState(library.id, chart);
        const output = serializableAdapterOutput(gallery.adapterOutput);

        expect(gallery.library.id).toBe(library.id);
        expect(gallery.chartType).toBe(chart);
        expect(output).toBeTruthy();
        expect(gallery.snippets.query).toContain("engine.query");
        expect(gallery.snippets.query).toContain("new ScanEngine");
        expect(gallery.snippets.query).toContain("new RowGroupStore");
        expect(gallery.snippets.query).toContain("store.append");
        expect(gallery.snippets.adapter).toContain(library.package);
        expect(gallery.snippets.adapter).not.toContain("toEngineWideTableModel");
        expect(gallery.snippets.adapter).not.toContain("toEngineLatestValueModel");
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
        expect(chart.seriesLegend).toBe(gallery.seriesLegend);
        expect(chart.histogram).toBe(gallery.histogram);
        expect(serializableAdapterOutput(chart.adapterOutput)).toBeTruthy();
      }
    }
  });

  it("only declares gallery libraries with exported adapter snippets", () => {
    for (const library of LIBRARIES) {
      const gallery = createGalleryState(library.id, library.charts[0]);

      expect(library.package).toBeTruthy();
      expect(library.package).toContain("@otlpkit/adapters/");
      expect(library.mark).toBeTruthy();
      expect(gallery.snippets.adapter).toContain(library.package);
      expect(gallery.snippets.adapter).not.toContain("not exported yet");
    }
  });

  it("falls back to the first natural chart type when a library does not support a shape", () => {
    expect(getSupportedChart("uplot", "donut")).toBe("line");
    expect(getSupportedChart("tremor", "donut")).toBe("donut");
  });

  it("emits recognizable native shapes for key libraries", () => {
    expect(createGalleryState("tremor", "line").adapterOutput).toMatchObject({
      index: "time",
      categories: expect.arrayContaining(["checkout /cart 2xx"]),
    });
    expect(createGalleryState("recharts", "line").adapterOutput).toMatchObject({
      xAxisKey: "time",
      series: expect.arrayContaining([
        expect.objectContaining({
          id: "__name__=http.server.duration,route=/cart,service=checkout,status_class=2xx",
        }),
      ]),
    });
    expect(createGalleryState("recharts", "donut").adapterOutput).toMatchObject({
      categoryKey: "label",
      valueKey: "value",
    });
    expect(createGalleryState("recharts", "latestBar").adapterOutput).toMatchObject({
      categoryKey: "label",
      valueKey: "value",
    });
    expect(createGalleryState("chartjs", "latestBar").adapterOutput.type).toBe("bar");
    expect(createGalleryState("echarts", "line").adapterOutput.dataset[0].dimensions).toEqual([
      "time",
      "checkout /cart 2xx",
      "checkout /pay 5xx",
      "api /search 2xx",
      "worker /jobs 2xx",
    ]);
    expect(createGalleryState("echarts", "latestBar").adapterOutput.series[0].type).toBe("bar");
    expect(createGalleryState("uplot", "line").adapterOutput.data).toHaveLength(5);
    expect(createGalleryState("plotly", "donut").adapterOutput.data[0].type).toBe("pie");
    expect(createGalleryState("apexcharts", "gauge").adapterOutput.chart.type).toBe("radialBar");
    expect(createGalleryState("nivo", "bar").adapterOutput).toMatchObject({
      indexBy: "time",
      keys: expect.arrayContaining([
        "__name__=http.server.duration,route=/cart,service=checkout,status_class=2xx",
      ]),
    });
    expect(createGalleryState("observable", "sparkline").adapterOutput.marks[0].mark).toBe("lineY");
    expect(createGalleryState("victory", "bar").adapterOutput[0]).toMatchObject({
      x: "checkout /cart 2xx",
      y: expect.any(Number),
    });
    expect(createGalleryState("agcharts", "area").adapterOutput.series[0].type).toBe("area");
    expect(createGalleryState("highcharts", "scatter").adapterOutput.chart.type).toBe("scatter");
    expect(createGalleryState("highcharts", "histogram").adapterOutput.chart.type).toBe("column");
    expect(createGalleryState("vegalite", "scatter").adapterOutput.mark).toBe("point");
  });

  it("changes preview values during live updates without changing adapter output shape", () => {
    const first = createGalleryState("chartjs", "line", 0);
    const next = createGalleryState("chartjs", "line", 4);

    expect(first.adapterOutput.type).toBe(next.adapterOutput.type);
    expect(first.adapterOutput.data.datasets[0].data[0].y).not.toBe(
      next.adapterOutput.data.datasets[0].data[0].y
    );
  });

  it("advances live data as a stable sliding append window", () => {
    const initialStore = createGalleryMetricStore(0).store;
    const first = createEngineResult(0);
    const next = createEngineResult(1);
    const nextStore = createGalleryMetricStore(1).store;

    expect(nextStore).toBe(initialStore);
    expect(nextStore.sampleCount).toBeGreaterThanOrEqual(76);

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
