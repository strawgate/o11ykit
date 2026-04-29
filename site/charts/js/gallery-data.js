export const CHART_TYPES = [
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "bar", label: "Bar" },
  { id: "donut", label: "Donut" },
  { id: "histogram", label: "Histogram" },
  { id: "barList", label: "Bar list" },
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
    charts: ["line", "area", "bar", "histogram"],
    note: "Keep Recharts ergonomic: rows for data, descriptors for Line/Area/Bar dataKey wiring.",
  },
  {
    id: "chartjs",
    name: "Chart.js",
    primaryApi: "configuration",
    updateModel: "controller.update('none')",
    status: "planned",
    package: "planned engine adapter",
    charts: ["line", "area", "bar", "donut", "histogram"],
    note: "Produce chart configs with parsing disabled so large time-series stay cheap to update.",
  },
  {
    id: "echarts",
    name: "ECharts",
    primaryApi: "dataset + encode",
    updateModel: "setOption",
    status: "planned",
    package: "planned engine adapter",
    charts: ["line", "area", "bar", "donut", "histogram"],
    note: "Use dataset source and encode fields so ECharts keeps transforms and tooltips native.",
  },
  {
    id: "uplot",
    name: "uPlot",
    primaryApi: "aligned arrays",
    updateModel: "setData",
    status: "planned",
    package: "planned engine adapter",
    charts: ["line", "area"],
    note: "Keep the hot path as aligned numeric arrays, matching uPlot's low-allocation model.",
  },
  {
    id: "nivo",
    name: "Nivo",
    primaryApi: "series objects",
    updateModel: "React data updates",
    status: "research",
    package: "research shape",
    charts: ["line", "area", "bar", "donut"],
    note: "Map engine series into Nivo's nested data while keeping labels and colors predictable.",
  },
  {
    id: "visx",
    name: "Visx",
    primaryApi: "accessors + arrays",
    updateModel: "caller state updates",
    status: "research",
    package: "research shape",
    charts: ["line", "area", "bar", "histogram"],
    note: "Expose arrays and accessors, because Visx users compose marks rather than consume configs.",
  },
  {
    id: "observable",
    name: "Observable Plot",
    primaryApi: "marks",
    updateModel: "plot rebuild",
    status: "research",
    package: "research shape",
    charts: ["line", "area", "bar", "histogram"],
    note: "Flatten wide rows into tidy records and return Plot marks users can drop into Plot.plot.",
  },
  {
    id: "plotly",
    name: "Plotly",
    primaryApi: "traces",
    updateModel: "extendTraces",
    status: "research",
    package: "research shape",
    charts: ["line", "area", "bar", "donut", "histogram"],
    note: "Produce traces and layouts, with a path toward extendTraces for live dashboards.",
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
        timestamps[i] = BigInt(startMs + i * 30_000) * NS_PER_MS;
        const wave = Math.sin((i + liveStep) * 0.68 + series.phase) * 13;
        const secondary = Math.cos((i + seriesIndex) * 0.37) * 6;
        const incident = series.status === "5xx" && i > 10 ? (i - 10) * 7 : 0;
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
  const histogram = toHistogramModel(wide);

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
      return chartJsModel(chartType, wide, latest, histogram);
    case "echarts":
      return echartsModel(chartType, wide, latest, histogram);
    case "uplot":
      return uPlotModel(chartType, wide);
    case "nivo":
      return nivoModel(chartType, wide, latest);
    case "visx":
      return visxModel(chartType, wide, latest, histogram);
    case "observable":
      return observablePlotModel(chartType, wide, histogram);
    case "plotly":
      return plotlyModel(chartType, wide, latest, histogram);
    default:
      return { data: wide.rows };
  }
}

export function toHistogramModel(wide) {
  const values = wide.rows.flatMap((row) => row.values.filter((value) => value !== null));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const bucketCount = 7;
  const width = (max - min || 1) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    label: `${Math.round(min + index * width)}-${Math.round(min + (index + 1) * width)}`,
    count: 0,
  }));
  for (const value of values) {
    const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor((value - min) / width)));
    buckets[bucketIndex].count += 1;
  }
  return { kind: "histogram", buckets };
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

function chartJsModel(chartType, wide, latest, histogram) {
  if (chartType === "donut") {
    return {
      type: "doughnut",
      data: {
        labels: latest.rows.map((row) => row.label),
        datasets: [{ data: latest.rows.map((row) => row.value), backgroundColor: COLORS }],
      },
    };
  }
  if (chartType === "histogram") {
    return {
      type: "bar",
      data: {
        labels: histogram.buckets.map((bucket) => bucket.label),
        datasets: [{ label: "samples", data: histogram.buckets.map((bucket) => bucket.count) }],
      },
    };
  }
  return {
    type: chartType === "bar" ? "bar" : "line",
    data: {
      datasets: wide.series.map((series, index) => ({
        label: series.label,
        data: wide.rows.map((row) => ({ x: row.t, y: row.values[index] })),
        parsing: false,
        fill: chartType === "area",
      })),
    },
    options: { parsing: false, animation: false },
  };
}

