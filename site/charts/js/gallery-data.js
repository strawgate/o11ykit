import {
  toAgChartsEngineLatestValuesOptions,
  toAgChartsEngineTimeSeriesOptions,
} from "../../../packages/adapters/src/agcharts.ts";
import {
  toApexChartsEngineLatestValuesOptions,
  toApexChartsEngineTimeSeriesOptions,
} from "../../../packages/adapters/src/apexcharts.ts";
import {
  toChartJsEngineHistogramConfig,
  toChartJsEngineLatestValuesConfig,
  toChartJsEngineTimeSeriesConfig,
} from "../../../packages/adapters/src/chartjs.ts";
import {
  toEChartsEngineHistogramOption,
  toEChartsEngineLatestValuesOption,
  toEChartsEngineTimeSeriesOption,
} from "../../../packages/adapters/src/echarts.ts";
import { toEngineHistogramModel as toAdapterEngineHistogramModel } from "../../../packages/adapters/src/engine.ts";
import {
  toHighchartsEngineHistogramOptions,
  toHighchartsEngineLatestValuesOptions,
  toHighchartsEngineTimeSeriesOptions,
} from "../../../packages/adapters/src/highcharts.ts";
import {
  toNivoEngineBarModel,
  toNivoEngineLineSeries,
  toNivoEnginePieData,
  toNivoEngineScatterSeries,
} from "../../../packages/adapters/src/nivo.ts";
import {
  toObservablePlotEngineHistogramModel,
  toObservablePlotEngineModel,
} from "../../../packages/adapters/src/observable.ts";
import {
  toPlotlyEngineHistogramModel,
  toPlotlyEngineLatestValuesModel,
  toPlotlyEngineTimeSeriesModel,
} from "../../../packages/adapters/src/plotly.ts";
import { toUPlotEngineTimeSeriesModel } from "../../../packages/adapters/src/uplot.ts";
import {
  toVegaLiteEngineHistogramSpec,
  toVegaLiteEngineSpec,
} from "../../../packages/adapters/src/vegalite.ts";
import {
  toVictoryEngineLatestData,
  toVictoryEngineSeries,
} from "../../../packages/adapters/src/victory.ts";
import {
  toVisxEngineHistogramModel,
  toVisxEngineLatestValuesModel,
  toVisxEngineXYChartModel,
} from "../../../packages/adapters/src/visx.ts";

