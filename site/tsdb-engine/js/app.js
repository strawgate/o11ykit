// ── App Entry Point ──────────────────────────────────────────────────

import { CHART_COLORS, renderChart, setupChartTooltip } from "./chart.js";
import {
  generateScenarioData,
  generateValue,
  INSTANCES,
  METRICS,
  REGIONS,
  SCENARIOS,
  scenarioSampleCount,
  scenarioSeriesCount,
} from "./data-gen.js";
import { ScanEngine } from "./query.js";
import { buildStorageExplorer, showChunkDetail } from "./storage-explorer.js";
import { ChunkedStore, ColumnStore, FlatStore } from "./stores.js";
import {
  $,
  autoSelectQueryStep,
  escapeHtml,
  formatBytes,
  formatDuration,
  formatNum,
} from "./utils.js";
import { loadWasm, wasmReady } from "./wasm.js";

const CHUNK_SIZE = 640;
const NS_PER_MS = 1_000_000n;
const MAX_I64 = BigInt("9223372036854775807");
const LABEL_PREFERENCE = [
  "service",
  "region",
  "instance",
  "endpoint",
  "namespace",
  "pod",
  "node",
  "cluster",
  "job",
];

// ── State ─────────────────────────────────────────────────────────────

let currentStore = null;
const currentEngine = new ScanEngine();
let generatedMetrics = [];
let activeMatchers = []; // [{label, op, value}]
let activeGroupBy = [];
const availableLabels = new Map(); // label -> Set of values
let _lastIngestTime = 0;
let _storagePopulated = false;
let _queryPopulated = false;
let _metricsPopulated = false;
let _metricsExplorerMetric = null;
let _metricsExplorerConfig = null;

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCompactStat(value) {
  const full = value.toLocaleString();
  return full.length > 7 ? compactNumberFormatter.format(value) : full;
}

function formatStorageBytes(value) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function setStatText(id, text, title = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.title = title;
  el.classList.toggle("compact", !!title);
}

function setCountStat(id, value) {
  const full = value.toLocaleString();
  const compact = formatCompactStat(value);
  setStatText(id, compact, compact !== full ? full : "");
}

function renderLegend(container, series) {
  if (!container) return;
  container.innerHTML = "";
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const labelStr =
      [...s.labels]
        .filter(([k]) => k !== "__name__")
        .map(([k, v]) => `${escapeHtml(k)}="${escapeHtml(v)}"`)
        .join(", ") || "all";
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `<span class="legend-swatch" style="background:${color}"></span>${labelStr} (${s.timestamps.length.toLocaleString()} pts)`;
    container.appendChild(item);
  }
}

function isCounterLikeMetric(metric) {
  return (
    /(?:^|_)(?:total|count|requests|events|restarts?)(?:$|_)/.test(metric) ||
    /^network_(?:rx|tx)_bytes$/.test(metric)
  );
}

function formatMetricName(metric) {
  return metric.replaceAll("_", " ");
}

function metricIcon(metric) {
  if (metric.includes("latency") || metric.includes("duration")) return "⏱️";
  if (metric.includes("error")) return "🚨";
  if (metric.includes("cpu")) return "🖥️";
  if (metric.includes("memory")) return "🧠";
  if (metric.includes("network")) return "🌐";
  if (isCounterLikeMetric(metric)) return "⚡";
  return "📈";
}

function resetMetricsExplorer() {
  _metricsPopulated = false;
  _metricsExplorerMetric = null;
  _metricsExplorerConfig = null;
}

// ── Section visibility ────────────────────────────────────────────────

function showSection(id, scroll = false) {
  const el = document.getElementById(id);
  if (el) {
    el.hidden = false;
    if (scroll) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function hideSection(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

function onDataLoaded(store, metrics, ingestTime, numPoints, intervalMs) {
  currentStore = store;
  generatedMetrics = metrics;
  _storagePopulated = false;
  _queryPopulated = false;
  resetMetricsExplorer();

  // Reset matchers from previous dataset
  activeMatchers = [];
  activeGroupBy = [];
  clearActiveRecipe();
  availableLabels.clear();

  // Populate available labels for matcher UI
  _buildAvailableLabels(store);
  _renderMatcherChips();
  _renderGroupByChips();

  // Precompute stats for the fork section
  const totalPts = store.sampleCount;
  const memBytes = store.memoryBytes();
  const rawBytes = totalPts * 16;
  const ratio = rawBytes / memBytes;
  const ingestRate = totalPts / (ingestTime / 1000);

  // Update active card with results
  const activeCard = document.querySelector(".scenario-card.loading, .scenario-card.active");
  if (activeCard) {
    activeCard.classList.remove("loading");
    activeCard.classList.add("active", "loaded");
    activeCard.setAttribute("aria-pressed", "true");
  }

  // Hide storage/query/results — let user choose via fork
  hideSection("section-storage");
  hideSection("section-metrics");
  hideSection("section-query");
  hideSection("section-query-plan");
  hideSection("section-results");

  // Show fork in the road
  showSection("section-fork", true);
  autoSelectQueryStep(intervalMs, numPoints);
}

function _buildAvailableLabels(store) {
  availableLabels.clear();
  for (let id = 0; id < store.seriesCount; id++) {
    const labels = store.labels(id);
    if (!labels) continue;
    for (const [k, v] of labels) {
      if (k === "__name__") continue;
      if (!availableLabels.has(k)) availableLabels.set(k, new Set());
      availableLabels.get(k).add(v);
    }
  }
  _refreshMatcherLabelSelect();
  _refreshGroupByOptions();
}

function _populateQueryMetrics(metrics) {
  const sel = document.getElementById("queryMetric");
  if (!sel) return;
  sel.innerHTML = "";
  for (const m of metrics) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
}

function _populateGroupByOptions(store) {
  const sel = document.getElementById("groupByLabel");
  if (!sel) return;
  const existing = [...availableLabels.keys()];
  sel.innerHTML = '<option value="">label…</option>';
  for (const k of existing) {
    if (k === "__name__") continue;
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  }
}

function _refreshGroupByOptions() {
  _populateGroupByOptions(currentStore);
}

function clearActiveRecipe() {
  document.querySelectorAll(".query-recipe.active").forEach((btn) => btn.classList.remove("active"));
}

function setActiveRecipe(recipe) {
  document.querySelectorAll(".query-recipe").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.recipe === recipe);
  });
}

