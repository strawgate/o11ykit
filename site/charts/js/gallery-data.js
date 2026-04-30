import {
  toAgChartsLatestValuesOptions,
  toAgChartsTimeSeriesOptions,
} from "../../../packages/adapters/src/agcharts.ts";
import {
  toApexChartsLatestValuesOptions,
  toApexChartsTimeSeriesOptions,
} from "../../../packages/adapters/src/apexcharts.ts";
import {
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsTimeSeriesConfig,
} from "../../../packages/adapters/src/chartjs.ts";
import {
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
} from "../../../packages/adapters/src/echarts.ts";
import { toEngineHistogramModel as toAdapterEngineHistogramModel } from "../../../packages/adapters/src/engine.ts";
import {
  toHighchartsHistogramOptions,
  toHighchartsLatestValuesOptions,
  toHighchartsTimeSeriesOptions,
} from "../../../packages/adapters/src/highcharts.ts";
import {
  toNivoBarData,
  toNivoLineSeries,
  toNivoPieData,
  toNivoScatterSeries,
} from "../../../packages/adapters/src/nivo.ts";
import {
  toObservablePlotHistogramOptions,
  toObservablePlotOptions,
} from "../../../packages/adapters/src/observable.ts";
import {
  toPlotlyHistogramFigure,
  toPlotlyLatestValuesFigure,
  toPlotlyTimeSeriesFigure,
} from "../../../packages/adapters/src/plotly.ts";
import {
  toRechartsHistogramData,
  toRechartsLatestValuesData,
  toRechartsScatterData,
  toRechartsTimeSeriesData,
} from "../../../packages/adapters/src/recharts.ts";
import {
  toTremorAreaChartProps,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
} from "../../../packages/adapters/src/tremor.ts";
import { toUPlotTimeSeriesArgs } from "../../../packages/adapters/src/uplot.ts";
import {
  toVegaLiteHistogramSpec,
  toVegaLiteSpec,
} from "../../../packages/adapters/src/vegalite.ts";
import { toVictoryLatestData, toVictorySeries } from "../../../packages/adapters/src/victory.ts";
import { ScanEngine } from "../../../packages/o11ytsdb/src/query.ts";
import { RowGroupStore } from "../../../packages/o11ytsdb/src/row-group-store.ts";

export const CHART_TYPES = [
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "bar", label: "Bar" },
  { id: "donut", label: "Donut" },
  { id: "latestBar", label: "Latest bars" },
  { id: "histogram", label: "Histogram" },
  { id: "barList", label: "Bar list" },
  { id: "scatter", label: "Scatter" },
  { id: "sparkline", label: "Sparkline" },
  { id: "gauge", label: "Gauge" },
];

