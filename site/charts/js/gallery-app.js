import {
  CHART_TYPES,
  createGalleryState,
  getSupportedChart,
  LIBRARIES,
  serializableAdapterModel,
} from "./gallery-data.js";

const COLOR_SCALE = ["#2563eb", "#059669", "#dc2626", "#7c3aed", "#d97706", "#0891b2"];
const state = {
  library: "tremor",
  chartType: "line",
  tab: "adapter",
  live: false,
  liveStep: 0,
  timer: null,
};

const elements = {
  libraryButtons: document.querySelector("#libraryButtons"),
  chartButtons: document.querySelector("#chartButtons"),
  liveToggle: document.querySelector("#liveToggle"),
  adapterKind: document.querySelector("#adapterKind"),
  previewTitle: document.querySelector("#previewTitle"),
  updateModel: document.querySelector("#updateModel"),
  chartPreview: document.querySelector("#chartPreview"),
  legend: document.querySelector("#legend"),
  codeBlock: document.querySelector("#codeBlock"),
  codeTabs: document.querySelectorAll(".code-tab"),
  libraryCards: document.querySelector("#libraryCards"),
  coverageTable: document.querySelector("#coverageTable"),
};

init();

function init() {
  renderLibraryButtons();
  renderLibraryCards();
  renderCoverageTable();
  bindTabs();
  elements.liveToggle.addEventListener("click", toggleLive);
  render();
}

function render() {
  state.chartType = getSupportedChart(state.library, state.chartType);
  const gallery = createGalleryState(state.library, state.chartType, state.liveStep);
  renderLibraryButtons();
  renderChartButtons(gallery.library);
  elements.adapterKind.textContent = `${gallery.library.primaryApi} adapter`;
  elements.previewTitle.textContent = `${gallery.library.name} ${chartLabel(gallery.chartType)}`;
  elements.updateModel.textContent = gallery.library.updateModel;
  renderPreview(gallery);
  renderLegend(gallery);
  renderCode(gallery);
}

function renderLibraryButtons() {
  elements.libraryButtons.innerHTML = LIBRARIES.map(
    (library) =>
      `<button type="button" class="${library.id === state.library ? "is-active" : ""}" data-library="${library.id}">${library.name}</button>`
  ).join("");
  elements.libraryButtons.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.library = button.dataset.library;
      state.chartType = getSupportedChart(state.library, state.chartType);
      render();
    });
  });
}

function renderChartButtons(library) {
  elements.chartButtons.innerHTML = CHART_TYPES.map((chart) => {
    const supported = library.charts.includes(chart.id);
    const className = chart.id === state.chartType ? "is-active" : "";
    return `<button type="button" class="${className}" data-chart="${chart.id}" ${supported ? "" : "disabled"}>${chart.label}</button>`;
  }).join("");
  elements.chartButtons.querySelectorAll("button:not([disabled])").forEach((button) => {
    button.addEventListener("click", () => {
      state.chartType = button.dataset.chart;
      render();
    });
  });
}

function renderPreview(gallery) {
  const { chartType, wide, latest, histogram } = gallery;
  if (chartType === "donut") {
    elements.chartPreview.innerHTML = renderDonut(latest);
    return;
  }
  if (chartType === "barList") {
    elements.chartPreview.innerHTML = renderBarList(latest);
    return;
  }
  if (chartType === "histogram") {
    elements.chartPreview.innerHTML = renderHistogram(histogram);
    return;
  }
  if (chartType === "bar") {
    elements.chartPreview.innerHTML = renderBars(wide);
    return;
  }
  elements.chartPreview.innerHTML = renderLines(wide, chartType === "area");
}

