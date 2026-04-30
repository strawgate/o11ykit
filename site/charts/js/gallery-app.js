import {
  CHART_TYPES,
  createLibraryGalleryState,
  getSupportedChart,
  LIBRARIES,
  serializableAdapterModel,
} from "./gallery-data.js";
import {
  DEFAULT_LIVE_REFRESH_RATE_ID,
  getLiveRefreshRate,
  LIVE_REFRESH_RATES,
} from "./gallery-live.js";
import { destroyNativeCharts, renderNativeCharts } from "./gallery-renderers.js";

const COLOR_SCALE = ["#2563eb", "#059669", "#dc2626", "#7c3aed", "#d97706", "#0891b2"];
const state = {
  library: "tremor",
  expandedChart: null,
  tab: "adapter",
  live: false,
  liveStep: 0,
  liveRateId: DEFAULT_LIVE_REFRESH_RATE_ID,
  timer: null,
  raf: null,
  renderBusy: false,
  renderQueued: false,
  lastLayoutKey: "",
};

const elements = {
  libraryButtons: document.querySelector("#libraryButtons"),
  librarySummary: document.querySelector("#librarySummary"),
  liveToggle: document.querySelector("#liveToggle"),
  liveToggleLabel: document.querySelector("#liveToggleLabel"),
  refreshRate: document.querySelector("#refreshRate"),
  chartGallery: document.querySelector("#chartGallery"),
  libraryCards: document.querySelector("#libraryCards"),
  coverageTable: document.querySelector("#coverageTable"),
};

init();

function init() {
  renderRefreshRates();
  renderLibraryButtons();
  renderLibraryCards();
  renderCoverageTable();
  elements.liveToggle.addEventListener("click", toggleLive);
  elements.refreshRate.addEventListener("change", () => {
    state.liveRateId = elements.refreshRate.value;
    syncLiveControls();
    if (state.live) restartLiveTimer();
  });
  void render();
}

async function render() {
  const gallery = createLibraryGalleryState(state.library, state.liveStep);
  if (state.expandedChart && !gallery.library.charts.includes(state.expandedChart)) {
    state.expandedChart = null;
  }
  const layoutKey = `${gallery.library.id}:${gallery.charts.join(",")}:${state.expandedChart ?? ""}:${state.tab}`;
  renderLibrarySummary(gallery);
  if (layoutKey !== state.lastLayoutKey) {
    state.lastLayoutKey = layoutKey;
    renderLibraryButtons();
    await renderChartGallery(gallery);
    return;
  }
  await updateChartGallery(gallery);
}

function renderLibraryButtons() {
  elements.libraryButtons.innerHTML = LIBRARIES.map(
    (library) =>
      `<button type="button" class="${library.id === state.library ? "is-active" : ""}" data-library="${library.id}">${library.name}</button>`
  ).join("");
  elements.libraryButtons.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.library = button.dataset.library;
      if (state.expandedChart) {
        state.expandedChart = getSupportedChart(state.library, state.expandedChart);
      }
      void render();
    });
  });
}

function renderLibrarySummary(gallery) {
  elements.librarySummary.innerHTML = `
    <p class="t-eyebrow">rendering</p>
    <div class="library-summary-line" aria-label="${gallery.library.name} rendering details">
      <strong>${gallery.library.name}</strong>
      <span>${gallery.charts.length} charts</span>
      <span>${gallery.library.primaryApi}</span>
      <span>native package renderer</span>
    </div>
  `;
}