// ── Matcher UI ────────────────────────────────────────────────────────

function _refreshMatcherLabelSelect() {
  const sel = document.getElementById("matcherLabel");
  if (!sel) return;
  sel.innerHTML = '<option value="">Filter label…</option>';
  for (const k of availableLabels.keys()) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  }
}

document.getElementById("matcherLabel")?.addEventListener("change", () => {
  clearActiveRecipe();
  const label = document.getElementById("matcherLabel").value;
  const valSel = document.getElementById("matcherValue");
  if (!valSel) return;
  valSel.innerHTML = '<option value="">Filter value…</option>';
  const vals = availableLabels.get(label) || new Set();
  for (const v of vals) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    valSel.appendChild(opt);
  }
});

document.getElementById("btnAddMatcher")?.addEventListener("click", () => {
  clearActiveRecipe();
  const label = document.getElementById("matcherLabel")?.value;
  const op = document.getElementById("matcherOp")?.value || "=";
  const value = document.getElementById("matcherValue")?.value;
  if (!label || !value) return;

  activeMatchers.push({ label, op, value });
  _renderMatcherChips();
  if (currentStore) runQuery();
});

function _renderMatcherChips() {
  const chips = document.getElementById("matcherChips");
  if (!chips) return;
  if (activeMatchers.length === 0) {
    chips.innerHTML = '<span class="matcher-empty">No filters yet. Add exact label matches here.</span>';
  } else {
    chips.innerHTML = activeMatchers
      .map(
        (m, i) =>
          `<span class="matcher-chip">
        <span class="mc-label">${escapeHtml(m.label)}</span>
        <span class="mc-op">${escapeHtml(m.op)}</span>
        <span class="mc-val">&quot;${escapeHtml(m.value)}&quot;</span>
        <button type="button" class="mc-remove" data-idx="${i}" aria-label="Remove matcher">×</button>
      </span>`
      )
      .join("");
  }
  chips.querySelectorAll(".mc-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      clearActiveRecipe();
      activeMatchers.splice(parseInt(btn.dataset.idx, 10), 1);
      _renderMatcherChips();
      if (currentStore) runQuery();
    });
  });
  updateQueryPreview();
}

document.getElementById("btnAddGroupBy")?.addEventListener("click", () => {
  clearActiveRecipe();
  const label = document.getElementById("groupByLabel")?.value;
  if (!label || activeGroupBy.includes(label)) return;
  activeGroupBy.push(label);
  _renderGroupByChips();
  if (currentStore) runQuery();
});

function _renderGroupByChips() {
  const chips = document.getElementById("groupByChips");
  if (!chips) return;
  if (activeGroupBy.length === 0) {
    chips.innerHTML =
      '<span class="matcher-empty">No split labels yet. Add labels to break results into separate output series.</span>';
  } else {
    chips.innerHTML = activeGroupBy
      .map(
        (label, i) =>
          `<span class="matcher-chip group-chip">
            <span class="mc-label">${escapeHtml(label)}</span>
            <button type="button" class="mc-remove" data-idx="${i}" aria-label="Remove group by label">×</button>
          </span>`
      )
      .join("");
  }
  chips.querySelectorAll(".mc-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      clearActiveRecipe();
      activeGroupBy.splice(parseInt(btn.dataset.idx, 10), 1);
      _renderGroupByChips();
      if (currentStore) runQuery();
    });
  });
  updateQueryPreview();
}

// ── Metrics Explorer ──────────────────────────────────────────────────

function getMetricIds(metric) {
  return currentStore ? currentStore.matchLabel("__name__", metric) : [];
}

function suggestMetricStep(metric, ids = getMetricIds(metric)) {
  if (!currentStore || ids.length === 0) return 60000;
  const range = currentStore.read(ids[0], -MAX_I64, MAX_I64);
  if (range.timestamps.length < 2) return 60000;
  const intervalMs = Number(range.timestamps[1] - range.timestamps[0]) / 1_000_000;
  if (intervalMs <= 1000) return 10000;
  if (intervalMs <= 15000) return 60000;
  if (intervalMs <= 60000) return 300000;
  return 900000;
}

