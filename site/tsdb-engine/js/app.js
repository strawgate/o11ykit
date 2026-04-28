// ── App Entry Point ──────────────────────────────────────────────────

import { CHART_COLORS, renderChart, setupChartTooltip } from "./chart.js";
import { createDatasetController } from "./dataset-controller.js";
import { createMetricsExplorerController } from "./metrics-explorer-view.js";
import {
  buildMetricDimensionViews,
  buildMetricOverviewConfig,
  collectMetricMeta,
  formatMetricName,
  recommendedGroupByForMetric as recommendMetricGroupBy,
} from "./metrics-model.js";
import { ScanEngine } from "./query.js";
import { createQueryBuilderController } from "./query-builder-controller.js";
import { formatEffectiveStepStat, summarizeStepResolution } from "./query-builder-model.js";
import { buildStorageExplorer, refreshActiveChunkDetail } from "./storage-explorer.js";
import { FlatStore } from "./stores.js";
import { initWasmCodecs } from "o11ytsdb";
import { RowGroupStore } from "o11ytsdb";
import { autoSelectQueryStep, escapeHtml, formatNum } from "./utils.js";

const CHUNK_SIZE = 640;
const NS_PER_MS = 1_000_000n;
const MAX_I64 = BigInt("9223372036854775807");

// ── State ─────────────────────────────────────────────────────────────

let currentStore = null;
const currentEngine = new ScanEngine();
let generatedMetrics = [];
let _lastIngestTime = 0;
let _storagePopulated = false;
let _queryPopulated = false;
let _queryRunSeq = 0;

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