export const CHART_TYPES = [
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "bar", label: "Bar" },
  { id: "donut", label: "Donut" },
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
    primaryApi: "rows + dataKey",
    updateModel: "React data updates",
    status: "implemented",
    package: "@otlpkit/adapters/recharts",
    charts: ["line", "area", "bar", "histogram", "scatter"],
    note: "Keep Recharts ergonomic: rows for data, descriptors for Line/Area/Bar dataKey wiring.",
  },
  {
    id: "chartjs",
    name: "Chart.js",
    primaryApi: "configuration",
    updateModel: "controller.update('none')",
    status: "exported",
    package: "@otlpkit/adapters/chartjs",
    charts: ["line", "area", "bar", "donut", "histogram", "scatter", "sparkline", "gauge"],
    note: "Produce chart configs with parsing disabled so large time-series stay cheap to update.",
  },
  {
    id: "echarts",
    name: "ECharts",
    primaryApi: "dataset + encode",
    updateModel: "setOption",
    status: "exported",
    package: "@otlpkit/adapters/echarts",
    charts: ["line", "area", "bar", "donut", "histogram", "scatter", "sparkline", "gauge"],
    note: "Use dataset source and encode fields so ECharts keeps transforms and tooltips native.",
  },
  {
    id: "uplot",
    name: "uPlot",
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
    primaryApi: "series objects",
    updateModel: "React data updates",
    status: "exported",
    package: "@otlpkit/adapters/nivo",
    charts: ["line", "area", "bar", "donut", "scatter"],
    note: "Map engine series into Nivo's nested data while keeping labels and colors predictable.",
  },
  {
    id: "visx",
    name: "Visx",
    primaryApi: "accessors + arrays",
    updateModel: "caller state updates",
    status: "exported",
    package: "@otlpkit/adapters/visx",
    charts: ["line", "area", "bar", "histogram", "scatter", "sparkline"],
    note: "Expose arrays and accessors, because Visx users compose marks rather than consume configs.",
  },
  {
    id: "observable",
    name: "Observable Plot",
    primaryApi: "marks",
    updateModel: "plot rebuild",
    status: "exported",
    package: "@otlpkit/adapters/observable",
    charts: ["line", "area", "bar", "histogram", "scatter", "sparkline"],
    note: "Flatten wide rows into tidy records and return Plot marks users can drop into Plot.plot.",
  },
  {
    id: "plotly",
    name: "Plotly",
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
    primaryApi: "options",
    updateModel: "update options",
    status: "exported",
    package: "@otlpkit/adapters/agcharts",
    charts: ["line", "area", "bar", "donut", "scatter", "gauge"],
    note: "Project engine rows into AG Charts options with explicit keys and series definitions.",
  },
  {
    id: "highcharts",
    name: "Highcharts",
    primaryApi: "options + series",
    updateModel: "setData",
    status: "exported",
    package: "@otlpkit/adapters/highcharts",
    charts: ["line", "area", "bar", "donut", "scatter", "sparkline", "gauge"],
    note: "Return Highcharts-style options while preserving stable engine ids for updates.",
  },
  {
    id: "vegalite",
    name: "Vega-Lite",
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

export function getLibrary(id) {
  return LIBRARIES.find((library) => library.id === id) ?? LIBRARIES[0];
}

export function getSupportedChart(libraryId, chartType) {
  const library = getLibrary(libraryId);
  return library.charts.includes(chartType) ? chartType : library.charts[0];
}

export function createEngineResult(liveStep = 0) {
  const services = [
    { service: "checkout", route: "/cart", status: "2xx", base: 74, phase: 0.2 },
    { service: "checkout", route: "/pay", status: "5xx", base: 108, phase: 1.8 },
    { service: "api", route: "/search", status: "2xx", base: 62, phase: 2.4 },
    { service: "worker", route: "/jobs", status: "2xx", base: 88, phase: 3.1 },
  ];
  const startMs = 1_714_200_000_000 + liveStep * 30_000;
  const points = 18;

  return {
    series: services.map((series, seriesIndex) => {
      const timestamps = new BigInt64Array(points);
      const values = new Float64Array(points);
      for (let i = 0; i < points; i++) {
        const sampleIndex = liveStep + i;
        timestamps[i] = BigInt(startMs + i * 30_000) * NS_PER_MS;
        const wave = Math.sin(sampleIndex * 0.68 + series.phase) * 13;
        const secondary = Math.cos((sampleIndex + seriesIndex) * 0.37) * 6;
        const incidentWave = Math.max(0, 44 - Math.abs((sampleIndex % 44) - 24) * 6);
        const incident = series.status === "5xx" ? incidentWave : 0;
        values[i] = Math.max(4, Math.round((series.base + wave + secondary + incident) * 10) / 10);
      }
      return {
        labels: new Map([
          ["__name__", "http.server.duration"],
          ["service", series.service],
          ["route", series.route],
          ["status_class", series.status],
        ]),
        timestamps,
        values,
      };
    }),
  };
}

export function toEngineWideTableModel(result) {
  const rowsByTime = new Map();
  const series = result.series.map((seriesResult, index) => ({
    id: seriesId(seriesResult, index),
    label: seriesLabel(seriesResult, index),
    labels: seriesResult.labels,
  }));

  result.series.forEach((seriesResult, seriesIndex) => {
    for (let i = 0; i < seriesResult.timestamps.length; i++) {
      const t = Number(seriesResult.timestamps[i] / NS_PER_MS);
      const row = rowsByTime.get(t) ?? new Array(result.series.length).fill(null);
      row[seriesIndex] = Number.isFinite(seriesResult.values[i]) ? seriesResult.values[i] : null;
      rowsByTime.set(t, row);
    }
  });

  return {
    kind: "engine-wide-table",
    columns: ["t", ...series.map((entry) => entry.label)],
    series,
    rows: [...rowsByTime.entries()]
      .sort(([left], [right]) => left - right)
      .map(([t, values]) => ({
        t,
        values,
      })),
  };
}

export function toEngineLatestValueModel(result) {
  return {
    kind: "engine-latest-values",
    rows: result.series.map((seriesResult, index) => {
      const last = seriesResult.values.length - 1;
      return {
        id: seriesId(seriesResult, index),
        label: seriesLabel(seriesResult, index),
        labels: seriesResult.labels,
        t: last >= 0 ? Number(seriesResult.timestamps[last] / NS_PER_MS) : null,
        value:
          last >= 0 && Number.isFinite(seriesResult.values[last])
            ? seriesResult.values[last]
            : null,
      };
    }),
  };
}

export function createGalleryState(libraryId = "tremor", chartType = "line", liveStep = 0) {
  const gallery = createLibraryGalleryState(libraryId, liveStep);
  const supportedChart = getSupportedChart(gallery.library.id, chartType);
  return gallery.charts.find((chart) => chart.chartType === supportedChart) ?? gallery.charts[0];
}

export function createLibraryGalleryState(libraryId = "tremor", liveStep = 0) {
  const library = getLibrary(libraryId);
  const result = createEngineResult(liveStep);
  const wide = toEngineWideTableModel(result);
  const latest = toEngineLatestValueModel(result);
  const histogram = toAdapterEngineHistogramModel(wide);

  return {
    library,
    result,
    wide,
    latest,
    histogram,
    charts: library.charts.map((chartType) => ({
      library,
      chartType,
      result,
      wide,
      latest,
      histogram,
      adapterModel: toAdapterModel(library, chartType, wide, latest, histogram),
      snippets: snippetsFor(library, chartType),
    })),
  };
}

export function toAdapterModel(library, chartType, wide, latest, histogram) {
  switch (library.id) {
    case "tremor":
      return tremorModel(chartType, wide, latest);
    case "recharts":
      return rechartsModel(chartType, wide, latest, histogram);
    case "chartjs":
      return chartType === "histogram"
        ? toChartJsEngineHistogramConfig(histogram)
        : chartType === "donut" || chartType === "gauge"
          ? toChartJsEngineLatestValuesConfig(latest, { chartType })
          : toChartJsEngineTimeSeriesConfig(wide, { chartType });
    case "echarts":
      return chartType === "histogram"
        ? toEChartsEngineHistogramOption(histogram)
        : chartType === "donut" || chartType === "gauge"
          ? toEChartsEngineLatestValuesOption(latest, { chartType })
          : toEChartsEngineTimeSeriesOption(wide, { chartType });
    case "uplot":
      return toUPlotEngineTimeSeriesModel(wide, { chartType });
    case "nivo":
      return nivoModel(chartType, wide, latest);
    case "visx":
      return visxModel(chartType, wide, latest, histogram);
    case "observable":
      return chartType === "histogram"
        ? toObservablePlotEngineHistogramModel(histogram)
        : toObservablePlotEngineModel(wide, { chartType });
    case "plotly":
      return chartType === "histogram"
        ? toPlotlyEngineHistogramModel(histogram)
        : chartType === "donut" || chartType === "gauge"
          ? toPlotlyEngineLatestValuesModel(latest, { chartType })
          : toPlotlyEngineTimeSeriesModel(wide, { chartType });
    case "apexcharts":
      return chartType === "donut" || chartType === "gauge"
        ? toApexChartsEngineLatestValuesOptions(latest, { chartType })
        : toApexChartsEngineTimeSeriesOptions(wide, { chartType });
    case "victory":
      return victoryModel(chartType, wide, latest);
    case "agcharts":
      return chartType === "donut" || chartType === "gauge"
        ? toAgChartsEngineLatestValuesOptions(latest, { chartType })
        : toAgChartsEngineTimeSeriesOptions(wide, { chartType });
    case "highcharts":
      return chartType === "histogram"
        ? toHighchartsEngineHistogramOptions(histogram)
        : chartType === "donut" || chartType === "gauge"
          ? toHighchartsEngineLatestValuesOptions(latest, { chartType })
          : toHighchartsEngineTimeSeriesOptions(wide, { chartType });
    case "vegalite":
      return chartType === "histogram"
        ? toVegaLiteEngineHistogramSpec(histogram)
        : toVegaLiteEngineSpec(wide, { mark: chartType });
    default:
      return { data: wide.rows };
  }
}

export function toHistogramModel(wide) {
  return toAdapterEngineHistogramModel(wide);
}

export function serializableAdapterModel(model) {
  return JSON.parse(
    JSON.stringify(model, (_key, value) => {
      if (value instanceof Map) return Object.fromEntries(value.entries());
      if (typeof value === "bigint") return value.toString();
      if (ArrayBuffer.isView(value)) return Array.from(value);
      return value;
    })
  );
}

function tremorModel(chartType, wide, latest) {
  if (chartType === "donut") {
    return {
      data: latest.rows.map((row) => ({ label: row.label, value: row.value })),
      index: "label",
      category: "value",
    };
  }
  if (chartType === "barList") {
    return {
      data: latest.rows.map((row) => ({ name: row.label, value: row.value })),
    };
  }
  const categories = wide.series.map((series) => series.label);
  return {
    data: wide.rows.map((row) => {
      const output = { time: formatTime(row.t) };
      row.values.forEach((value, index) => {
        output[categories[index]] = value;
      });
      return output;
    }),
    index: "time",
    categories,
    ...(chartType === "area" ? { type: "default" } : {}),
    ...(chartType === "bar" ? { layout: "vertical" } : {}),
  };
}

function rechartsModel(chartType, wide, latest, histogram) {
  if (chartType === "histogram") {
    return {
      data: histogram.buckets,
      categoryKey: "label",
      valueKey: "count",
    };
  }
  if (chartType === "scatter") {
    return {
      data: scatterRows(wide),
      xAxisKey: "time",
      yAxisKey: "value",
      seriesKey: "series",
    };
  }
  return {
    data: wide.rows.map((row) => rowToRecord(row, wide.series, "time")),
    xAxisKey: "time",
    tooltipKey: "time",
    series: wide.series.map((series) => ({
      id: series.id,
      dataKey: series.id,
      name: series.label,
    })),
    ...(chartType === "bar"
      ? { latest: latest.rows.map((row) => ({ label: row.label, value: row.value })) }
      : {}),
  };
}

function nivoModel(chartType, wide, latest) {
  if (chartType === "donut") {
    return toNivoEnginePieData(latest).map((row, index) => ({
      ...row,
      color: COLORS[index % COLORS.length],
    }));
  }
  if (chartType === "bar") {
    return toNivoEngineBarModel(wide);
  }
  if (chartType === "scatter") {
    return toNivoEngineScatterSeries(wide);
  }
  return toNivoEngineLineSeries(wide);
}

function visxModel(chartType, wide, latest, histogram) {
  if (chartType === "histogram") return toVisxEngineHistogramModel(histogram);
  if (chartType === "bar") return toVisxEngineLatestValuesModel(latest);
  if (chartType === "scatter") return toVisxEngineXYChartModel(wide, { chartType: "scatter" });
  return toVisxEngineXYChartModel(wide, { chartType });
}

function victoryModel(chartType, wide, latest) {
  if (chartType === "donut") {
    return toVictoryEngineLatestData(latest);
  }
  if (chartType === "bar") {
    return toVictoryEngineLatestData(latest);
  }
  return toVictoryEngineSeries(wide, { chartType });
}

function snippetsFor(library, chartType) {
  const componentName = componentFor(library.id, chartType);
  return {
    query: `const result = engine.query(store, {
  metric: "http.server.duration",
  start,
  end,
  groupBy: ["service", "route", "status_class"],
});`,
    adapter: adapterSnippet(library.id, chartType),
    library: librarySnippet(library.id, chartType, componentName),
  };
}

function adapterSnippet(libraryId, chartType) {
  // Exported libraries show copy-ready imports; Visx is exported but still adapter-shape-only here.
  if (libraryId === "tremor") {
    const fn =
      chartType === "donut"
        ? "toTremorDonutChartProps"
        : chartType === "barList"
          ? "toTremorBarListProps"
          : `toTremor${capitalize(chartType)}ChartProps`;
    return `import {
  toEngineLatestValueModel,
  toEngineWideTableModel,
} from "@otlpkit/adapters/engine";
import {
  ${fn},
} from "@otlpkit/adapters/tremor";

const wide = toEngineWideTableModel(result, {
  seriesLabel: (s) => s.labels.get("service") ?? "service",
});
const latest = toEngineLatestValueModel(result);
const props = ${fn}(${chartType === "donut" || chartType === "barList" ? "latest" : "wide"});`;
  }
  if (libraryId === "recharts") {
    return `import {
  toEngineWideTableModel,
} from "@otlpkit/adapters/engine";
import {
  toRechartsEngineTimeSeriesModel,
} from "@otlpkit/adapters/recharts";

const wide = toEngineWideTableModel(result);
const model = toRechartsEngineTimeSeriesModel(wide, {
  unit: "ms",
});`;
  }
  if (libraryId === "uplot") {
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toUPlotEngineTimeSeriesModel } from "@otlpkit/adapters/uplot";

const wide = toEngineWideTableModel(result);
const model = toUPlotEngineTimeSeriesModel(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "echarts") {
    if (chartType === "histogram") {
      return `import {
  toEngineHistogramModel,
  toEngineWideTableModel,
} from "@otlpkit/adapters/engine";
import { toEChartsEngineHistogramOption } from "@otlpkit/adapters/echarts";

const wide = toEngineWideTableModel(result);
const histogram = toEngineHistogramModel(wide);
const option = toEChartsEngineHistogramOption(histogram);`;
    }
    if (chartType === "donut" || chartType === "gauge") {
      return `import { toEngineLatestValueModel } from "@otlpkit/adapters/engine";
import { toEChartsEngineLatestValuesOption } from "@otlpkit/adapters/echarts";

const latest = toEngineLatestValueModel(result);
const option = toEChartsEngineLatestValuesOption(latest, {
  chartType: "${chartType}",
});`;
    }
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toEChartsEngineTimeSeriesOption } from "@otlpkit/adapters/echarts";

const wide = toEngineWideTableModel(result);
const option = toEChartsEngineTimeSeriesOption(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "chartjs") {
    if (chartType === "histogram") {
      return `import {
  toEngineHistogramModel,
  toEngineWideTableModel,
} from "@otlpkit/adapters/engine";
import { toChartJsEngineHistogramConfig } from "@otlpkit/adapters/chartjs";

const wide = toEngineWideTableModel(result);
const histogram = toEngineHistogramModel(wide);
const config = toChartJsEngineHistogramConfig(histogram);`;
    }
    if (chartType === "donut" || chartType === "gauge") {
      return `import { toEngineLatestValueModel } from "@otlpkit/adapters/engine";
import { toChartJsEngineLatestValuesConfig } from "@otlpkit/adapters/chartjs";

const latest = toEngineLatestValueModel(result);
const config = toChartJsEngineLatestValuesConfig(latest, {
  chartType: "${chartType}",
});`;
    }
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toChartJsEngineTimeSeriesConfig } from "@otlpkit/adapters/chartjs";

const wide = toEngineWideTableModel(result);
const config = toChartJsEngineTimeSeriesConfig(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "plotly") {
    if (chartType === "histogram") {
      return `import {
  toEngineHistogramModel,
  toEngineWideTableModel,
} from "@otlpkit/adapters/engine";
import { toPlotlyEngineHistogramModel } from "@otlpkit/adapters/plotly";

const wide = toEngineWideTableModel(result);
const histogram = toEngineHistogramModel(wide);
const traces = toPlotlyEngineHistogramModel(histogram);`;
    }
    if (chartType === "donut" || chartType === "gauge") {
      return `import { toEngineLatestValueModel } from "@otlpkit/adapters/engine";
import { toPlotlyEngineLatestValuesModel } from "@otlpkit/adapters/plotly";

const latest = toEngineLatestValueModel(result);
const traces = toPlotlyEngineLatestValuesModel(latest, {
  chartType: "${chartType}",
});`;
    }
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toPlotlyEngineTimeSeriesModel } from "@otlpkit/adapters/plotly";

const wide = toEngineWideTableModel(result);
const traces = toPlotlyEngineTimeSeriesModel(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "apexcharts") {
    if (chartType === "donut" || chartType === "gauge") {
      return `import { toEngineLatestValueModel } from "@otlpkit/adapters/engine";
import { toApexChartsEngineLatestValuesOptions } from "@otlpkit/adapters/apexcharts";

const latest = toEngineLatestValueModel(result);
const options = toApexChartsEngineLatestValuesOptions(latest, {
  chartType: "${chartType}",
});`;
    }
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toApexChartsEngineTimeSeriesOptions } from "@otlpkit/adapters/apexcharts";

const wide = toEngineWideTableModel(result);
const options = toApexChartsEngineTimeSeriesOptions(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "victory") {
    if (chartType === "donut" || chartType === "bar") {
      return `import { toEngineLatestValueModel } from "@otlpkit/adapters/engine";
import { toVictoryEngineLatestData } from "@otlpkit/adapters/victory";

const latest = toEngineLatestValueModel(result);
const data = toVictoryEngineLatestData(latest);`;
    }
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toVictoryEngineSeries } from "@otlpkit/adapters/victory";

const wide = toEngineWideTableModel(result);
const series = toVictoryEngineSeries(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "agcharts") {
    if (chartType === "donut" || chartType === "gauge") {
      return `import { toEngineLatestValueModel } from "@otlpkit/adapters/engine";
import { toAgChartsEngineLatestValuesOptions } from "@otlpkit/adapters/agcharts";

const latest = toEngineLatestValueModel(result);
const options = toAgChartsEngineLatestValuesOptions(latest, {
  chartType: "${chartType}",
});`;
    }
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toAgChartsEngineTimeSeriesOptions } from "@otlpkit/adapters/agcharts";

const wide = toEngineWideTableModel(result);
const options = toAgChartsEngineTimeSeriesOptions(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "highcharts") {
    if (chartType === "histogram") {
      return `import {
  toEngineHistogramModel,
  toEngineWideTableModel,
} from "@otlpkit/adapters/engine";
import { toHighchartsEngineHistogramOptions } from "@otlpkit/adapters/highcharts";

const wide = toEngineWideTableModel(result);
const histogram = toEngineHistogramModel(wide);
const options = toHighchartsEngineHistogramOptions(histogram);`;
    }
    if (chartType === "donut" || chartType === "gauge") {
      return `import { toEngineLatestValueModel } from "@otlpkit/adapters/engine";
import { toHighchartsEngineLatestValuesOptions } from "@otlpkit/adapters/highcharts";

const latest = toEngineLatestValueModel(result);
const options = toHighchartsEngineLatestValuesOptions(latest, {
  chartType: "${chartType}",
});`;
    }
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toHighchartsEngineTimeSeriesOptions } from "@otlpkit/adapters/highcharts";

const wide = toEngineWideTableModel(result);
const options = toHighchartsEngineTimeSeriesOptions(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "vegalite") {
    if (chartType === "histogram") {
      return `import {
  toEngineHistogramModel,
  toEngineWideTableModel,
} from "@otlpkit/adapters/engine";
import { toVegaLiteEngineHistogramSpec } from "@otlpkit/adapters/vegalite";

const wide = toEngineWideTableModel(result);
const histogram = toEngineHistogramModel(wide);
const spec = toVegaLiteEngineHistogramSpec(histogram);`;
    }
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toVegaLiteEngineSpec } from "@otlpkit/adapters/vegalite";

const wide = toEngineWideTableModel(result);
const spec = toVegaLiteEngineSpec(wide, {
  mark: "${chartType}",
});`;
  }
  if (libraryId === "observable") {
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toObservablePlotEngineModel } from "@otlpkit/adapters/observable";

const wide = toEngineWideTableModel(result);
const plot = toObservablePlotEngineModel(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "visx") {
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toVisxEngineXYChartModel } from "@otlpkit/adapters/visx";

const wide = toEngineWideTableModel(result);
const model = toVisxEngineXYChartModel(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "nivo" && chartType === "donut") {
    return `import { toEngineLatestValueModel } from "@otlpkit/adapters/engine";
import { toNivoEnginePieData } from "@otlpkit/adapters/nivo";

const latest = toEngineLatestValueModel(result);
const data = toNivoEnginePieData(latest);`;
  }
  if (libraryId === "nivo" && chartType === "bar") {
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toNivoEngineBarModel } from "@otlpkit/adapters/nivo";

const wide = toEngineWideTableModel(result);
const data = toNivoEngineBarModel(wide);`;
  }
  if (libraryId === "nivo" && chartType === "scatter") {
    return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toNivoEngineScatterSeries } from "@otlpkit/adapters/nivo";

const wide = toEngineWideTableModel(result);
const data = toNivoEngineScatterSeries(wide);`;
  }
  return `import { toEngineWideTableModel } from "@otlpkit/adapters/engine";
import { toNivoEngineLineSeries } from "@otlpkit/adapters/nivo";

const wide = toEngineWideTableModel(result);
const data = toNivoEngineLineSeries(wide);`;
}

function librarySnippet(libraryId, _chartType, componentName) {
  if (libraryId === "tremor") return `<${componentName} {...props} />`;
  if (libraryId === "recharts") {
    return `<${componentName} data={model.data}>
  <XAxis dataKey={model.xAxisKey} />
  {model.series.map((s) => <Line key={s.id} dataKey={s.dataKey} name={s.name} />)}
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
    return `const plot = new uPlot(model.options, model.data, node);
plot.setData(nextModel.data);`;
  if (libraryId === "nivo") return `<${componentName} data={data} animate={false} />`;
  if (libraryId === "visx")
    return `{model.series.map((series) => (
  <LinePath key={series.key} data={series.points} x={x} y={y} />
))}`;
  if (libraryId === "observable")
    return `Plot.plot({
  marks: plot.marks.map((mark) => Plot[mark.mark](plot.data, mark)),
});`;
  return `Plotly.react(node, traces.data, traces.layout);
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

function rowToRecord(row, series, timeKey) {
  const output = { [timeKey]: row.t };
  row.values.forEach((value, index) => {
    output[series[index].id] = value;
  });
  return output;
}

function scatterRows(wide) {
  return wide.rows.flatMap((row) =>
    wide.series.map((series, index) => ({
      time: row.t,
      value: row.values[index],
      series: series.label,
      id: series.id,
    }))
  );
}

function seriesId(series, index) {
  const parts = sortedLabelEntries(series.labels).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(",") : `series-${index}`;
}

function seriesLabel(series, index) {
  const service = series.labels.get("service") ?? `series-${index}`;
  const route = series.labels.get("route");
  const status = series.labels.get("status_class");
  return [service, route, status].filter(Boolean).join(" ");
}

function formatTime(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function sortedLabelEntries(labels) {
  return [...labels.entries()].sort(([left], [right]) => left.localeCompare(right));
}