function getMetricMeta(metric) {
  const ids = getMetricIds(metric);
  const labelValues = new Map();

  for (const id of ids) {
    const labels = currentStore.labels(id);
    if (!labels) continue;
    for (const [key, value] of labels) {
      if (key === "__name__") continue;
      if (!labelValues.has(key)) labelValues.set(key, new Map());
      const counts = labelValues.get(key);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  const rankedLabels = [...labelValues.entries()]
    .map(([label, values]) => ({
      label,
      cardinality: values.size,
      values: [...values.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value]) => value),
    }))
    .filter((entry) => entry.cardinality > 1)
    .sort((a, b) => {
      const prefA = LABEL_PREFERENCE.indexOf(a.label);
      const prefB = LABEL_PREFERENCE.indexOf(b.label);
      if (prefA !== prefB) {
        if (prefA === -1) return 1;
        if (prefB === -1) return -1;
        return prefA - prefB;
      }
      return b.cardinality - a.cardinality || a.label.localeCompare(b.label);
    });

  return {
    metric,
    ids,
    seriesCount: ids.length,
    counterLike: isCounterLikeMetric(metric),
    rankedLabels,
    suggestedStepMs: suggestMetricStep(metric, ids),
  };
}

function buildMetricsViews(meta) {
  const overallTitle =
    meta.counterLike && meta.seriesCount > 1
      ? "Overall rate"
      : meta.seriesCount > 1
        ? "Overall trend"
        : "Single-series trend";
  const overallCopy = meta.counterLike
    ? "Roll up all matching series into one rate chart so you can see the big movement first."
    : meta.seriesCount > 1
      ? "Average the matching series into one line to get the broad shape before splitting."
      : "Inspect the metric as one raw series.";

  const views = [
    {
      key: "overall",
      icon: "🪄",
      title: overallTitle,
      copy: overallCopy,
      pills: [
        meta.counterLike ? "rate" : meta.seriesCount > 1 ? "avg" : "raw",
        meta.seriesCount > 1 ? `${meta.seriesCount.toLocaleString()} series` : "1 line",
      ],
      config: {
        metric: meta.metric,
        transform: meta.counterLike ? "rate" : undefined,
        agg: meta.counterLike ? "sum" : meta.seriesCount > 1 ? "avg" : undefined,
        groupBy: undefined,
        stepMs: meta.counterLike || meta.seriesCount > 1 ? meta.suggestedStepMs : 0,
        intro: meta.counterLike
          ? `Showing the total rate for ${formatMetricName(meta.metric)} across all matching series.`
          : meta.seriesCount > 1
            ? `Showing the average trend for ${formatMetricName(meta.metric)} across all matching series.`
            : `Showing the raw ${formatMetricName(meta.metric)} series.`,
      },
    },
  ];

  for (const labelMeta of meta.rankedLabels.slice(0, 4)) {
    const usesRate = meta.counterLike;
    views.push({
      key: `group:${labelMeta.label}`,
      icon: "🧩",
      title: usesRate ? `Rate by ${labelMeta.label}` : `Compare by ${labelMeta.label}`,
      copy: `Split the metric by ${labelMeta.label} so you can compare top values like ${labelMeta.values.slice(0, 3).join(", ")}.`,
      pills: [
        usesRate ? "sum(rate)" : "avg",
        `${labelMeta.cardinality} ${labelMeta.cardinality === 1 ? "value" : "values"}`,
      ],
      config: {
        metric: meta.metric,
        transform: usesRate ? "rate" : undefined,
        agg: usesRate ? "sum" : "avg",
        groupBy: [labelMeta.label],
        stepMs: meta.suggestedStepMs,
        intro: usesRate
          ? `Showing the rate for ${formatMetricName(meta.metric)} split by ${labelMeta.label}.`
          : `Showing ${formatMetricName(meta.metric)} split by ${labelMeta.label}.`,
      },
      previewValues: labelMeta.values.slice(0, 4),
    });
  }

  return views;
}

function setMetricsResultEmpty(message) {
  const introEl = document.getElementById("metricsResultIntro");
  const statsEl = document.getElementById("metricsQueryStats");
  const canvas = document.getElementById("metricsChartCanvas");
  const emptyEl = document.getElementById("metricsChartEmpty");
  const legendEl = document.getElementById("metricsChartLegend");
  const openBtn = document.getElementById("metricsOpenQuery");
  if (introEl) introEl.textContent = message;
  if (statsEl) statsEl.innerHTML = "";
  if (canvas) canvas.style.display = "none";
  if (emptyEl) {
    emptyEl.hidden = false;
    emptyEl.textContent = message;
  }
  if (legendEl) legendEl.innerHTML = "";
  if (openBtn) openBtn.disabled = true;
}

function executeStoreQuery(config) {
  if (!currentStore) return null;
  const ids = getMetricIds(config.metric);
  if (ids.length === 0) return null;

  let minT = MAX_I64;
  let maxT = -MAX_I64;
  for (const id of ids) {
    const data = currentStore.read(id, -MAX_I64, MAX_I64);
    if (data.timestamps.length === 0) continue;
    if (data.timestamps[0] < minT) minT = data.timestamps[0];
    if (data.timestamps[data.timestamps.length - 1] > maxT) {
      maxT = data.timestamps[data.timestamps.length - 1];
    }
  }

  if (minT === MAX_I64) return null;

  const t0 = performance.now();
  const result = currentEngine.query(currentStore, {
    metric: config.metric,
    start: minT,
    end: maxT,
    agg: config.agg,
    groupBy: config.groupBy,
    step: config.stepMs > 0 ? BigInt(config.stepMs) * NS_PER_MS : undefined,
    transform: config.transform,
  });
  return {
    result,
    totalSeries: ids.length,
    queryTime: performance.now() - t0,
  };
}