function clearResultsVisuals() {
  const canvas = document.getElementById("chartCanvas");
  if (canvas instanceof HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  const legend = document.getElementById("chartLegend");
  if (legend) legend.innerHTML = "";
}

function renderNoMatchResults(reason, queryTime, requestedStep = null) {
  showSection("section-results");
  queryBuilder.updatePreview();

  const planSection = document.getElementById("section-query-plan");
  const planSummary = document.getElementById("queryExecutionSummary");
  if (planSection) showSection("section-query-plan");
  if (planSummary) planSummary.textContent = reason;

  document.getElementById("qStatScannedSeries").innerHTML = "Scanned: <strong>no matches</strong>";
  document.getElementById("qStatScannedSamples").innerHTML = "Samples: <strong>none</strong>";
  document.getElementById("qStatResultSeries").innerHTML = "Result: <strong>empty</strong>";
  document.getElementById("qStatEffectiveStep").innerHTML = formatEffectiveStepStat({
    effectiveStep: requestedStep,
    requestedStep,
    pointBudget: null,
  });
  document.getElementById("qStatQueryTime").innerHTML =
    `Time: <strong>${queryTime.toFixed(1)} ms</strong>`;

  clearResultsVisuals();
}

function resetMetricsExplorer() {
  metricsExplorer.reset();
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

function onDataLoaded(store, metrics, _ingestTime, numPoints, intervalMs) {
  currentStore = store;
  generatedMetrics = metrics;
  _storagePopulated = false;
  _queryPopulated = false;
  resetMetricsExplorer();
  queryBuilder.resetForDataset(store, metrics);

  // Precompute stats for the fork section
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

// ── Metrics Explorer ──────────────────────────────────────────────────

function getMetricIds(metric) {
  return currentStore ? currentStore.matchLabel("__name__", metric) : [];
}

function getMetricMeta(metric) {
  return collectMetricMeta(currentStore, metric);
}

function executeStoreQuery(config, options = {}) {
  if (!currentStore) return null;
  const { maxPoints } = options;
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
    maxPoints,
    transform: config.transform,
  });
  return {
    result,
    totalSeries: ids.length,
    queryTime: performance.now() - t0,
  };
}

function applyQueryConfig(config) {
  queryBuilder.applyQueryConfig(config);
}

const metricsExplorer = createMetricsExplorerController({
  getMetrics: () => generatedMetrics,
  getMetricMeta,
  buildOverviewConfig: buildMetricOverviewConfig,
  buildDimensionViews: buildMetricDimensionViews,
  executeQuery: executeStoreQuery,
  formatMetricName,
  openQueryConfig(config) {
    _revealQuery(false);
    applyQueryConfig(config);
    runQuery({ scrollToResults: true });
  },
});

const queryBuilder = createQueryBuilderController({
  getStore: () => currentStore,
  recommendGroupByForMetric: (metric, count = 1) =>
    recommendMetricGroupBy(currentStore, metric, count),
  onRunQuery: (options) => runQuery(options),
});

// ── Fork in the Road ──────────────────────────────────────────────────

function _revealStorage(scroll = true) {
  if (!currentStore) return;
  if (!_storagePopulated) {
    _storagePopulated = true;
    _updateStorageStats();
    buildStorageExplorer(currentStore);
  } else {
    // Only update stats for live refresh, don't rebuild the entire explorer list
    _updateStorageStats();
  }
  hideSection("section-metrics");
  hideSection("section-query");
  hideSection("section-query-plan");
  hideSection("section-results");
  showSection("section-storage", scroll);
  _updateExploreNav("section-storage");
}

function _updateStorageStats() {
  if (!currentStore) return;
  const totalPts = currentStore.sampleCount;
  const memBytes = currentStore.memoryBytes();
  const rawBytes = totalPts * 16;
  const ratio = rawBytes / memBytes;
  const ingestRate = _lastIngestTime > 0 ? totalPts / (_lastIngestTime / 1000) : 0;

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
}

function _revealMetrics(scroll = true) {
  if (!currentStore) return;
  if (!metricsExplorer.isPopulated) metricsExplorer.render();
  hideSection("section-storage");
  hideSection("section-query");
  hideSection("section-query-plan");
  hideSection("section-results");
  showSection("section-metrics", scroll);
  _updateExploreNav("section-metrics");
}

function _revealQuery(scroll = true) {
  if (!currentStore) return;
  if (!_queryPopulated) {
    _queryPopulated = true;
    queryBuilder.updatePreview();
  }
  hideSection("section-storage");
  hideSection("section-metrics");
  hideSection("section-query-plan");
  hideSection("section-results");
  showSection("section-query", scroll);
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

// State for loaded WASM codecs (null means not loaded yet)
let _wasmCodecs = null;

function _createStore(chunkSize) {
  // Use WASM codecs if available, fallback to JS
  const valuesCodec = _wasmCodecs?.xorValuesCodec ?? createValuesCodec();
  const tsCodec = _wasmCodecs?.tsCodec;
  const rangeCodec = _wasmCodecs?.rangeCodec;

  return new RowGroupStore(
    valuesCodec,
    chunkSize,
    () => 0, // grouper function (always 0 for single chunk)
    32,      // LRU capacity
    "RowGroupStore",
    tsCodec,
    rangeCodec
  );
}

// Pure JS fallback codec for when WASM not available
function createValuesCodec() {
  return {
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
      return new Float64Array(copy.buffer, copy.byteOffset, Math.min(n, Math.floor(bytes / 8)));
    },
  };
}

async function runQuery(options = {}) {
  const { scrollToResults = false } = options;
  if (!currentStore) return;
  const runSeq = ++_queryRunSeq;
  const t0 = performance.now();

  const queryConfig = queryBuilder.readConfig();
  const metric = queryConfig.metric || generatedMetrics[0] || "";
  const agg = queryConfig.agg;
  const groupBy = queryConfig.groupBy;
  const stepMs = queryConfig.stepMs;
  const step = stepMs > 0 ? BigInt(stepMs) * NS_PER_MS : undefined;
  const transform = queryConfig.transform;
  const chartWidth =
    document.getElementById("chartCanvas")?.parentElement?.clientWidth || window.innerWidth || 1200;
  const maxPoints = Math.max(240, Math.floor(chartWidth * 1.25));

  if (!metric) {
    renderNoMatchResults("Load a dataset to query metrics.", performance.now() - t0, step ?? null);
    return;
  }

  let ids = currentStore.matchLabel("__name__", metric);
  const activeMatchers = queryBuilder.getActiveMatchers();
  if (activeMatchers.length > 0) {
    for (const matcher of activeMatchers) {
      if (matcher.op === "!=" || matcher.op === "not=") {
        const excluded = new Set(currentStore.matchLabel(matcher.label, matcher.value));
        ids = ids.filter((id) => !excluded.has(id));
      } else {
        const matched = new Set(currentStore.matchLabel(matcher.label, matcher.value));
        ids = ids.filter((id) => matched.has(id));
      }
    }
  }
  if (ids.length === 0) {
    if (runSeq !== _queryRunSeq) return;
    renderNoMatchResults(
      "No series matched the current metric and label filters.",
      performance.now() - t0,
      step ?? null
    );
    return;
  }

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
  if (minT === BigInt("9223372036854775807")) {
    if (runSeq !== _queryRunSeq) return;
    renderNoMatchResults(
      "The selected series do not contain samples in the current range.",
      performance.now() - t0,
      step ?? null
    );
    return;
  }

  const queryOpts = {
    metric,
    start: minT,
    end: maxT,
    agg,
    groupBy,
    step,
    maxPoints,
    transform: transform || undefined,
    matchers: activeMatchers,
  };

  const result = currentEngine.query(currentStore, queryOpts);
  const queryTime = performance.now() - t0;

  showSection("section-results");
  queryBuilder.updatePreview();

  const planSection = document.getElementById("section-query-plan");
  const planSummary = document.getElementById("queryExecutionSummary");
  if (planSection) showSection("section-query-plan");
  if (planSummary) {
    const stepSummary = summarizeStepResolution(result);
    if (result.scannedSeries === 0 && result.scannedSamples === 0 && result.series.length === 0) {
      planSummary.textContent = "No series matched the current metric and label filters.";
    } else {
      planSummary.textContent = `${result.scannedSeries.toLocaleString()} series matched, ${result.scannedSamples.toLocaleString()} samples scanned, ${result.series.length.toLocaleString()} outputs, ${stepSummary}`;
    }
  }

  const noMatches =
    result.scannedSeries === 0 && result.scannedSamples === 0 && result.series.length === 0;
  document.getElementById("qStatScannedSeries").innerHTML = noMatches
    ? "Scanned: <strong>no matches</strong>"
    : `Scanned: <strong>${result.scannedSeries}</strong> series`;
  document.getElementById("qStatScannedSamples").innerHTML = noMatches
    ? "Samples: <strong>none</strong>"
    : `Samples: <strong>${result.scannedSamples.toLocaleString()}</strong>`;
  document.getElementById("qStatResultSeries").innerHTML = noMatches
    ? "Result: <strong>empty</strong>"
    : `Result: <strong>${result.series.length}</strong> series`;
  document.getElementById("qStatEffectiveStep").innerHTML = formatEffectiveStepStat(result);
  document.getElementById("qStatQueryTime").innerHTML =
    `Time: <strong>${queryTime.toFixed(1)} ms</strong>`;

  if (noMatches) {
    clearResultsVisuals();
  } else {
    renderChart(document.getElementById("chartCanvas"), result.series, "");
    setupChartTooltip();
    renderLegend(document.getElementById("chartLegend"), result.series);
  }

  if (scrollToResults) {
    requestAnimationFrame(() => {
      const target = document.querySelector("#section-results .chart-container, #section-results");
      if (!target) return;
      const top = target.getBoundingClientRect().top + window.scrollY - 12;
      window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    });
  }
}

// ── Resize handler ────────────────────────────────────────────────────

let resizeController = null;
function installResizeListener() {
  if (resizeController) resizeController.abort();
  resizeController = new AbortController();
  let resizeTimer = null;
  window.addEventListener(
    "resize",
    () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const resultsSection = document.getElementById("section-results");
        const metricsSection = document.getElementById("section-metrics");
        if (currentStore && resultsSection && !resultsSection.hidden) runQuery();
        if (currentStore && metricsSection && !metricsSection.hidden)
          metricsExplorer.handleResize();
      }, 120);
    },
    { signal: resizeController.signal }
  );
}
installResizeListener();