export const LIBRARIES = [
  {
    id: "tremor",
    name: "Tremor",
    mark: "T",
    logoUrl: "https://www.tremor.so/favicon.ico",
    primaryApi: "props",
    updateModel: "React data updates",
    status: "implemented",
    package: "@otlpkit/adapters/tremor",
    charts: ["line", "area", "bar", "donut", "barList"],
    note: "Return the prop bag users spread onto Tremor components, with readable categories and source metadata.",
  },
  {
    id: "recharts",
    name: "Recharts",
    mark: "R",
    logoUrl: "https://github.com/recharts.png?size=64",
    primaryApi: "rows + dataKey",
    updateModel: "React data updates",
    status: "implemented",
    package: "@otlpkit/adapters/recharts",
    charts: ["line", "area", "bar", "donut", "latestBar", "histogram", "scatter"],
    note: "Keep Recharts ergonomic: rows for data, descriptors for Line/Area/Bar dataKey wiring.",
  },
  {
    id: "chartjs",
    name: "Chart.js",
    mark: "C",
    logoUrl: "https://cdn.simpleicons.org/chartdotjs/11110F",
    primaryApi: "configuration",
    updateModel: "controller.update('none')",
    status: "exported",
    package: "@otlpkit/adapters/chartjs",
    charts: [
      "line",
      "area",
      "bar",
      "donut",
      "latestBar",
      "histogram",
      "scatter",
      "sparkline",
      "gauge",
    ],
    note: "Produce chart configs with parsing disabled so large time-series stay cheap to update.",
  },
  {
    id: "echarts",
    name: "ECharts",
    mark: "E",
    logoUrl: "https://cdn.simpleicons.org/apacheecharts/11110F",
    primaryApi: "dataset + encode",
    updateModel: "setOption",
    status: "exported",
    package: "@otlpkit/adapters/echarts",
    charts: [
      "line",
      "area",
      "bar",
      "donut",
      "latestBar",
      "histogram",
      "scatter",
      "sparkline",
      "gauge",
    ],
    note: "Use dataset source and encode fields so ECharts keeps transforms and tooltips native.",
  },
  {
    id: "uplot",
    name: "uPlot",
    mark: "u",
    primaryApi: "aligned arrays",
    updateModel: "setData",
    status: "exported",
    package: "@otlpkit/adapters/uplot",
    charts: ["line", "area", "sparkline"],
    note: "Keep the hot path as aligned numeric arrays, matching uPlot's low-allocation model.",
  },
  {
    id: "nivo",
    name: "Nivo",
    mark: "N",
    primaryApi: "series objects",
    updateModel: "React data updates",
    status: "exported",
    package: "@otlpkit/adapters/nivo",
    charts: ["line", "area", "bar", "donut", "scatter"],
    note: "Map engine series into Nivo's nested data while keeping labels and colors predictable.",
  },
  {
    id: "observable",
    name: "Observable Plot",
    mark: "OP",
    logoUrl: "https://cdn.simpleicons.org/observable/11110F",
    primaryApi: "marks",
    updateModel: "plot rebuild",
    status: "exported",
    package: "@otlpkit/adapters/observable",
    charts: ["line", "area", "bar", "histogram", "scatter", "sparkline"],
    note: "Turn engine results into tidy records and return Plot marks users can drop into Plot.plot.",
  },
  {
    id: "plotly",
    name: "Plotly",
    mark: "P",
    logoUrl: "https://cdn.simpleicons.org/plotly/11110F",
    primaryApi: "traces",
    updateModel: "extendTraces",
    status: "exported",
    package: "@otlpkit/adapters/plotly",
    charts: ["line", "area", "bar", "donut", "histogram", "scatter", "sparkline", "gauge"],
    note: "Produce traces and layouts, with a path toward extendTraces for live dashboards.",
  },
  {
    id: "apexcharts",
    name: "ApexCharts",
    mark: "A",
    logoUrl: "https://apexcharts.com/favicon.ico",
    primaryApi: "options + series",
    updateModel: "updateSeries",
    status: "exported",
    package: "@otlpkit/adapters/apexcharts",
    charts: ["line", "area", "bar", "donut", "scatter", "sparkline", "gauge"],
    note: "Return compact options plus series arrays, including sparkline and radial gauge shapes.",
  },
  {
    id: "victory",
    name: "Victory",
    mark: "V",
    logoUrl: "https://formidable.com/open-source/victory/favicon.ico",
    primaryApi: "components + data",
    updateModel: "React data updates",
    status: "exported",
    package: "@otlpkit/adapters/victory",
    charts: ["line", "area", "bar", "donut", "scatter"],
    note: "Keep data arrays small and component-friendly for Victory's declarative chart primitives.",
  },
  {
    id: "agcharts",
    name: "AG Charts",
    mark: "AG",
    logoUrl: "https://github.com/ag-grid.png?size=64",
    primaryApi: "options",
    updateModel: "update options",
    status: "exported",
    package: "@otlpkit/adapters/agcharts",
    charts: ["line", "area", "bar", "donut", "scatter"],
    note: "Project engine rows into AG Charts options with explicit keys and series definitions.",
  },
  {
    id: "highcharts",
    name: "Highcharts",
    mark: "H",
    logoUrl: "https://github.com/highcharts.png?size=64",
    primaryApi: "options + series",
    updateModel: "setData",
    status: "exported",
    package: "@otlpkit/adapters/highcharts",
    charts: ["line", "area", "bar", "donut", "histogram", "scatter", "sparkline", "gauge"],
    note: "Return Highcharts-style options while preserving stable engine ids for updates.",
  },
  {
    id: "vegalite",
    name: "Vega-Lite",
    mark: "VL",
    logoUrl: "https://cdn.simpleicons.org/vega/11110F",
    primaryApi: "spec",
    updateModel: "view changeset",
    status: "exported",
    package: "@otlpkit/adapters/vegalite",
    charts: ["line", "area", "bar", "histogram", "scatter"],
    note: "Emit tidy records and declarative encodings that can become Vega-Lite specs.",
  },
];