function applyQueryConfig(config) {
  const metricEl = document.getElementById("queryMetric");
  const aggEl = document.getElementById("queryAgg");
  const transformEl = document.getElementById("queryTransform");
  const stepEl = document.getElementById("queryStep");
  if (!metricEl || !aggEl || !transformEl || !stepEl) return;

  metricEl.value = config.metric;
  aggEl.value = config.agg ?? "";
  transformEl.value = config.transform ?? "";
  stepEl.value = String(config.stepMs ?? 0);
  activeMatchers = [];
  activeGroupBy = config.groupBy ? [...config.groupBy] : [];
  _renderMatcherChips();
  _renderGroupByChips();
  updateQueryPreview();
}

function runMetricsExplorer(config = _metricsExplorerConfig) {
  if (!config) return;
  const execution = executeStoreQuery(config);
  if (!execution) {
    setMetricsResultEmpty("No samples matched this guided view.");
    return;
  }

  _metricsExplorerConfig = config;

  const { result, totalSeries, queryTime } = execution;
  const introEl = document.getElementById("metricsResultIntro");
  const statsEl = document.getElementById("metricsQueryStats");
  const canvas = document.getElementById("metricsChartCanvas");
  const emptyEl = document.getElementById("metricsChartEmpty");
  const legendEl = document.getElementById("metricsChartLegend");
  const openBtn = document.getElementById("metricsOpenQuery");

  if (introEl) introEl.textContent = config.intro;
  if (statsEl) {
    statsEl.innerHTML = `
      <span>${formatMetricName(config.metric)}</span>
      <span>${totalSeries.toLocaleString()} input series</span>
      <span>${result.series.length.toLocaleString()} chart lines</span>
      <span>${queryTime.toFixed(1)} ms</span>
    `;
  }
  if (canvas) {
    canvas.style.display = "block";
    renderChart(canvas, result.series, formatMetricName(config.metric));
  }
  if (emptyEl) emptyEl.hidden = true;
  renderLegend(legendEl, result.series);
  if (openBtn) openBtn.disabled = false;
}

