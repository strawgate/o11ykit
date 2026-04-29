const COLORS = ["#2563eb", "#059669", "#dc2626", "#7c3aed", "#d97706", "#0891b2"];
const activeDisposers = [];
const renderedLibraries = new Set(["tremor", "recharts", "chartjs", "echarts", "uplot"]);

let renderGeneration = 0;
let reactRuntime;
let rechartsRuntime;
let tremorRuntime;
let chartJsRuntime;
let echartsRuntime;
let uPlotRuntime;

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