async function renderChartGallery(gallery) {
  destroyNativeCharts();
  elements.chartGallery.innerHTML = gallery.charts
    .map((chart) => {
      const selected = chart.chartType === state.expandedChart;
      return `
        <article
          class="chart-card ${selected ? "is-selected" : ""}"
        >
          <span class="chart-card-heading">
            <span>
              <span class="chart-card-kicker">${chart.library.primaryApi}</span>
              <strong>${chartLabel(chart.chartType)}</strong>
            </span>
            <span class="chart-card-meta">${adapterSummary(chart.adapterModel)}</span>
          </span>
          <span class="chart-card-frame">
            <span
              class="chart-card-render"
              data-render-target="${chart.chartType}"
              data-render-library="${chart.library.id}"
              data-render-chart="${chart.chartType}"
              role="img"
              aria-label="${chart.library.name} ${chartLabel(chart.chartType)} chart"
            ></span>
          </span>
          <span class="mini-legend">${renderLegend(chart)}</span>
          <span class="chart-card-actions">
            <button type="button" class="chart-code-button" data-chart="${chart.chartType}" aria-expanded="${selected}">
              ${selected ? "Hide code" : "Show code"}
            </button>
          </span>
          ${selected ? renderInlineCode(chart) : ""}
        </article>
      `;
    })
    .join("");
  elements.chartGallery.querySelectorAll(".chart-code-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.expandedChart =
        state.expandedChart === button.dataset.chart ? null : button.dataset.chart;
      state.tab = "adapter";
      void render();
    });
  });
  elements.chartGallery.querySelectorAll(".card-code-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.expandedChart = button.dataset.chart;
      state.tab = button.dataset.tab;
      void render();
    });
  });
  await renderNativeCharts(gallery.charts, elements.chartGallery);
}

async function updateChartGallery(gallery) {
  for (const chart of gallery.charts) {
    const card = elements.chartGallery
      .querySelector(`[data-render-target="${chart.chartType}"]`)
      ?.closest(".chart-card");
    if (!card) continue;
    const meta = card.querySelector(".chart-card-meta");
    if (meta) setTextIfChanged(meta, adapterSummary(chart.adapterModel));
    const legend = card.querySelector(".mini-legend");
    if (legend) setHtmlIfChanged(legend, renderLegend(chart));
    if (chart.chartType === state.expandedChart) {
      const code = card.querySelector(".card-code-block");
      if (code) setTextIfChanged(code, codeFor(chart));
    }
  }
  await renderNativeCharts(gallery.charts, elements.chartGallery);
}

function renderLegend(gallery) {
  const rows =
    gallery.chartType === "histogram" ? gallery.histogram.buckets.slice(0, 4) : gallery.wide.series;
  return rows
    .map((row, index) => {
      const label = row.label ?? row.id;
      return `<span class="legend-item"><span class="legend-swatch" style="background:${COLOR_SCALE[index % COLOR_SCALE.length]}"></span>${escapeHtml(label)}</span>`;
    })
    .join("");
}

function renderInlineCode(gallery) {
  const tabs = ["query", "adapter", "library", "output"]
    .map(
      (tab) => `
        <button
          type="button"
          class="card-code-tab ${state.tab === tab ? "is-active" : ""}"
          data-chart="${gallery.chartType}"
          data-tab="${tab}"
        >${tab}</button>
      `
    )
    .join("");
  return `
    <div class="chart-card-code">
      <div class="chart-card-code-heading">
        <span>
          <span class="chart-card-kicker">${gallery.library.primaryApi} adapter</span>
          <strong>${gallery.library.name} ${chartLabel(gallery.chartType)}</strong>
        </span>
      </div>
      <div class="card-code-tabs" role="tablist" aria-label="${gallery.library.name} ${chartLabel(gallery.chartType)} code">
        ${tabs}
      </div>
      <pre class="card-code-block">${escapeHtml(codeFor(gallery))}</pre>
    </div>
  `;
}

function codeFor(gallery) {
  const code =
    state.tab === "output"
      ? JSON.stringify(serializableAdapterModel(gallery.adapterModel), null, 2)
      : gallery.snippets[state.tab];
  return code;
}