function renderMetricsViewGrid() {
  const grid = document.getElementById("metricsViewGrid");
  const introEl = document.getElementById("metricsViewIntro");
  if (!grid || !introEl) return;

  if (!_metricsExplorerMetric) {
    introEl.textContent =
      "Select a metric first, then choose whether to see the overall trend or split it by a useful label.";
    grid.innerHTML = '<div class="metrics-empty">Pick a metric above to unlock guided view choices.</div>';
    setMetricsResultEmpty("Pick a metric and a view to generate a chart here.");
    return;
  }

  const meta = getMetricMeta(_metricsExplorerMetric);
  const views = buildMetricsViews(meta);
  introEl.textContent = `We found ${meta.seriesCount.toLocaleString()} series for ${formatMetricName(meta.metric)}. Start with the overall view or compare it across a label.`;
  grid.innerHTML = views
    .map(
      (view) => `
        <button type="button" class="metrics-choice-card ${_metricsExplorerConfig?.key === view.key ? "active" : ""}" data-view-key="${escapeHtml(view.key)}">
          <div class="metrics-choice-head">
            <span class="metrics-choice-icon">${view.icon}</span>
            <div>
              <div class="metrics-choice-title">${escapeHtml(view.title)}</div>
              <div class="metrics-choice-copy">${escapeHtml(view.copy)}</div>
            </div>
          </div>
          <div class="metrics-choice-meta">
            ${view.pills.map((pill) => `<span class="metrics-pill">${escapeHtml(pill)}</span>`).join("")}
          </div>
          ${
            view.previewValues
              ? `<div class="metrics-card-labels">${view.previewValues
                  .map((value) => `<span class="metrics-tag">${escapeHtml(value)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </button>
      `
    )
    .join("");

  grid.querySelectorAll(".metrics-choice-card").forEach((card) => {
    card.addEventListener("click", () => {
      const next = views.find((view) => view.key === card.dataset.viewKey);
      if (!next) return;
      _metricsExplorerConfig = { key: next.key, ...next.config };
      renderMetricsViewGrid();
      runMetricsExplorer();
    });
  });

  if (_metricsExplorerConfig) runMetricsExplorer();
  else setMetricsResultEmpty("Choose one guided view to render the chart.");
}

function renderMetricsMetricGrid() {
  const grid = document.getElementById("metricsMetricGrid");
  if (!grid) return;

  const metas = generatedMetrics.map((metric) => getMetricMeta(metric));
  grid.innerHTML = metas
    .map(
      (meta) => `
        <button type="button" class="metrics-card ${_metricsExplorerMetric === meta.metric ? "active" : ""}" data-metric="${escapeHtml(meta.metric)}">
          <div class="metrics-card-head">
            <span class="metrics-card-icon">${metricIcon(meta.metric)}</span>
            <div>
              <div class="metrics-card-title">${escapeHtml(meta.metric)}</div>
              <div class="metrics-card-subtitle">${escapeHtml(formatMetricName(meta.metric))}</div>
            </div>
          </div>
          <div class="metrics-card-meta">
            <span class="metrics-pill">${meta.counterLike ? "counter-style" : "gauge-style"}</span>
            <span class="metrics-pill">${meta.seriesCount.toLocaleString()} series</span>
          </div>
          <div class="metrics-card-labels">
            ${meta.rankedLabels.slice(0, 3).map((label) => `<span class="metrics-tag">${escapeHtml(label.label)}</span>`).join("") || '<span class="metrics-tag">single series</span>'}
          </div>
        </button>
      `
    )
    .join("");

  grid.querySelectorAll(".metrics-card").forEach((card) => {
    card.addEventListener("click", () => {
      _metricsExplorerMetric = card.dataset.metric;
      _metricsExplorerConfig = null;
      renderMetricsMetricGrid();
      renderMetricsViewGrid();
    });
  });
}

function renderMetricsExplorer() {
  if (!currentStore) return;
  _metricsPopulated = true;
  renderMetricsMetricGrid();
  renderMetricsViewGrid();
}

// ── Fork in the Road ──────────────────────────────────────────────────

function _revealStorage() {
  if (!currentStore) return;
  if (!_storagePopulated) {
    _storagePopulated = true;
    const totalPts = currentStore.sampleCount;
    const memBytes = currentStore.memoryBytes();
    const rawBytes = totalPts * 16;
    const ratio = rawBytes / memBytes;
    const ingestRate = totalPts / (_lastIngestTime / 1000);

    setCountStat("statStoragePts", totalPts);
    setCountStat("statStorageSeries", currentStore.seriesCount);
    setStatText("statStorageMem", formatStorageBytes(memBytes));
    setStatText("statStorageRatio", `${ratio.toFixed(1)}×`);
    setStatText("statStorageIngestRate", `${formatNum(ingestRate)} pts/s`);

    // Compute chunk stats for the merged stats row
    let totalChunks = 0,
      totalFrozen = 0;
    for (let id = 0; id < currentStore.seriesCount; id++) {
      const info = currentStore.getChunkInfo(id);
      totalFrozen += info.frozen.length;
      totalChunks += info.frozen.length + (info.hot.count > 0 ? 1 : 0);
    }
    setCountStat("statStorageChunks", totalChunks);
    setCountStat("statStorageFrozen", totalFrozen);

    buildStorageExplorer(currentStore);
  }
  hideSection("section-metrics");
  hideSection("section-query");
  hideSection("section-query-plan");
  hideSection("section-results");
  showSection("section-storage", true);
  _updateExploreNav("section-storage");
}

function _revealMetrics() {
  if (!currentStore) return;
  if (!_metricsPopulated) renderMetricsExplorer();
  hideSection("section-storage");
  hideSection("section-query");
  hideSection("section-query-plan");
  hideSection("section-results");
  showSection("section-metrics", true);
  _updateExploreNav("section-metrics");
}

function _revealQuery() {
  if (!currentStore) return;
  if (!_queryPopulated) {
    _queryPopulated = true;
    _populateQueryMetrics(generatedMetrics);
    _populateGroupByOptions(currentStore);
    updateQueryPreview();
  }
  hideSection("section-storage");
  hideSection("section-metrics");
  hideSection("section-query-plan");
  hideSection("section-results");
  showSection("section-query", true);
  _updateExploreNav("section-query");
}

function _updateExploreNav(activeId) {
  document.querySelectorAll(".explore-nav-btn").forEach((btn) => {
    const isActive = btn.dataset.target === activeId;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

document.getElementById("forkStorage")?.addEventListener("click", _revealStorage);
document.getElementById("forkMetrics")?.addEventListener("click", _revealMetrics);
document.getElementById("forkQuery")?.addEventListener("click", _revealQuery);

// Explore nav buttons (breadcrumb switching)
document.querySelectorAll(".explore-nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.target === "section-storage") _revealStorage();
    else if (btn.dataset.target === "section-metrics") _revealMetrics();
    else if (btn.dataset.target === "section-query") _revealQuery();
  });
});

// ── Scenario picker ───────────────────────────────────────────────────

function clearScenarioSelection() {
  document.querySelectorAll(".scenario-card").forEach((card) => {
    card.classList.remove("active", "loading", "loaded");
    card.setAttribute("aria-pressed", "false");
  });
}

function _renderScenarioCards() {
  const grid = document.getElementById("scenarioGrid");
  if (!grid) return;
  const scenarioCards = SCENARIOS.map((s) => {
    const seriesCount = scenarioSeriesCount(s);
    const sampleCount = scenarioSampleCount(s);
    const interval =
      s.intervalMs >= 60000 ? `${s.intervalMs / 60000}min` : `${s.intervalMs / 1000}s`;
    return `
    <button type="button" class="scenario-card" data-scenario-id="${escapeHtml(s.id)}" aria-pressed="false">
      <span class="sc-selected-badge">✓ Selected</span>
      <div class="sc-emoji">${s.emoji}</div>
      <div class="sc-name">${escapeHtml(s.name)}</div>
      <div class="sc-desc">${escapeHtml(s.description)}</div>
      <div class="sc-meta-label">Sample Metrics:</div>
      <div class="sc-meta">
        ${s.metrics.map((m) => `<span class="sc-metric">${escapeHtml(m.name)}</span>`).join("")}
      </div>
      <div class="sc-stats">${seriesCount.toLocaleString()} series · ${sampleCount.toLocaleString()} pts · ${interval} interval</div>
      <div class="sc-loading-indicator"><span class="sc-spinner"></span><span class="sc-loading-text">Generating data…</span></div>
    </button>`;
  }).join("");

  const customCard = `
    <button type="button" class="scenario-card scenario-card-custom" id="openCustomGenerator" aria-pressed="false">
      <span class="sc-selected-badge">✓ Selected</span>
      <div class="sc-emoji">⚙️</div>
      <div class="sc-name">Custom Generator</div>
      <div class="sc-desc">Choose your own series count, points, data pattern, and sample interval. Full control over the generated dataset.</div>
      <span class="fork-cta" style="margin-top:auto">Open Generator →</span>
    </button>`;

  grid.innerHTML = scenarioCards + customCard;

  grid.querySelectorAll(".scenario-card[data-scenario-id]").forEach((card) => {
    card.addEventListener("click", () => {
      const scenario = SCENARIOS.find((s) => s.id === card.dataset.scenarioId);
      if (scenario) loadScenario(scenario, card);
    });
  });

  // Custom generator card toggles inline controls
  document.getElementById("openCustomGenerator")?.addEventListener("click", () => {
    const inline = document.getElementById("customGeneratorInline");
    if (inline) {
      const willShow = inline.hidden;
      clearScenarioSelection();
      inline.hidden = !inline.hidden;
      const customCard = document.getElementById("openCustomGenerator");
      if (willShow && customCard) {
        customCard.classList.add("active", "loaded");
        customCard.setAttribute("aria-pressed", "true");
        inline.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  });
}

function loadScenario(scenario, clickedCard) {
  // Show loading state
  clearScenarioSelection();
  const inline = document.getElementById("customGeneratorInline");
  if (inline) inline.hidden = true;
  if (clickedCard) {
    clickedCard.classList.add("active", "loading");
    clickedCard.setAttribute("aria-pressed", "true");
  }

  // Hide previous fork/storage/query while loading
  hideSection("section-fork");
  hideSection("section-storage");
  hideSection("section-query");
  hideSection("section-results");

  // Defer heavy work to let the loading spinner render
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const backendType = "column";
        const store = _createStore(backendType, CHUNK_SIZE);

        const t0 = performance.now();
        const seriesData = generateScenarioData(scenario);

        if (store._backendType === "column") {
          // Create all series first so groups are fully populated
          const ids = seriesData.map((sd) => store.getOrCreateSeries(sd.labels));
          // Ingest interleaved: one chunk at a time across all series in lock-step
          const numPoints = seriesData[0]?.timestamps.length || 0;
          for (let offset = 0; offset < numPoints; offset += CHUNK_SIZE) {
            const end = Math.min(offset + CHUNK_SIZE, numPoints);
            for (let i = 0; i < seriesData.length; i++) {
              store.appendBatch(
                ids[i],
                seriesData[i].timestamps.subarray(offset, end),
                seriesData[i].values.subarray(offset, end)
              );
            }
          }
        } else {
          for (const sd of seriesData) {
            const id = store.getOrCreateSeries(sd.labels);
            store.appendBatch(id, sd.timestamps, sd.values);
          }
        }

        _lastIngestTime = performance.now() - t0;
        const metrics = [...new Set(scenario.metrics.map((m) => m.name))];

        onDataLoaded(store, metrics, _lastIngestTime, scenario.numPoints, scenario.intervalMs);
      } catch (err) {
        console.error("Failed to load scenario:", err);
        if (clickedCard) {
          clickedCard.classList.remove("loading", "active", "loaded");
          clickedCard.setAttribute("aria-pressed", "false");
        }
      }
    }, 30);
  });
}

