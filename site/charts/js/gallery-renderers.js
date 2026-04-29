const COLORS = ["#2563eb", "#059669", "#dc2626", "#7c3aed", "#d97706", "#0891b2"];
const activeDisposers = [];
const renderedLibraries = new Set([
  "tremor",
  "recharts",
  "chartjs",
  "echarts",
  "uplot",
  "plotly",
  "apexcharts",
  "highcharts",
  "vegalite",
]);

let renderGeneration = 0;
let reactRuntime;
let rechartsRuntime;
let tremorRuntime;
let chartJsRuntime;
let echartsRuntime;
let uPlotRuntime;
let plotlyRuntime;
let apexChartsRuntime;
let highchartsRuntime;
let vegaLiteRuntime;

export function hasPackageRenderer(libraryId) {
  return renderedLibraries.has(libraryId);
}

export function destroyNativeCharts() {
  renderGeneration += 1;
  while (activeDisposers.length > 0) {
    activeDisposers.pop()?.();
  }
}

export function renderNativeCharts(charts, root) {
  const generation = renderGeneration;
  for (const chart of charts) {
    const target = root.querySelector(`[data-render-target="${chart.chartType}"]`);
    if (target instanceof HTMLElement) {
      void renderNativeChart(target, chart, generation);
    }
  }
}

async function renderNativeChart(target, chart, generation) {
  target.replaceChildren();
  target.dataset.rendered = "false";

  if (!hasPackageRenderer(chart.library.id)) {
    renderPlaceholder(target, chart, "Renderer package is not mounted in this gallery yet.");
    return;
  }

  target.innerHTML = `<div class="chart-render-placeholder">
    <strong>Loading ${escapeHtml(chart.library.name)}</strong>
    <span>Mounting the chart package...</span>
  </div>`;

  try {
    const dispose = await renderWithPackage(target, chart, generation);
    if (!isCurrentRender(target, generation)) return;
    target.dataset.rendered = "true";
    if (dispose) activeDisposers.push(dispose);
  } catch (error) {
    if (!isCurrentRender(target, generation)) return;
    renderPlaceholder(
      target,
      chart,
      error instanceof Error ? error.message : String(error),
      "render failed"
    );
  }
}

async function renderWithPackage(target, chart, generation) {
  if (chart.library.id === "tremor") return renderTremor(target, chart, generation);
  if (chart.library.id === "recharts") return renderRecharts(target, chart, generation);
  if (chart.library.id === "chartjs") return renderChartJs(target, chart, generation);
  if (chart.library.id === "echarts") return renderECharts(target, chart, generation);
  if (chart.library.id === "uplot") return renderUPlot(target, chart, generation);
  if (chart.library.id === "plotly") return renderPlotly(target, chart, generation);
  if (chart.library.id === "apexcharts") return renderApexCharts(target, chart, generation);
  if (chart.library.id === "highcharts") return renderHighcharts(target, chart, generation);
  if (chart.library.id === "vegalite") return renderVegaLite(target, chart, generation);
  return undefined;
}

async function loadReactRuntime() {
  reactRuntime ??= Promise.all([import("react"), import("react-dom/client")]).then(
    ([React, ReactDom]) => ({
      React: React.default,
      createRoot: ReactDom.createRoot,
    })
  );
  return reactRuntime;
}

async function loadRechartsRuntime() {
  rechartsRuntime ??= Promise.all([loadReactRuntime(), import("recharts")]).then(
    ([react, recharts]) => ({
      ...react,
      ...recharts,
    })
  );
  return rechartsRuntime;
}

async function loadTremorRuntime() {
  tremorRuntime ??= Promise.all([loadReactRuntime(), import("@tremor/react")]).then(
    ([react, tremor]) => ({
      ...react,
      ...tremor,
    })
  );
  return tremorRuntime;
}

async function loadChartJsRuntime() {
  chartJsRuntime ??= import("chart.js/auto").then((module) => module.default);
  return chartJsRuntime;
}

async function loadEChartsRuntime() {
  echartsRuntime ??= import("echarts");
  return echartsRuntime;
}

async function loadUPlotRuntime() {
  uPlotRuntime ??= Promise.all([import("uplot"), import("uplot/dist/uPlot.min.css")]).then(
    ([module]) => module.default
  );
  return uPlotRuntime;
}