function echartsModel(chartType, wide, latest, histogram) {
  if (chartType === "donut") {
    return {
      series: [
        { type: "pie", data: latest.rows.map((row) => ({ name: row.label, value: row.value })) },
      ],
    };
  }
  if (chartType === "histogram") {
    return {
      dataset: {
        source: [
          ["bucket", "count"],
          ...histogram.buckets.map((bucket) => [bucket.label, bucket.count]),
        ],
      },
      series: [{ type: "bar", encode: { x: "bucket", y: "count" } }],
    };
  }
  return {
    dataset: {
      source: [
        ["time", ...wide.series.map((series) => series.label)],
        ...wide.rows.map((row) => [row.t, ...row.values]),
      ],
    },
    series: wide.series.map((series) => ({
      type: chartType === "bar" ? "bar" : "line",
      name: series.label,
      encode: { x: "time", y: series.label },
      areaStyle: chartType === "area" ? {} : undefined,
    })),
  };
}

function uPlotModel(_chartType, wide) {
  return {
    data: [
      wide.rows.map((row) => Math.round(row.t / 1000)),
      ...wide.series.map((_series, index) => wide.rows.map((row) => row.values[index])),
    ],
    options: {
      scales: { x: { time: true } },
      series: [{ label: "time" }, ...wide.series.map((series) => ({ label: series.label }))],
    },
  };
}

function nivoModel(chartType, wide, latest) {
  if (chartType === "donut") {
    return latest.rows.map((row, index) => ({
      id: row.label,
      label: row.label,
      value: row.value,
      color: COLORS[index % COLORS.length],
    }));
  }
  if (chartType === "bar") {
    return wide.rows.map((row) => rowToRecord(row, wide.series, "time"));
  }
  return wide.series.map((series, index) => ({
    id: series.label,
    data: wide.rows.map((row) => ({ x: row.t, y: row.values[index] })),
  }));
}

function visxModel(chartType, wide, latest, histogram) {
  if (chartType === "histogram") return histogram.buckets;
  if (chartType === "bar")
    return latest.rows.map((row) => ({ label: row.label, value: row.value }));
  return {
    series: wide.series.map((series, index) => ({
      key: series.id,
      label: series.label,
      points: wide.rows.map((row) => ({ x: row.t, y: row.values[index] })),
    })),
    accessors: { x: "(d) => d.x", y: "(d) => d.y" },
  };
}

function observablePlotModel(chartType, wide, histogram) {
  if (chartType === "histogram") {
    return {
      data: histogram.buckets,
      marks: [{ mark: "barY", x: "label", y: "count" }],
    };
  }
  return {
    data: wide.rows.flatMap((row) =>
      wide.series.map((series, index) => ({
        time: row.t,
        value: row.values[index],
        series: series.label,
      }))
    ),
    marks: [
      {
        mark: chartType === "bar" ? "barY" : `${chartType}Y`,
        x: "time",
        y: "value",
        stroke: "series",
      },
    ],
  };
}

function plotlyModel(chartType, wide, latest, histogram) {
  if (chartType === "donut") {
    return {
      data: [
        {
          type: "pie",
          labels: latest.rows.map((row) => row.label),
          values: latest.rows.map((row) => row.value),
        },
      ],
    };
  }
  if (chartType === "histogram") {
    return {
      data: [
        {
          type: "bar",
          x: histogram.buckets.map((bucket) => bucket.label),
          y: histogram.buckets.map((bucket) => bucket.count),
        },
      ],
    };
  }
  return {
    data: wide.series.map((series, index) => ({
      type: chartType === "bar" ? "bar" : "scatter",
      mode: chartType === "bar" ? undefined : "lines",
      name: series.label,
      x: wide.rows.map((row) => row.t),
      y: wide.rows.map((row) => row.values[index]),
      fill: chartType === "area" ? "tozeroy" : undefined,
    })),
    layout: { xaxis: { type: "date" } },
  };
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
  // Implemented libraries show copy-ready imports; future libraries are labeled as API sketches.
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
    return `// Planned API sketch: this adapter is not exported yet.
const wide = toEngineWideTableModel(result);
const model = toUPlotAlignedModel(wide, {
  maxPoints: 600,
});`;
  }
  if (libraryId === "echarts") {
    return `// Planned API sketch: this adapter is not exported yet.
const wide = toEngineWideTableModel(result);
const option = toEChartsDatasetOption(wide, {
  chartType: "${chartType}",
});`;
  }
  if (libraryId === "chartjs") {
    return `// Planned API sketch: this adapter is not exported yet.
const wide = toEngineWideTableModel(result);
const config = toChartJsConfig(wide, {
  type: "${chartType === "area" ? "line" : chartType}",
  parsing: false,
});`;
  }
  if (libraryId === "plotly") {
    return `// Research shape: this adapter is not exported yet.
const wide = toEngineWideTableModel(result);
const traces = toPlotlyTraces(wide, {
  mode: "${chartType}",
});`;
  }
  if (libraryId === "observable") {
    return `// Research shape: this adapter is not exported yet.
const wide = toEngineWideTableModel(result);
const plot = toObservablePlotMarks(wide, {
  mark: "${chartType}",
});`;
  }
  if (libraryId === "visx") {
    return `// Research shape: this adapter is not exported yet.
const wide = toEngineWideTableModel(result);
const model = toVisxSeries(wide, {
  accessors: true,
});`;
  }
  return `// Research shape: this adapter is not exported yet.
const wide = toEngineWideTableModel(result);
const data = toNivoSeries(wide);`;
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