// ── Custom generator ──────────────────────────────────────────────────

document.getElementById("btnCustomGenerate")?.addEventListener("click", () => {
  const numSeries = parseInt(document.getElementById("numSeries").value, 10);
  const numPoints = parseInt(document.getElementById("numPoints").value, 10);
  const pattern = document.getElementById("dataPattern").value;
  const backendType = "column";
  const intervalMs = parseInt(document.getElementById("sampleInterval").value, 10);

  const btn = document.getElementById("btnCustomGenerate");
  btn.disabled = true;
  btn.textContent = "Generating…";

  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        generateCustomData(numSeries, numPoints, pattern, backendType, intervalMs);
      } finally {
        btn.disabled = false;
        btn.textContent = "Generate Data";
      }
    }, 50);
  });
});

function _createStore(backendType, chunkSize) {
  let store;
  if (backendType === "column") {
    if (!wasmReady) {
      console.warn("WASM unavailable — falling back to ChunkedStore");
      store = new ChunkedStore(chunkSize);
      store._backendType = "chunked";
      return store;
    }
    store = new ColumnStore(chunkSize);
  } else if (backendType === "chunked") {
    store = new ChunkedStore(chunkSize);
  } else {
    store = new FlatStore();
  }
  store._backendType = backendType;
  return store;
}