async function loadPlotlyRuntime() {
  plotlyRuntime ??= import("plotly.js-dist-min").then((module) => module.default ?? module);
  return plotlyRuntime;
}

async function loadApexChartsRuntime() {
  apexChartsRuntime ??= import("apexcharts").then((module) => module.default);
  return apexChartsRuntime;
}

async function loadHighchartsRuntime() {
  highchartsRuntime ??= Promise.all([
    import("highcharts"),
    import("highcharts/highcharts-more"),
  ]).then(([module, highchartsMore]) => {
    const Highcharts = module.default ?? module;
    if (typeof highchartsMore.default === "function") {
      highchartsMore.default(Highcharts);
    }
    return Highcharts;
  });
  return highchartsRuntime;
}

async function loadVegaLiteRuntime() {
  vegaLiteRuntime ??= import("vega-embed").then((module) => module.default);
  return vegaLiteRuntime;
}

async function renderTremor(target, chart, generation) {
  const {
    AreaChart: TremorAreaChart,
    BarChart: TremorBarChart,
    BarList: TremorBarList,
    DonutChart: TremorDonutChart,
    LineChart: TremorLineChart,
    React,
    createRoot,
  } = await loadTremorRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  const model = chart.adapterModel;
  const common = {
    className: "native-react-chart",
    showAnimation: false,
  };
  const xyProps = {
    ...common,
    showLegend: false,
    showXAxis: false,
    showYAxis: false,
    yAxisWidth: 34,
  };
  const valueFormatter = (value) => `${Math.round(value)} ms`;
  const components = {
    line: React.createElement(TremorLineChart, { ...xyProps, ...model, valueFormatter }),
    area: React.createElement(TremorAreaChart, { ...xyProps, ...model, valueFormatter }),
    bar: React.createElement(TremorBarChart, { ...xyProps, ...model, valueFormatter }),
    donut: React.createElement(TremorDonutChart, {
      ...common,
      ...model,
      showLabel: false,
      valueFormatter,
    }),
    barList: React.createElement(TremorBarList, { ...common, ...model, valueFormatter }),
  };
  return renderReact(target, components[chart.chartType], createRoot);
}

async function renderRecharts(target, chart, generation) {
  const runtime = await loadRechartsRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  const { React } = runtime;
  const model = chart.adapterModel;
  if (chart.chartType === "donut") {
    return renderReact(
      target,
      React.createElement(
        runtime.ResponsiveContainer,
        { width: "100%", height: "100%" },
        React.createElement(
          runtime.PieChart,
          null,
          React.createElement(runtime.Pie, {
            data: model.data,
            dataKey: "value",
            nameKey: "label",
            innerRadius: 48,
            outerRadius: 82,
            isAnimationActive: false,
          }),
          model.data.map((_row, index) =>
            React.createElement(runtime.Cell, {
              key: `cell-${index}`,
              fill: COLORS[index % COLORS.length],
            })
          ),
          React.createElement(runtime.Tooltip, null)
        )
      ),
      runtime.createRoot
    );
  }
  if (chart.chartType === "histogram") {
    return renderReact(
      target,
      React.createElement(
        runtime.ResponsiveContainer,
        { width: "100%", height: "100%" },
        React.createElement(
          runtime.BarChart,
          { data: model.data, margin: chartMargin() },
          React.createElement(runtime.CartesianGrid, { strokeDasharray: "3 3" }),
          React.createElement(runtime.XAxis, { dataKey: model.categoryKey, tick: false }),
          React.createElement(runtime.YAxis, { width: 32 }),
          React.createElement(runtime.Tooltip, null),
          React.createElement(runtime.Bar, {
            dataKey: model.valueKey,
            fill: COLORS[0],
            isAnimationActive: false,
          })
        )
      ),
      runtime.createRoot
    );
  }
  if (chart.chartType === "scatter") {
    return renderRechartsScatter(target, chart, runtime);
  }

  const ChartComponent =
    chart.chartType === "area"
      ? runtime.AreaChart
      : chart.chartType === "bar"
        ? runtime.BarChart
        : runtime.LineChart;
  const SeriesComponent =
    chart.chartType === "area"
      ? runtime.Area
      : chart.chartType === "bar"
        ? runtime.Bar
        : runtime.Line;
  return renderReact(
    target,
    React.createElement(
      runtime.ResponsiveContainer,
      { width: "100%", height: "100%" },
      React.createElement(
        ChartComponent,
        { data: model.data, margin: chartMargin() },
        React.createElement(runtime.CartesianGrid, { strokeDasharray: "3 3" }),
        React.createElement(runtime.XAxis, { dataKey: model.xAxisKey, tick: false }),
        React.createElement(runtime.YAxis, { width: 32 }),
        React.createElement(runtime.Tooltip, null),
        model.series.map((series, index) =>
          React.createElement(SeriesComponent, {
            key: series.id,
            dataKey: series.dataKey,
            name: series.name,
            stroke: COLORS[index % COLORS.length],
            fill: COLORS[index % COLORS.length],
            dot: false,
            isAnimationActive: false,
            type: "monotone",
          })
        )
      )
    ),
    runtime.createRoot
  );
}