const NS_PER_MS = 1_000_000n;
const COLORS = ["#2563eb", "#059669", "#dc2626", "#7c3aed", "#d97706", "#0891b2"];
const GALLERY_METRIC = "http.server.duration";
const GALLERY_STEP_MS = 30_000;
const GALLERY_POINTS = 18;
const GALLERY_START_MS = 1_714_200_000_000;
const GALLERY_SERIES = [
  { service: "checkout", route: "/cart", status: "2xx", base: 74, phase: 0.2 },
  { service: "checkout", route: "/pay", status: "5xx", base: 108, phase: 1.8 },
  { service: "api", route: "/search", status: "2xx", base: 62, phase: 2.4 },
  { service: "worker", route: "/jobs", status: "2xx", base: 88, phase: 3.1 },
];
const galleryEngine = new ScanEngine();
let galleryMetricState;

const galleryValuesCodec = {
  name: "f64-plain",
  encodeValues(values) {
    const out = new Uint8Array(4 + values.byteLength);
    new DataView(out.buffer).setUint32(0, values.length, true);
    out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
    return out;
  },
  decodeValues(buf) {
    if (buf.byteLength < 4) return new Float64Array(0);
    const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
    const raw = buf.subarray(4);
    const bytes = raw.byteLength - (raw.byteLength % 8);
    const copy = raw.slice(0, bytes);
    return new Float64Array(
      copy.buffer,
      copy.byteOffset,
      Math.min(n, Math.floor(bytes / 8))
    ).slice();
  },
  decodeValuesRange(buf, startIndex, endIndex) {
    if (buf.byteLength < 4 || endIndex <= startIndex) return new Float64Array(0);
    const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
    const raw = buf.subarray(4);
    const clampedStart = Math.max(0, Math.min(startIndex, n));
    const clampedEnd = Math.max(clampedStart, Math.min(endIndex, n));
    const byteStart = clampedStart * 8;
    const byteEnd = clampedEnd * 8;
    const bytes = Math.max(
      0,
      Math.min(raw.byteLength, byteEnd) - Math.min(raw.byteLength, byteStart)
    );
    if (bytes === 0) return new Float64Array(0);
    const copy = raw.slice(byteStart, byteStart + bytes);
    return new Float64Array(copy.buffer, copy.byteOffset, Math.floor(bytes / 8)).slice();
  },
};

export function getLibrary(id) {
  return LIBRARIES.find((library) => library.id === id) ?? LIBRARIES[0];
}

export function getSupportedChart(libraryId, chartType) {
  const library = getLibrary(libraryId);
  return library.charts.includes(chartType) ? chartType : library.charts[0];
}

export function createEngineResult(liveStep = 0) {
  const { store, query } = createGalleryMetricStore(liveStep);
  return galleryEngine.query(store, query);
}

export function createGalleryMetricStore(liveStep = 0) {
  const state = getGalleryMetricState();
  const startSample = Math.max(0, Math.floor(liveStep));
  const endSample = startSample + GALLERY_POINTS - 1;
  appendGallerySamplesThrough(state, endSample);

  const startNs = BigInt(GALLERY_START_MS + startSample * GALLERY_STEP_MS) * NS_PER_MS;
  const endNs = BigInt(GALLERY_START_MS + endSample * GALLERY_STEP_MS) * NS_PER_MS;
  return {
    store: state.store,
    startNs,
    endNs,
    query: {
      metric: GALLERY_METRIC,
      start: startNs,
      end: endNs,
      maxPoints: GALLERY_POINTS,
    },
  };
}

function getGalleryMetricState() {
  if (galleryMetricState) return galleryMetricState;

  const store = new RowGroupStore(galleryValuesCodec, 64, () => 0, 32, "chart-gallery-rowgroup");
  galleryMetricState = {
    store,
    appendedThroughSample: -1,
    seriesIds: GALLERY_SERIES.map((series) =>
      store.getOrCreateSeries(
        new Map([
          ["__name__", GALLERY_METRIC],
          ["service", series.service],
          ["route", series.route],
          ["status_class", series.status],
        ])
      )
    ),
  };
  return galleryMetricState;
}