function renderLibraryCards() {
  elements.libraryCards.innerHTML = LIBRARIES.map(
    (library) => `
      <article class="library-card">
        <div class="library-card-header">
          <h3>${library.name}</h3>
          <span class="tag">${library.status}</span>
        </div>
        <p>${library.note}</p>
        <div class="library-meta">
          <span>${library.primaryApi}</span>
          <span>${library.updateModel}</span>
          <span>${library.charts.length} shapes</span>
        </div>
        <code class="library-package">${library.package}</code>
      </article>
    `
  ).join("");
}

function renderCoverageTable() {
  const header = `<thead><tr><th>Library</th>${CHART_TYPES.map((chart) => `<th>${chart.label}</th>`).join("")}<th>Status</th><th>Primary API</th></tr></thead>`;
  const rows = LIBRARIES.map(
    (library) => `<tr>
      <td>${library.name}</td>
      ${CHART_TYPES.map((chart) => {
        const supported = library.charts.includes(chart.id);
        return `<td class="${supported ? "coverage-hit" : "coverage-partial"}">${supported ? "yes" : "recipe"}</td>`;
      }).join("")}
      <td>${library.status}</td>
      <td>${library.primaryApi}</td>
    </tr>`
  ).join("");
  elements.coverageTable.innerHTML = `${header}<tbody>${rows}</tbody>`;
}

function renderRefreshRates() {
  elements.refreshRate.innerHTML = LIVE_REFRESH_RATES.map(
    (rate) =>
      `<option value="${rate.id}" ${rate.id === state.liveRateId ? "selected" : ""}>${rate.label}</option>`
  ).join("");
  syncLiveControls();
}

function toggleLive() {
  state.live = !state.live;
  syncLiveControls();
  if (state.live) {
    restartLiveTimer();
  } else {
    stopLiveTimer();
  }
}

function syncLiveControls() {
  const rate = getLiveRefreshRate(state.liveRateId);
  elements.liveToggle.setAttribute("aria-pressed", String(state.live));
  elements.liveToggleLabel.textContent = state.live ? `Live at ${rate.label}` : `Live updates`;
  elements.liveToggle.title = `Render every ${rate.intervalMs}ms`;
}

function restartLiveTimer() {
  stopLiveTimer();
  const rate = getLiveRefreshRate(state.liveRateId);
  state.timer = window.setInterval(() => {
    state.liveStep += 1;
    scheduleRender();
  }, rate.intervalMs);
}

function stopLiveTimer() {
  if (state.timer !== null) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
}

function scheduleRender() {
  state.renderQueued = true;
  if (state.raf !== null) return;
  state.raf = window.requestAnimationFrame(async () => {
    state.raf = null;
    if (state.renderBusy || !state.renderQueued) return;
    state.renderQueued = false;
    state.renderBusy = true;
    try {
      await render();
    } finally {
      state.renderBusy = false;
      if (state.renderQueued) scheduleRender();
    }
  });
}

window.addEventListener("pagehide", () => {
  stopLiveTimer();
  if (state.raf !== null) {
    window.cancelAnimationFrame(state.raf);
    state.raf = null;
  }
});

function chartLabel(chartType) {
  return CHART_TYPES.find((chart) => chart.id === chartType)?.label ?? chartType;
}

function adapterSummary(model) {
  const output = serializableAdapterModel(model);
  if (output.chart?.type) return `chart.type=${output.chart.type}`;
  if (output.type) return `type=${output.type}`;
  if (output.mark) return `mark=${output.mark}`;
  if (output.dataset?.source) return `dataset rows=${output.dataset.source.length}`;
  if (Array.isArray(output.data)) return `data rows=${output.data.length}`;
  if (Array.isArray(output.series)) return `series=${output.series.length}`;
  return Object.keys(output).slice(0, 3).join(" + ");
}

function setTextIfChanged(element, next) {
  if (element.textContent !== next) {
    element.textContent = next;
  }
}

function setHtmlIfChanged(element, next) {
  if (element.innerHTML !== next) {
    element.innerHTML = next;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