function renderRechartsScatter(target, chart, runtime) {
  const { React } = runtime;
  const model = chart.adapterModel;
  const seriesNames = [...new Set(model.data.map((row) => row.series))];
  return renderReact(
    target,
    React.createElement(
      runtime.ResponsiveContainer,
      { width: "100%", height: "100%" },
      React.createElement(
        runtime.ScatterChart,
        { margin: chartMargin() },
        React.createElement(runtime.CartesianGrid, { strokeDasharray: "3 3" }),
        React.createElement(runtime.XAxis, {
          dataKey: model.xAxisKey,
          type: "number",
          tick: false,
        }),
        React.createElement(runtime.YAxis, { dataKey: model.yAxisKey, width: 32 }),
        React.createElement(runtime.Tooltip, null),
        seriesNames.map((series, index) =>
          React.createElement(runtime.Scatter, {
            key: series,
            data: model.data.filter((row) => row.series === series),
            fill: COLORS[index % COLORS.length],
            isAnimationActive: false,
          })
        )
      )
    ),
    runtime.createRoot
  );
}

async function renderChartJs(target, chart, generation) {
  const Chart = await loadChartJsRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  const canvas = document.createElement("canvas");
  target.replaceChildren(canvas);
  const config = {
    ...chart.adapterModel,
    options: {
      ...chart.adapterModel.options,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: chart.chartType !== "sparkline" && chart.chartType !== "gauge" },
        tooltip: { enabled: true },
      },
    },
  };
  const instance = new Chart(canvas, config);
  return () => instance.destroy();
}

async function renderECharts(target, chart, generation) {
  const echarts = await loadEChartsRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  target.replaceChildren();
  const instance = echarts.init(target, null, { renderer: "canvas" });
  instance.setOption(echartsOptionFor(chart), true);
  return () => instance.dispose();
}

async function renderUPlot(target, chart, generation) {
  const uPlot = await loadUPlotRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  target.replaceChildren();
  const model = chart.adapterModel;
  const width = Math.max(260, target.clientWidth || 320);
  const height = Math.max(180, target.clientHeight || 220);
  const options = {
    ...model.options,
    width,
    height,
    legend: { show: chart.chartType !== "sparkline" },
    cursor: { drag: { x: false, y: false } },
    axes:
      chart.chartType === "sparkline"
        ? []
        : [
            { scale: "x", stroke: "#6f6a60", grid: { stroke: "rgba(17,17,15,0.1)" } },
            { scale: "y", stroke: "#6f6a60", grid: { stroke: "rgba(17,17,15,0.1)" } },
          ],
    series: model.options.series.map((series, index) =>
      index === 0
        ? series
        : {
            ...series,
            stroke: COLORS[(index - 1) % COLORS.length],
            width: 2,
            fill:
              chart.chartType === "area" ? `${COLORS[(index - 1) % COLORS.length]}22` : undefined,
          }
    ),
  };
  const plot = new uPlot(options, model.data, target);
  return () => plot.destroy();
}

async function renderPlotly(target, chart, generation) {
  const Plotly = await loadPlotlyRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  target.replaceChildren();
  const model = chart.adapterModel;
  const layout = {
    ...model.layout,
    autosize: true,
    height: target.clientHeight || 220,
    margin: { l: 36, r: 12, t: 12, b: 28, ...(model.layout?.margin ?? {}) },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    showlegend: chart.chartType !== "sparkline" && chart.chartType !== "gauge",
    xaxis: { ...(model.layout?.xaxis ?? {}), visible: chart.chartType !== "sparkline" },
    yaxis: { ...(model.layout?.yaxis ?? {}), visible: chart.chartType !== "sparkline" },
  };
  await Plotly.newPlot(target, model.data, layout, {
    displayModeBar: false,
    responsive: true,
  });
  return () => Plotly.purge(target);
}