function appendGallerySamplesThrough(state, endSample) {
  for (let sampleIndex = state.appendedThroughSample + 1; sampleIndex <= endSample; sampleIndex++) {
    const timestamp = BigInt(GALLERY_START_MS + sampleIndex * GALLERY_STEP_MS) * NS_PER_MS;
    state.store.append(
      new BigInt64Array([timestamp]),
      state.seriesIds.map((id, seriesIndex) => ({
        id,
        values: new Float64Array([
          sampleValue(GALLERY_SERIES[seriesIndex], seriesIndex, sampleIndex),
        ]),
      }))
    );
    state.appendedThroughSample = sampleIndex;
  }
}

function sampleValue(series, seriesIndex, sampleIndex) {
  const wave = Math.sin(sampleIndex * 0.68 + series.phase) * 13;
  const secondary = Math.cos((sampleIndex + seriesIndex) * 0.37) * 6;
  const incidentWave = Math.max(0, 44 - Math.abs((sampleIndex % 44) - 24) * 6);
  const incident = series.status === "5xx" ? incidentWave : 0;
  return Math.max(4, Math.round((series.base + wave + secondary + incident) * 10) / 10);
}

export function createGalleryState(libraryId = "tremor", chartType = "line", liveStep = 0) {
  const gallery = createLibraryGalleryState(libraryId, liveStep);
  const supportedChart = getSupportedChart(gallery.library.id, chartType);
  return gallery.charts.find((chart) => chart.chartType === supportedChart) ?? gallery.charts[0];
}

export function createLibraryGalleryState(libraryId = "tremor", liveStep = 0) {
  const library = getLibrary(libraryId);
  const result = createEngineResult(liveStep);
  const seriesLegend = result.series.map((series, index) => ({
    id: seriesLabel(series, index),
    label: seriesLabel(series, index),
  }));
  const histogram = toAdapterEngineHistogramModel(result, { seriesLabel });

  return {
    library,
    result,
    seriesLegend,
    histogram,
    charts: library.charts.map((chartType) => ({
      library,
      chartType,
      result,
      seriesLegend,
      histogram,
      adapterOutput: createAdapterOutput(library, chartType, result),
      snippets: snippetsFor(library, chartType),
    })),
  };
}

export function createAdapterOutput(library, chartType, result) {
  switch (library.id) {
    case "tremor":
      return tremorModel(chartType, result);
    case "recharts":
      return rechartsModel(chartType, result);
    case "chartjs":
      return chartType === "histogram"
        ? toChartJsHistogramConfig(result)
        : chartType === "donut" || chartType === "gauge" || chartType === "latestBar"
          ? toChartJsLatestValuesConfig(result, {
              chartType: chartType === "latestBar" ? "bar" : chartType,
              seriesLabel,
            })
          : toChartJsTimeSeriesConfig(result, { chartType, seriesLabel });
    case "echarts":
      return chartType === "histogram"
        ? toEChartsHistogramOption(result)
        : chartType === "donut" || chartType === "gauge" || chartType === "latestBar"
          ? toEChartsLatestValuesOption(result, {
              chartType: chartType === "latestBar" ? "bar" : chartType,
              seriesLabel,
            })
          : toEChartsTimeSeriesOption(result, { chartType, seriesLabel });
    case "uplot":
      return toUPlotTimeSeriesArgs(result, { chartType, seriesLabel });
    case "nivo":
      return nivoModel(chartType, result);
    case "observable":
      return chartType === "histogram"
        ? toObservablePlotHistogramOptions(result)
        : toObservablePlotOptions(result, { chartType, seriesLabel });
    case "plotly":
      return chartType === "histogram"
        ? toPlotlyHistogramFigure(result)
        : chartType === "donut" || chartType === "gauge"
          ? toPlotlyLatestValuesFigure(result, { chartType, seriesLabel })
          : toPlotlyTimeSeriesFigure(result, { chartType, seriesLabel });
    case "apexcharts":
      return chartType === "donut" || chartType === "gauge"
        ? toApexChartsLatestValuesOptions(result, { chartType, seriesLabel })
        : toApexChartsTimeSeriesOptions(result, { chartType, seriesLabel });
    case "victory":
      return victoryModel(chartType, result);
    case "agcharts":
      return chartType === "donut" || chartType === "gauge"
        ? toAgChartsLatestValuesOptions(result, { chartType, seriesLabel })
        : toAgChartsTimeSeriesOptions(result, { chartType, seriesLabel });
    case "highcharts":
      return chartType === "histogram"
        ? toHighchartsHistogramOptions(result)
        : chartType === "donut" || chartType === "gauge"
          ? toHighchartsLatestValuesOptions(result, { chartType, seriesLabel })
          : toHighchartsTimeSeriesOptions(result, { chartType, seriesLabel });
    case "vegalite":
      return chartType === "histogram"
        ? toVegaLiteHistogramSpec(result)
        : toVegaLiteSpec(result, { mark: chartType, seriesLabel });
    default:
      return { data: result.series };
  }
}