function renderLines(wide, area) {
  const frame = chartFrame(wide);
  const grid = renderGrid(frame);
  const series = wide.series
    .map((_series, seriesIndex) => {
      const points = wide.rows
        .map((row) => {
          const value = row.values[seriesIndex];
          return value === null ? null : projectPoint(frame, row.t, value);
        })
        .filter(Boolean);
      const path = linePath(points);
      const baseline = frame.y + frame.height;
      const areaPath =
        area && points.length > 1
          ? `${path} L ${points.at(-1).x} ${baseline} L ${points[0].x} ${baseline} Z`
          : "";
      return `
        ${areaPath ? `<path d="${areaPath}" fill="${COLOR_SCALE[seriesIndex % COLOR_SCALE.length]}" opacity="0.12"></path>` : ""}
        <path d="${path}" fill="none" stroke="${COLOR_SCALE[seriesIndex % COLOR_SCALE.length]}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></path>
        <circle cx="${points.at(-1)?.x ?? 0}" cy="${points.at(-1)?.y ?? 0}" r="4" fill="${COLOR_SCALE[seriesIndex % COLOR_SCALE.length]}"></circle>
      `;
    })
    .join("");
  return svgShell(`${grid}${series}${renderAxisLabels(frame)}`);
}

function renderBars(wide) {
  const latest = wide.series.map((series, index) => ({
    label: series.label,
    value: wide.rows.at(-1)?.values[index] ?? 0,
  }));
  const max = Math.max(...latest.map((row) => row.value ?? 0), 1);
  const x = 78;
  const y = 54;
  const width = 560;
  const barHeight = 42;
  const gap = 22;
  const bars = latest
    .map((row, index) => {
      const barWidth = Math.max(2, ((row.value ?? 0) / max) * width);
      const top = y + index * (barHeight + gap);
      return `
        <text class="chart-label" x="${x}" y="${top - 8}">${escapeHtml(row.label)}</text>
        <rect x="${x}" y="${top}" width="${width}" height="${barHeight}" fill="rgba(17,17,15,0.08)"></rect>
        <rect x="${x}" y="${top}" width="${barWidth}" height="${barHeight}" fill="${COLOR_SCALE[index % COLOR_SCALE.length]}"></rect>
        <text class="chart-label" x="${x + barWidth + 10}" y="${top + 27}">${Math.round(row.value ?? 0)} ms</text>
      `;
    })
    .join("");
  return svgShell(bars);
}

function renderDonut(latest) {
  const values = latest.rows.map((row) => Math.max(0, row.value ?? 0));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  let offset = 0;
  const radius = 96;
  const circumference = 2 * Math.PI * radius;
  const rings = values
    .map((value, index) => {
      const length = (value / total) * circumference;
      const dash = `${length} ${circumference - length}`;
      const ring = `<circle cx="360" cy="180" r="${radius}" fill="none" stroke="${COLOR_SCALE[index % COLOR_SCALE.length]}" stroke-width="34" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 360 180)"></circle>`;
      offset += length;
      return ring;
    })
    .join("");
  return svgShell(`
    <circle cx="360" cy="180" r="${radius}" fill="none" stroke="rgba(17,17,15,0.08)" stroke-width="34"></circle>
    ${rings}
    <text x="360" y="172" text-anchor="middle" class="chart-label">latest p95</text>
    <text x="360" y="205" text-anchor="middle" font-family="var(--mono)" font-size="28" font-weight="700" fill="var(--ink)">${Math.round(total)} ms</text>
  `);
}

function renderBarList(latest) {
  const max = Math.max(...latest.rows.map((row) => row.value ?? 0), 1);
  const rows = latest.rows
    .sort((left, right) => (right.value ?? 0) - (left.value ?? 0))
    .map((row, index) => {
      const x = 88;
      const y = 56 + index * 68;
      const width = ((row.value ?? 0) / max) * 500;
      return `
        <text class="chart-label" x="${x}" y="${y - 9}">${escapeHtml(row.label)}</text>
        <rect x="${x}" y="${y}" width="500" height="28" rx="4" fill="rgba(17,17,15,0.08)"></rect>
        <rect x="${x}" y="${y}" width="${width}" height="28" rx="4" fill="${COLOR_SCALE[index % COLOR_SCALE.length]}"></rect>
        <text class="chart-label" x="${x + 520}" y="${y + 19}">${Math.round(row.value ?? 0)} ms</text>
      `;
    })
    .join("");
  return svgShell(rows);
}