async function renderApexCharts(target, chart, generation) {
  const ApexCharts = await loadApexChartsRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  target.replaceChildren();
  const model = chart.adapterModel;
  const options = {
    ...model,
    chart: {
      ...model.chart,
      type: chart.chartType === "area" ? "area" : model.chart?.type,
      animations: { enabled: false },
      height: target.clientHeight || 220,
      toolbar: { show: false },
      sparkline: {
        enabled: chart.chartType === "sparkline" || model.chart?.sparkline?.enabled === true,
      },
    },
    colors: COLORS,
    grid: { borderColor: "rgba(17,17,15,0.12)" },
    legend: { show: chart.chartType !== "sparkline" && chart.chartType !== "gauge" },
    xaxis: { type: "datetime", labels: { show: chart.chartType !== "sparkline" } },
    yaxis: { labels: { show: chart.chartType !== "sparkline" } },
  };
  const instance = new ApexCharts(target, options);
  await instance.render();
  return () => instance.destroy();
}

async function renderHighcharts(target, chart, generation) {
  const Highcharts = await loadHighchartsRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  target.replaceChildren();
  const model = chart.adapterModel;
  const options = {
    ...model,
    chart: {
      ...model.chart,
      animation: false,
      backgroundColor: "transparent",
      height: target.clientHeight || 220,
    },
    title: { text: undefined },
    credits: { enabled: false },
    accessibility: { enabled: false },
    colors: COLORS,
    legend: { enabled: chart.chartType !== "sparkline" && chart.chartType !== "gauge" },
    tooltip: { enabled: true },
    xAxis: {
      ...(model.xAxis ?? {}),
      visible: chart.chartType !== "sparkline",
      type: chart.chartType === "histogram" ? undefined : "datetime",
    },
    yAxis: { title: { text: undefined }, visible: chart.chartType !== "sparkline" },
    plotOptions: {
      ...(model.plotOptions ?? {}),
      series: { animation: false, marker: { enabled: chart.chartType === "scatter" } },
    },
  };
  const instance = Highcharts.chart(target, options);
  return () => instance.destroy();
}

async function renderVegaLite(target, chart, generation) {
  const vegaEmbed = await loadVegaLiteRuntime();
  if (!isCurrentRender(target, generation)) return undefined;

  target.replaceChildren();
  const model = chart.adapterModel;
  const spec = {
    ...model,
    width: "container",
    height: Math.max(180, target.clientHeight || 220),
    background: "transparent",
    config: {
      axis: { labelColor: "#6f6a60", title: null, gridColor: "rgba(17,17,15,0.12)" },
      legend: { labelColor: "#11110f", title: null },
      view: { stroke: null },
    },
  };
  const result = await vegaEmbed(target, spec, { actions: false, renderer: "svg" });
  return () => result.view.finalize();
}

function renderReact(target, element, createRoot) {
  target.replaceChildren();
  const root = createRoot(target);
  root.render(element);
  return () => root.unmount();
}

function echartsOptionFor(chart) {
  const model = chart.adapterModel;
  if (chart.chartType === "donut" || chart.chartType === "gauge") {
    return { ...model, animation: false, tooltip: { trigger: "item" } };
  }
  return {
    ...model,
    animation: false,
    grid: { left: 36, right: 12, top: 18, bottom: 28 },
    legend: { show: chart.chartType !== "sparkline", type: "scroll", bottom: 0 },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: chart.chartType === "histogram" ? "category" : "time",
      show: chart.chartType !== "sparkline",
    },
    yAxis: { type: "value", show: chart.chartType !== "sparkline" },
  };
}

function isCurrentRender(target, generation) {
  return generation === renderGeneration && target.isConnected;
}

function renderPlaceholder(target, chart, message, title = "adapter shape") {
  target.innerHTML = `<div class="chart-render-placeholder">
    <strong>${escapeHtml(chart.library.name)} ${escapeHtml(title)}</strong>
    <span>${escapeHtml(message)}</span>
  </div>`;
}

function chartMargin() {
  return { top: 10, right: 12, bottom: 12, left: 0 };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