export function serializableAdapterOutput(model) {
  return JSON.parse(
    JSON.stringify(model, (_key, value) => {
      if (value instanceof Map) return Object.fromEntries(value.entries());
      if (typeof value === "bigint") return value.toString();
      if (ArrayBuffer.isView(value)) return Array.from(value);
      return value;
    })
  );
}

function tremorModel(chartType, result) {
  if (chartType === "donut") {
    return toTremorDonutChartProps(result, { seriesLabel });
  }
  if (chartType === "barList") {
    return toTremorBarListProps(result, { seriesLabel });
  }
  if (chartType === "area") return toTremorAreaChartProps(result, { seriesLabel, type: "default" });
  if (chartType === "bar")
    return toTremorBarChartProps(result, { layout: "vertical", seriesLabel });
  return toTremorLineChartProps(result, { seriesLabel });
}

function rechartsModel(chartType, result) {
  if (chartType === "donut" || chartType === "latestBar") {
    return toRechartsLatestValuesData(result, { seriesLabel, unit: "ms" });
  }
  if (chartType === "histogram") {
    return toRechartsHistogramData(result, { seriesLabel, unit: "samples" });
  }
  if (chartType === "scatter") {
    return toRechartsScatterData(result, { seriesLabel, unit: "ms" });
  }
  return toRechartsTimeSeriesData(result, { seriesLabel, unit: "ms" });
}

function nivoModel(chartType, result) {
  if (chartType === "donut") {
    return toNivoPieData(result, { seriesLabel }).map((row, index) => ({
      ...row,
      color: COLORS[index % COLORS.length],
    }));
  }
  if (chartType === "bar") {
    return toNivoBarData(result, { seriesLabel });
  }
  if (chartType === "scatter") {
    return toNivoScatterSeries(result, { seriesLabel });
  }
  return toNivoLineSeries(result, { seriesLabel });
}

function victoryModel(chartType, result) {
  if (chartType === "donut") {
    return toVictoryLatestData(result, { seriesLabel });
  }
  if (chartType === "bar") {
    return toVictoryLatestData(result, { seriesLabel });
  }
  return toVictorySeries(result, { chartType, seriesLabel });
}

function snippetsFor(library, chartType) {
  const componentName = componentFor(library.id, chartType);
  return {
    query: `import { RowGroupStore, ScanEngine } from "o11ytsdb";

const store = new RowGroupStore(valuesCodec, 640, () => 0, 32, "dashboard");
const id = store.getOrCreateSeries(new Map([
  ["__name__", "http.server.duration"],
  ["service", "checkout"],
  ["route", "/cart"],
  ["status_class", "2xx"],
]));

store.append(timestamps, [{ id, values }]);

const engine = new ScanEngine();
const result = engine.query(store, {
  metric: "http.server.duration",
  start,
  end,
  maxPoints: 300,
});`,
    adapter: adapterSnippet(library.id, chartType),
    library: librarySnippet(library.id, chartType, componentName),
  };
}