function renderHistogram(histogram) {
  const max = Math.max(...histogram.buckets.map((bucket) => bucket.count), 1);
  const frame = { x: 62, y: 36, width: 596, height: 276 };
  const barWidth = frame.width / histogram.buckets.length - 12;
  const bars = histogram.buckets
    .map((bucket, index) => {
      const height = (bucket.count / max) * frame.height;
      const x = frame.x + index * (barWidth + 12);
      const y = frame.y + frame.height - height;
      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="${COLOR_SCALE[index % COLOR_SCALE.length]}"></rect>
        <text class="chart-label" x="${x + barWidth / 2}" y="${frame.y + frame.height + 22}" text-anchor="middle">${escapeHtml(bucket.label)}</text>
      `;
    })
    .join("");
  return svgShell(`${renderGrid(frame)}${bars}`);
}

function renderGrid(frame) {
  const rows = [0, 1, 2, 3, 4]
    .map((tick) => {
      const y = frame.y + (frame.height * tick) / 4;
      return `<line class="chart-grid-line" x1="${frame.x}" y1="${y}" x2="${frame.x + frame.width}" y2="${y}"></line>`;
    })
    .join("");
  return `
    ${rows}
    <line class="chart-axis" x1="${frame.x}" y1="${frame.y + frame.height}" x2="${frame.x + frame.width}" y2="${frame.y + frame.height}"></line>
    <line class="chart-axis" x1="${frame.x}" y1="${frame.y}" x2="${frame.x}" y2="${frame.y + frame.height}"></line>
  `;
}

function renderAxisLabels(frame) {
  return `
    <text class="chart-label" x="${frame.x}" y="${frame.y + frame.height + 28}">oldest</text>
    <text class="chart-label" x="${frame.x + frame.width}" y="${frame.y + frame.height + 28}" text-anchor="end">latest</text>
    <text class="chart-label" x="${frame.x}" y="${frame.y - 12}">ms</text>
  `;
}

function renderLegend(gallery) {
  const rows =
    gallery.chartType === "histogram" ? gallery.histogram.buckets.slice(0, 4) : gallery.wide.series;
  elements.legend.innerHTML = rows
    .map((row, index) => {
      const label = row.label ?? row.id;
      return `<span class="legend-item"><span class="legend-swatch" style="background:${COLOR_SCALE[index % COLOR_SCALE.length]}"></span>${escapeHtml(label)}</span>`;
    })
    .join("");
}

function renderCode(gallery) {
  const code =
    state.tab === "output"
      ? JSON.stringify(serializableAdapterModel(gallery.adapterModel), null, 2)
      : gallery.snippets[state.tab];
  elements.codeBlock.textContent = code;
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

function bindTabs() {
  elements.codeTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      elements.codeTabs.forEach((candidate) => {
        candidate.classList.toggle("is-active", candidate === button);
      });
      render();
    });
  });
}

function toggleLive() {
  state.live = !state.live;
  elements.liveToggle.setAttribute("aria-pressed", String(state.live));
  if (state.live) {
    state.timer = window.setInterval(() => {
      state.liveStep += 1;
      render();
    }, 900);
  } else {
    window.clearInterval(state.timer);
    state.timer = null;
  }
}

function chartFrame(wide) {
  const values = wide.rows.flatMap((row) => row.values.filter((value) => value !== null));
  const times = wide.rows.map((row) => row.t);
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  return {
    x: 58,
    y: 34,
    width: 604,
    height: 292,
    minX: Math.min(...times),
    maxX: Math.max(...times),
    minY: Math.max(0, minY - 16),
    maxY: maxY + 18,
  };
}

function projectPoint(frame, xValue, yValue) {
  const x = frame.x + ((xValue - frame.minX) / Math.max(1, frame.maxX - frame.minX)) * frame.width;
  const y =
    frame.y +
    frame.height -
    ((yValue - frame.minY) / Math.max(1, frame.maxY - frame.minY)) * frame.height;
  return { x, y };
}

function linePath(points) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function svgShell(content) {
  return `<title id="previewSvgTitle">Chart adapter preview</title>${content}`;
}

function chartLabel(chartType) {
  return CHART_TYPES.find((chart) => chart.id === chartType)?.label ?? chartType;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