function generateCustomData(numSeries, numPoints, pattern, backendType, intervalMs) {
  const store = _createStore(backendType, CHUNK_SIZE);

  const now = BigInt(Date.now()) * NS_PER_MS;
  const intervalNs = BigInt(intervalMs) * NS_PER_MS;
  const metricsUsed = new Set();
  const seriesData = [];

  for (let si = 0; si < numSeries; si++) {
    const metricName = METRICS[si % METRICS.length];
    const region = REGIONS[Math.floor(si / METRICS.length) % REGIONS.length];
    const instance = INSTANCES[si % INSTANCES.length];
    metricsUsed.add(metricName);

    const labels = new Map([
      ["__name__", metricName],
      ["region", region],
      ["instance", instance],
      ["job", "demo"],
    ]);

    const timestamps = new BigInt64Array(numPoints);
    const values = new Float64Array(numPoints);
    const startT = now - BigInt(numPoints) * intervalNs;
    for (let i = 0; i < numPoints; i++) {
      timestamps[i] = startT + BigInt(i) * intervalNs;
      values[i] = generateValue(pattern, i, si, numPoints);
    }
    seriesData.push({ labels, timestamps, values });
  }

  const t0 = performance.now();
  if (backendType === "column") {
    const ids = seriesData.map((sd) => store.getOrCreateSeries(sd.labels));
    for (let offset = 0; offset < numPoints; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, numPoints);
      for (let i = 0; i < seriesData.length; i++) {
        store.appendBatch(
          ids[i],
          seriesData[i].timestamps.subarray(offset, end),
          seriesData[i].values.subarray(offset, end)
        );
      }
    }
  } else {
    for (const sd of seriesData) {
      const id = store.getOrCreateSeries(sd.labels);
      store.appendBatch(id, sd.timestamps, sd.values);
    }
  }
  const ingestTime = performance.now() - t0;
  _lastIngestTime = ingestTime;

  document.querySelectorAll(".scenario-card").forEach((c) => {
    c.classList.remove("active", "loading", "loaded");
  });
  onDataLoaded(store, [...metricsUsed], ingestTime, numPoints, intervalMs);
  autoSelectQueryStep(intervalMs, numPoints);
}

// ── Query Lab ─────────────────────────────────────────────────────────

document.getElementById("btnQuery")?.addEventListener("click", runQuery);

for (const id of ["queryMetric", "queryAgg", "queryStep", "queryTransform"]) {
  document.getElementById(id)?.addEventListener("change", () => {
    clearActiveRecipe();
    updateQueryPreview();
    if (currentStore) runQuery();
  });
}

function updateQueryPreview() {
  const el = document.getElementById("queryPreview")?.querySelector(".query-preview-code");
  if (!el) return;

  const metric = document.getElementById("queryMetric")?.value || "…";
  const agg = document.getElementById("queryAgg")?.value;
  const transform = document.getElementById("queryTransform")?.value;
  const stepMs = parseInt(document.getElementById("queryStep")?.value || "0", 10);

  // Build matcher string
  let matcherStr = "";
  if (activeMatchers.length > 0) {
    const parts = activeMatchers.map(
      (m) =>
        `<span class="qp-label">${escapeHtml(m.label)}</span><span class="qp-op">${escapeHtml(m.op)}</span><span class="qp-val">"${escapeHtml(m.value)}"</span>`
    );
    matcherStr = `{${parts.join(", ")}}`;
  }

  // Build PromQL-like expression
  let expr = `<span class="qp-metric">${escapeHtml(metric)}</span>${matcherStr}`;

  if (transform) {
    expr = `<span class="qp-fn">${transform}</span>(${expr})`;
  }

  if (agg) {
    expr = `<span class="qp-fn">${agg}</span>(${expr}`;
    if (stepMs > 0) {
      expr += ` <span class="qp-kw">[${formatDuration(stepMs)}]</span>`;
    }
    expr += ")";
    if (activeGroupBy.length > 0) {
      expr += ` <span class="qp-kw">by</span> (<span class="qp-group">${activeGroupBy.join(", ")}</span>)`;
    }
  }

  el.innerHTML = expr;
}