let _lastLiveRefresh = 0;
const LIVE_REFRESH_THROTTLE_MS = 1000;

const datasetController = createDatasetController({
  createStore: _createStore,
  chunkSize: CHUNK_SIZE,
  nsPerMs: NS_PER_MS,
  onBeforeLoad() {
    hideSection("section-fork");
    hideSection("section-storage");
    hideSection("section-metrics");
    hideSection("section-query");
    hideSection("section-query-plan");
    hideSection("section-results");
  },
  onDataLoaded(store, metrics, ingestTime, numPoints, intervalMs) {
    _lastIngestTime = ingestTime;
    onDataLoaded(store, metrics, ingestTime, numPoints, intervalMs);
  },
  onLiveUpdate(store, _scenario, _appends) {
    // 1. Always update storage stats if visible (these are light)
    const storageSection = document.getElementById("section-storage");
    if (_storagePopulated && storageSection && !storageSection.hidden) {
      _revealStorage(false);
      refreshActiveChunkDetail(store);
    }

    // 2. Throttle heavier chart re-renders
    const now = performance.now();
    if (now - _lastLiveRefresh < LIVE_REFRESH_THROTTLE_MS) return;
    _lastLiveRefresh = now;

    const metricsSection = document.getElementById("section-metrics");
    if (metricsExplorer.isPopulated && metricsSection && !metricsSection.hidden) {
      _revealMetrics(false);
      metricsExplorer.refresh();
    }

    const resultsSection = document.getElementById("section-results");
    if (_queryPopulated && resultsSection && !resultsSection.hidden) {
      runQuery({ scrollToResults: false });
    }
  },
});

// ── WASM init + auto-load ─────────────────────────────────────────────

// Load WASM codecs for RowGroupStore (XOR compression, delta-of-delta timestamps, etc)
async function loadWasm() {
  try {
    const wasmUrl = new URL("../o11ytsdb.wasm", import.meta.url).href;
    const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
    _wasmCodecs = await initWasmCodecs(module);
    wasmReady = true;
    console.log("WASM codecs loaded successfully");
    return true;
  } catch (e) {
    console.warn("WASM load failed, using JavaScript fallbacks:", e.message);
    _wasmCodecs = null;
    wasmReady = false;
    return false;
  }
}

// Finish initialization
loadWasm().then((ok) => {
  // Render scenario cards (user clicks to load — no auto-load)
  datasetController.renderScenarioCards();
  datasetController.bindCustomGenerator();
});