function adapterSnippet(libraryId, chartType) {
  if (libraryId === "tremor") {
    const fn =
      chartType === "donut"
        ? "toTremorDonutChartProps"
        : chartType === "barList"
          ? "toTremorBarListProps"
          : `toTremor${capitalize(chartType)}ChartProps`;
    return `import {
  ${fn},
} from "@otlpkit/adapters/tremor";

const props = ${fn}(result, {
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "recharts") {
    const fn =
      chartType === "donut" || chartType === "latestBar"
        ? "toRechartsLatestValuesData"
        : chartType === "histogram"
          ? "toRechartsHistogramData"
          : chartType === "scatter"
            ? "toRechartsScatterData"
            : "toRechartsTimeSeriesData";
    return `import { ${fn} } from "@otlpkit/adapters/recharts";

const data = ${fn}(result, {
  seriesLabel: (s) => s.labels.get("service") ?? "service",
  unit: "${chartType === "histogram" ? "samples" : "ms"}",
});`;
  }
  if (libraryId === "uplot") {
    return `import { toUPlotTimeSeriesArgs } from "@otlpkit/adapters/uplot";

const args = toUPlotTimeSeriesArgs(result, {
  chartType: "${chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "echarts") {
    const fn =
      chartType === "histogram"
        ? "toEChartsHistogramOption"
        : chartType === "donut" || chartType === "gauge" || chartType === "latestBar"
          ? "toEChartsLatestValuesOption"
          : "toEChartsTimeSeriesOption";
    return `import { ${fn} } from "@otlpkit/adapters/echarts";

const option = ${fn}(result, {
  chartType: "${chartType === "latestBar" ? "bar" : chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "chartjs") {
    const fn =
      chartType === "histogram"
        ? "toChartJsHistogramConfig"
        : chartType === "donut" || chartType === "gauge" || chartType === "latestBar"
          ? "toChartJsLatestValuesConfig"
          : "toChartJsTimeSeriesConfig";
    return `import { ${fn} } from "@otlpkit/adapters/chartjs";

const config = ${fn}(result, {
  chartType: "${chartType === "latestBar" ? "bar" : chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "plotly") {
    const fn =
      chartType === "histogram"
        ? "toPlotlyHistogramFigure"
        : chartType === "donut" || chartType === "gauge"
          ? "toPlotlyLatestValuesFigure"
          : "toPlotlyTimeSeriesFigure";
    return `import { ${fn} } from "@otlpkit/adapters/plotly";

const figure = ${fn}(result, {
  chartType: "${chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "apexcharts") {
    const fn =
      chartType === "donut" || chartType === "gauge"
        ? "toApexChartsLatestValuesOptions"
        : "toApexChartsTimeSeriesOptions";
    return `import { ${fn} } from "@otlpkit/adapters/apexcharts";

const options = ${fn}(result, {
  chartType: "${chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "victory") {
    const fn =
      chartType === "donut" || chartType === "bar" ? "toVictoryLatestData" : "toVictorySeries";
    return `import { ${fn} } from "@otlpkit/adapters/victory";

const data = ${fn}(result, {
  chartType: "${chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "agcharts") {
    const fn =
      chartType === "donut" || chartType === "gauge"
        ? "toAgChartsLatestValuesOptions"
        : "toAgChartsTimeSeriesOptions";
    return `import { ${fn} } from "@otlpkit/adapters/agcharts";

const options = ${fn}(result, {
  chartType: "${chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "highcharts") {
    const fn =
      chartType === "histogram"
        ? "toHighchartsHistogramOptions"
        : chartType === "donut" || chartType === "gauge"
          ? "toHighchartsLatestValuesOptions"
          : "toHighchartsTimeSeriesOptions";
    return `import { ${fn} } from "@otlpkit/adapters/highcharts";

const options = ${fn}(result, {
  chartType: "${chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "vegalite") {
    const fn = chartType === "histogram" ? "toVegaLiteHistogramSpec" : "toVegaLiteSpec";
    return `import { ${fn} } from "@otlpkit/adapters/vegalite";

const spec = ${fn}(result, {
  mark: "${chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "observable") {
    const fn =
      chartType === "histogram" ? "toObservablePlotHistogramOptions" : "toObservablePlotOptions";
    return `import { ${fn} } from "@otlpkit/adapters/observable";

const options = ${fn}(result, {
  chartType: "${chartType}",
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "nivo" && chartType === "donut") {
    return `import { toNivoPieData } from "@otlpkit/adapters/nivo";

const data = toNivoPieData(result, {
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "nivo" && chartType === "bar") {
    return `import { toNivoBarData } from "@otlpkit/adapters/nivo";

const data = toNivoBarData(result, {
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  if (libraryId === "nivo" && chartType === "scatter") {
    return `import { toNivoScatterSeries } from "@otlpkit/adapters/nivo";

const data = toNivoScatterSeries(result, {
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
  }
  return `import { toNivoLineSeries } from "@otlpkit/adapters/nivo";

const data = toNivoLineSeries(result, {
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});`;
}

function librarySnippet(libraryId, chartType, componentName) {
  if (libraryId === "tremor") return `<${componentName} {...props} />`;
  if (libraryId === "recharts") {
    if (chartType === "donut") {
      return `<PieChart>
  <Pie
    data={data.data}
    dataKey={data.valueKey}
    nameKey={data.categoryKey}
    innerRadius={48}
  />
</PieChart>`;
    }
    if (chartType === "histogram") {
      return `<BarChart data={data.data}>
  <XAxis dataKey={data.categoryKey} />
  <Bar dataKey={data.valueKey} />
</BarChart>`;
    }
    if (chartType === "scatter") {
      return `<ScatterChart>
  <XAxis dataKey={data.xAxisKey} type="number" />
  <YAxis dataKey={data.yAxisKey} />
  {data.series.map((s) => (
    <Scatter
      key={s.id}
      name={s.name}
      data={data.data.filter((row) => row[data.seriesKey] === s.name)}
    />
  ))}
</ScatterChart>`;
    }
    return `<${componentName} data={data.data}>
  <XAxis dataKey={data.xAxisKey} />
  {data.series.map((s) => <Line key={s.id} dataKey={s.dataKey} name={s.name} />)}
</${componentName}>`;
  }
  if (libraryId === "chartjs")
    return `const chart = new Chart(canvas, config);
chart.update("none");`;
  if (libraryId === "apexcharts")
    return `const chart = new ApexCharts(node, options);
chart.render();
chart.updateSeries(nextOptions.series);`;
  if (libraryId === "victory")
    return `<VictoryChart>{series.map(renderVictorySeries)}</VictoryChart>`;
  if (libraryId === "agcharts")
    return `const chart = AgCharts.create(options);
chart.update(nextOptions);`;
  if (libraryId === "highcharts")
    return `const chart = Highcharts.chart(node, options);
chart.series.forEach((series, i) => series.setData(nextOptions.series[i].data));`;
  if (libraryId === "vegalite")
    return `const view = await vegaEmbed(node, spec);
view.view.change("telemetry", changeset).run();`;
  if (libraryId === "echarts")
    return `const chart = echarts.init(node);
chart.setOption(option);`;
  if (libraryId === "uplot")
    return `const plot = new uPlot(args.options, args.data, node);
plot.setData(nextArgs.data);`;
  if (libraryId === "nivo") return `<${componentName} data={data} animate={false} />`;
  if (libraryId === "observable")
    return `Plot.plot({
  marks: options.marks.map((mark) => Plot[mark.mark](options.data, mark)),
});`;
  return `Plotly.react(node, figure.data, figure.layout);
Plotly.extendTraces(node, nextPatch, [0, 1, 2]);`;
}

function componentFor(libraryId, chartType) {
  const names = {
    tremor: {
      line: "LineChart",
      area: "AreaChart",
      bar: "BarChart",
      donut: "DonutChart",
      barList: "BarList",
    },
    recharts: {
      line: "LineChart",
      area: "AreaChart",
      bar: "BarChart",
      histogram: "BarChart",
      scatter: "ScatterChart",
    },
    nivo: {
      line: "ResponsiveLine",
      area: "ResponsiveLine",
      bar: "ResponsiveBar",
      donut: "ResponsivePie",
    },
  };
  return names[libraryId]?.[chartType] ?? "Chart";
}

function seriesLabel(series, index) {
  const service = series.labels.get("service") ?? `series-${index}`;
  const route = series.labels.get("route");
  const status = series.labels.get("status_class");
  return [service, route, status].filter(Boolean).join(" ");
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