function runQuery() {
  if (!currentStore) return;

  const metric = document.getElementById("queryMetric")?.value;
  const agg = document.getElementById("queryAgg")?.value || undefined;
  const groupBy = activeGroupBy.length > 0 ? [...activeGroupBy] : undefined;
  const stepMs = parseInt(document.getElementById("queryStep")?.value || "0", 10);
  const step = stepMs > 0 ? BigInt(stepMs) * NS_PER_MS : undefined;
  const transform = document.getElementById("queryTransform")?.value || undefined;

  // Pipeline stage 1: Label matching
  const totalSeries = currentStore.seriesCount || 0;
  const ids = currentStore.matchLabel("__name__", metric);
  let matchedIds = ids;
  if (activeMatchers.length > 0) {
    matchedIds = [...ids]; // copy for intersection
    // matchLabel is called inside ScanEngine, but we can count here
  }

  if (ids.length === 0) return;

  let minT = BigInt("9223372036854775807");
  let maxT = -minT;
  for (const id of ids) {
    const data = currentStore.read(id, -minT, minT);
    if (data.timestamps.length > 0) {
      if (data.timestamps[0] < minT) minT = data.timestamps[0];
      if (data.timestamps[data.timestamps.length - 1] > maxT)
        maxT = data.timestamps[data.timestamps.length - 1];
    }
  }

  const t0 = performance.now();
  const result = currentEngine.query(currentStore, {
    metric,
    start: minT,
    end: maxT,
    agg,
    groupBy,
    step,
    transform: transform || undefined,
    matchers: activeMatchers.length > 0 ? activeMatchers : undefined,
  });
  const queryTime = performance.now() - t0;

  showSection("section-results");
  updateQueryPreview();

  // ── Pipeline visualization ──
  const planSection = document.getElementById("section-query-plan");
  const planSummary = document.getElementById("queryPlanSummary");
  const pipelineEl = document.getElementById("queryPipeline");
  if (planSection) showSection("section-query-plan");
  if (planSummary) {
    planSummary.textContent = `${result.scannedSeries.toLocaleString()} series matched, ${result.scannedSamples.toLocaleString()} samples scanned, ${result.series.length.toLocaleString()} outputs`;
  }
  if (pipelineEl) {
    // Stage 1: Label matching
    const matchEl = document.getElementById("pipelineMatchDetail");
    if (matchEl) {
      matchEl.innerHTML = `<strong>${result.scannedSeries.toLocaleString()}</strong> of ${totalSeries.toLocaleString()} series matched`;
    }
    // Stage 2: Chunk scan
    const chunksEl = document.getElementById("pipelineChunksDetail");
    if (chunksEl) {
      chunksEl.innerHTML = `<strong>${result.scannedSamples.toLocaleString()}</strong> samples across ${result.scannedSeries.toLocaleString()} series`;
    }
    // Stage 3: Decode & aggregate
    const decodeEl = document.getElementById("pipelineDecodeDetail");
    if (decodeEl) {
      decodeEl.innerHTML = `<strong>${result.series.length.toLocaleString()}</strong> result series · <strong>${queryTime.toFixed(1)} ms</strong>`;
    }
  }

  document.getElementById("qStatScannedSeries").innerHTML =
    `Scanned: <strong>${result.scannedSeries}</strong> series`;
  document.getElementById("qStatScannedSamples").innerHTML =
    `Samples: <strong>${result.scannedSamples.toLocaleString()}</strong>`;
  document.getElementById("qStatResultSeries").innerHTML =
    `Result: <strong>${result.series.length}</strong> series`;
  document.getElementById("qStatQueryTime").innerHTML =
    `Time: <strong>${queryTime.toFixed(1)} ms</strong>`;

  renderChart(document.getElementById("chartCanvas"), result.series, "");
  setupChartTooltip();
  renderLegend(document.getElementById("chartLegend"), result.series);
}

// ── Resize handler ────────────────────────────────────────────────────

let resizeController = null;
function installResizeListener() {
  if (resizeController) resizeController.abort();
  resizeController = new AbortController();
  window.addEventListener(
    "resize",
    () => {
      const resultsSection = document.getElementById("section-results");
      const metricsSection = document.getElementById("section-metrics");
      if (currentStore && resultsSection && !resultsSection.hidden) runQuery();
      if (currentStore && metricsSection && !metricsSection.hidden && _metricsExplorerConfig) {
        runMetricsExplorer();
      }
    },
    { signal: resizeController.signal }
  );
}
installResizeListener();

function _preferredLabels(preferred, maxCount = preferred.length) {
  const labels = [];
  for (const key of preferred) {
    if (availableLabels.has(key) && !labels.includes(key)) labels.push(key);
    if (labels.length >= maxCount) break;
  }
  if (labels.length >= maxCount) return labels;
  for (const key of availableLabels.keys()) {
    if (!labels.includes(key)) labels.push(key);
    if (labels.length >= maxCount) break;
  }
  return labels;
}

function applyQueryRecipe(recipe) {
  const aggEl = document.getElementById("queryAgg");
  const transformEl = document.getElementById("queryTransform");
  const stepEl = document.getElementById("queryStep");
  if (!aggEl || !transformEl || !stepEl) return;

  switch (recipe) {
    case "raw":
      aggEl.value = "";
      transformEl.value = "";
      stepEl.value = "0";
      activeGroupBy = [];
      break;
    case "rate-sum":
      aggEl.value = "sum";
      transformEl.value = "rate";
      stepEl.value = "60000";
      activeGroupBy = _preferredLabels(["region"], 1);
      break;
    case "p95":
      aggEl.value = "p95";
      transformEl.value = "";
      stepEl.value = "60000";
      activeGroupBy = _preferredLabels(["service", "endpoint", "region"], 1);
      break;
    case "count":
      aggEl.value = "count";
      transformEl.value = "";
      stepEl.value = "60000";
      activeGroupBy = _preferredLabels(["region", "instance"], 2);
      break;
    case "last":
      aggEl.value = "last";
      transformEl.value = "";
      stepEl.value = "0";
      activeGroupBy = _preferredLabels(["instance", "service", "region"], 1);
      break;
    default:
      return;
  }

  setActiveRecipe(recipe);
  _renderGroupByChips();
  updateQueryPreview();
  if (currentStore) runQuery();
}

document.querySelectorAll(".query-recipe").forEach((btn) => {
  btn.addEventListener("click", () => applyQueryRecipe(btn.dataset.recipe));
});

document.getElementById("metricsOpenQuery")?.addEventListener("click", () => {
  if (!_metricsExplorerConfig) return;
  _revealQuery();
  applyQueryConfig(_metricsExplorerConfig);
  runQuery();
});

// ── WASM init + auto-load ─────────────────────────────────────────────

loadWasm().then((ok) => {
  if (!ok) {
    console.warn("WASM unavailable — ColumnStore features disabled");
  }

  // Render scenario cards (user clicks to load — no auto-load)
  _renderScenarioCards();
});
