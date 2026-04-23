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
import {
  formatEffectiveStepStat,
  formatStepLabel,
  summarizeStepResolution,
} from "./query-builder-model.js";
import { QueryWorkerPool, supportsParallelQuery } from "./query-pool.js";
import { buildStorageExplorer } from "./storage-explorer.js";
import { ChunkedStore, ColumnStore, FlatStore } from "./stores.js";
import { autoSelectQueryStep, escapeHtml, formatNum } from "./utils.js";
import { loadWasm, wasmReady } from "./wasm.js";

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
let queryWorkerPool = null;
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
  void _provisionQueryWorkers(store);
}

function _snapshotSeriesData(store) {
  const seriesData = [];
  for (let id = 0; id < store.seriesCount; id++) {
    const labels = store.labels(id);
    if (!labels) continue;
    const data = store.read(id, -MAX_I64, MAX_I64);
    seriesData.push({
      labels: new Map(labels),
      timestamps: data.timestamps.slice(0),
      values: data.values.slice(0),
    });
  }
  return seriesData;
}

async function _provisionQueryWorkers(store) {
  if (typeof Worker === "undefined") {
    _renderQueryFabricMonitor({
      phase: "fallback",
      summary: "Worker pool unavailable in this browser.",
      coordinator: { phase: "fallback", detail: "Falling back to main-thread query engine" },
      workers: [],
    });
    return;
  }

  if (!queryWorkerPool) {
    queryWorkerPool = new QueryWorkerPool({
      onStateChange: _renderQueryFabricMonitor,
    });
  }

  try {
    await queryWorkerPool.loadSeriesData(_snapshotSeriesData(store));
  } catch (error) {
    console.error("Failed to provision query workers", error);
    queryWorkerPool.markFallback("Worker pool failed to initialize");
  }
}

function _renderQueryFabricMonitor(state) {
  const panelEl = document.getElementById("section-query-plan");
  const summaryEl = document.getElementById("queryExecutionSummary");
  const statusEl = document.getElementById("queryExecutionStatus");
  const detailsEl = document.getElementById("queryExecutionDetails");
  const gridEl = document.getElementById("fabricGrid");
  if (!panelEl || !summaryEl || !statusEl || !detailsEl || !gridEl) return;

  panelEl.hidden = false;
  summaryEl.textContent = _executionSummaryText(state);
  statusEl.textContent = _executionStatusText(state);
  if (state.phase === "running") detailsEl.open = true;

  const cards = [];
  cards.push(`
    <article class="fabric-card fabric-card-coordinator phase-${escapeHtml(state.coordinator?.phase || "idle")}">
      <div class="fabric-card-top">
        <span class="fabric-role">Coordinator</span>
        <span class="fabric-status">${escapeHtml(state.coordinator?.phase || "idle")}</span>
      </div>
      <div class="fabric-name">coordinator/01</div>
      <div class="fabric-detail">${escapeHtml(state.coordinator?.detail || "Waiting for dataset")}</div>
      <div class="fabric-metrics">
        <span>${escapeHtml(state.phase || "idle")}</span>
        <span>${state.workers?.length || 0} workers</span>
      </div>
    </article>
  `);

  for (const worker of state.workers || []) {
    cards.push(`
      <article class="fabric-card fabric-card-worker phase-${escapeHtml(worker.phase || "idle")} role-${escapeHtml(worker.role || "query-shard")}">
        <div class="fabric-card-top">
          <span class="fabric-role">${escapeHtml(worker.role || "query-shard")}</span>
          <span class="fabric-status">${escapeHtml(worker.phase || "idle")}</span>
        </div>
        <div class="fabric-name">${escapeHtml(worker.name)}</div>
        <div class="fabric-detail">${escapeHtml(worker.detail || "Idle")}</div>
        <div class="fabric-metrics">
          <span>${worker.seriesCount?.toLocaleString() || 0} series</span>
          <span>${worker.sampleCount?.toLocaleString() || 0} samples</span>
        </div>
        <div class="fabric-task">${escapeHtml(worker.task || "Idle")}</div>
        <div class="fabric-meter"><span style="width:${_workerMeterWidth(worker)}%"></span></div>
        <div class="fabric-metrics">
          <span>${worker.scannedSeries?.toLocaleString() || 0} scanned</span>
          <span>${worker.scannedSamples?.toLocaleString() || 0} pts</span>
          <span>${worker.durationMs ? `${worker.durationMs.toFixed(1)} ms` : "—"}</span>
        </div>
      </article>
    `);
  }

  gridEl.innerHTML = cards.join("");
}

function _executionStatusText(state) {
  switch (state.phase) {
    case "loading":
      return "Provisioning workers";
    case "running":
      return "Running now";
    case "complete":
      return "Latest query complete";
    case "fallback":
      return "Coordinator fallback";
    case "ready":
      return "Workers ready";
    default:
      return "Waiting for dataset";
  }
}

function _executionSummaryText(state) {
  if (state.phase === "loading") return state.summary || "Provisioning query workers…";
  if (state.phase === "running") return state.summary || "Coordinator is fanning out query work.";
  if (state.phase === "complete")
    return state.summary || "Latest query finished across the worker pool.";
  if (state.phase === "fallback") return state.summary || "Query ran on the coordinator.";
  if (state.phase === "ready") return state.summary || "Worker pool is warm and ready.";
  return "Load a dataset to provision query workers.";
}

function _workerMeterWidth(worker) {
  if (worker.phase === "running") return 72;
  if (worker.phase === "loading") return 48;
  if (worker.phase === "complete") return 100;
  return 18;
}

function _labelsKey(labels) {
  return [...labels.entries()]
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join("\0");
}

function _deserializeWorkerResult(result) {
  return {
    scannedSeries: result.scannedSeries,
    scannedSamples: result.scannedSamples,
    requestedStep: result.requestedStep ?? null,
    effectiveStep: result.effectiveStep ?? null,
    pointBudget: result.pointBudget ?? null,
    series: result.series.map((series) => ({
      labels: new Map(series.labels),
      timestamps: series.timestamps,
      values: series.values,
    })),
  };
}

function _mergeRawWorkerResults(results) {
  const series = [];
  let scannedSeries = 0;
  let scannedSamples = 0;
  for (const result of results) {
    scannedSeries += result.scannedSeries;
    scannedSamples += result.scannedSamples;
    series.push(...result.series);
  }
  series.sort((a, b) => _labelsKey(a.labels).localeCompare(_labelsKey(b.labels)));
  return {
    series,
    scannedSeries,
    scannedSamples,
    requestedStep: results[0]?.requestedStep ?? null,
    effectiveStep: results[0]?.effectiveStep ?? null,
    pointBudget: results[0]?.pointBudget ?? null,
  };
}

function _mergeReductionWorkerResults(results, agg) {
  const groups = new Map();
  let scannedSeries = 0;
  let scannedSamples = 0;

  for (const result of results) {
    scannedSeries += result.scannedSeries;
    scannedSamples += result.scannedSamples;
    for (const series of result.series) {
      const key = _labelsKey(series.labels);
      let group = groups.get(key);
      if (!group) {
        group = { labels: series.labels, points: new Map() };
        groups.set(key, group);
      }
      for (let i = 0; i < series.timestamps.length; i++) {
        const timestamp = series.timestamps[i];
        const value = series.values[i];
        const pointKey = timestamp.toString();
        if (!group.points.has(pointKey)) {
          group.points.set(pointKey, { timestamp, value });
          continue;
        }
        const existing = group.points.get(pointKey);
        if (agg === "sum" || agg === "count") existing.value += value;
        else if (agg === "min") existing.value = Math.min(existing.value, value);
        else if (agg === "max") existing.value = Math.max(existing.value, value);
      }
    }
  }

  return {
    scannedSeries,
    scannedSamples,
    requestedStep: results[0]?.requestedStep ?? null,
    effectiveStep: results[0]?.effectiveStep ?? null,
    pointBudget: results[0]?.pointBudget ?? null,
    series: [...groups.values()].map((group) => {
      const points = [...group.points.values()].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
      );
      return {
        labels: group.labels,
        timestamps: BigInt64Array.from(points.map((point) => point.timestamp)),
        values: Float64Array.from(points.map((point) => point.value)),
      };
    }),
  };
}

function _mergeAvgWorkerResults(sumResults, countResults) {
  const groups = new Map();
  let scannedSeries = 0;
  let scannedSamples = 0;

  for (const result of sumResults) {
    scannedSeries += result.scannedSeries;
    scannedSamples += result.scannedSamples;
    for (const series of result.series) {
      const key = _labelsKey(series.labels);
      let group = groups.get(key);
      if (!group) {
        group = { labels: series.labels, points: new Map() };
        groups.set(key, group);
      }
      for (let i = 0; i < series.timestamps.length; i++) {
        const timestamp = series.timestamps[i];
        const pointKey = timestamp.toString();
        if (!group.points.has(pointKey)) {
          group.points.set(pointKey, { timestamp, sum: 0, count: 0 });
        }
        group.points.get(pointKey).sum += series.values[i];
      }
    }
  }

  for (const result of countResults) {
    for (const series of result.series) {
      const key = _labelsKey(series.labels);
      let group = groups.get(key);
      if (!group) {
        group = { labels: series.labels, points: new Map() };
        groups.set(key, group);
      }
      for (let i = 0; i < series.timestamps.length; i++) {
        const timestamp = series.timestamps[i];
        const pointKey = timestamp.toString();
        if (!group.points.has(pointKey)) {
          group.points.set(pointKey, { timestamp, sum: 0, count: 0 });
        }
        group.points.get(pointKey).count += series.values[i];
      }
    }
  }

  return {
    scannedSeries,
    scannedSamples,
    requestedStep: sumResults[0]?.requestedStep ?? null,
    effectiveStep: sumResults[0]?.effectiveStep ?? null,
    pointBudget: sumResults[0]?.pointBudget ?? null,
    series: [...groups.values()].map((group) => {
      const points = [...group.points.values()].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
      );
      return {
        labels: group.labels,
        timestamps: BigInt64Array.from(points.map((point) => point.timestamp)),
        values: Float64Array.from(
          points.map((point) => (point.count > 0 ? point.sum / point.count : 0))
        ),
      };
    }),
  };
}

function _canRunOnWorkers(opts) {
  return (
    !!queryWorkerPool && queryWorkerPool.state?.phase !== "running" && supportsParallelQuery(opts)
  );
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
  if (!metricsExplorer.isPopulated) metricsExplorer.render();
  hideSection("section-storage");
  hideSection("section-query");
  hideSection("section-query-plan");
  hideSection("section-results");
  showSection("section-metrics", true);
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

async function runQuery(options = {}) {
  const { scrollToResults = false } = options;
  if (!currentStore) return;
  const runSeq = ++_queryRunSeq;

  const queryConfig = queryBuilder.readConfig();
  const metric = queryConfig.metric;
  const agg = queryConfig.agg;
  const groupBy = queryConfig.groupBy;
  const stepMs = queryConfig.stepMs;
  const step = stepMs > 0 ? BigInt(stepMs) * NS_PER_MS : undefined;
  const transform = queryConfig.transform;
  const chartWidth =
    document.getElementById("chartCanvas")?.parentElement?.clientWidth || window.innerWidth || 1200;
  const maxPoints = Math.max(240, Math.floor(chartWidth * 1.25));

  // Pipeline stage 1: Label matching
  const totalSeries = currentStore.seriesCount || 0;
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

  const t0 = performance.now();
  let result;
  let workerQueryId = null;
  let usedWorkers = false;

  if (_canRunOnWorkers(queryOpts)) {
    try {
      const workerResponses = await queryWorkerPool.query(queryOpts);
      if (runSeq !== _queryRunSeq) return;
      workerQueryId = workerResponses[0]?.queryId ?? null;
      usedWorkers = true;

      if (agg === "avg") {
        const sumResults = workerResponses.map((response) =>
          _deserializeWorkerResult(response.sum)
        );
        const countResults = workerResponses.map((response) =>
          _deserializeWorkerResult(response.count)
        );
        result = _mergeAvgWorkerResults(sumResults, countResults);
      } else if (agg === "sum" || agg === "min" || agg === "max" || agg === "count") {
        result = _mergeReductionWorkerResults(
          workerResponses.map((response) => _deserializeWorkerResult(response.result)),
          agg
        );
      } else {
        result = _mergeRawWorkerResults(
          workerResponses.map((response) => _deserializeWorkerResult(response.result))
        );
      }
    } catch (error) {
      console.error("Worker query failed", error);
      queryWorkerPool.markFallback("Worker query failed; running on coordinator");
    }
  } else if (queryWorkerPool) {
    queryWorkerPool.markFallback(
      supportsParallelQuery(queryOpts)
        ? "Worker pool warming up; running on coordinator"
        : "This aggregation runs on the coordinator"
    );
  }

  if (!result) {
    result = currentEngine.query(currentStore, queryOpts);
  }

  const queryTime = performance.now() - t0;

  showSection("section-results");
  queryBuilder.updatePreview();

  // ── Pipeline visualization ──
  const planSection = document.getElementById("section-query-plan");
  const planSummary = document.getElementById("queryExecutionSummary");
  const pipelineEl = document.getElementById("queryPipeline");
  if (planSection) showSection("section-query-plan");
  if (planSummary) {
    const stepSummary = summarizeStepResolution(result);
    planSummary.textContent = `${result.scannedSeries.toLocaleString()} series matched, ${result.scannedSamples.toLocaleString()} samples scanned, ${result.series.length.toLocaleString()} outputs, ${stepSummary}`;
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
      const stepDetail =
        result.effectiveStep === null || result.effectiveStep === undefined
          ? "raw resolution"
          : `step <strong>${formatStepLabel(result.effectiveStep)}</strong>`;
      decodeEl.innerHTML = `<strong>${result.series.length.toLocaleString()}</strong> result series · ${stepDetail} · <strong>${queryTime.toFixed(1)} ms</strong>`;
    }
  }

  if (usedWorkers && workerQueryId !== null) {
    queryWorkerPool.markMerged(
      workerQueryId,
      `${queryWorkerPool.workers.length} workers merged ${result.series.length.toLocaleString()} outputs in ${queryTime.toFixed(1)} ms`
    );
  }

  document.getElementById("qStatScannedSeries").innerHTML =
    `Scanned: <strong>${result.scannedSeries}</strong> series`;
  document.getElementById("qStatScannedSamples").innerHTML =
    `Samples: <strong>${result.scannedSamples.toLocaleString()}</strong>`;
  document.getElementById("qStatResultSeries").innerHTML =
    `Result: <strong>${result.series.length}</strong> series`;
  document.getElementById("qStatEffectiveStep").innerHTML = formatEffectiveStepStat(result);
  document.getElementById("qStatQueryTime").innerHTML =
    `Time: <strong>${queryTime.toFixed(1)} ms</strong>`;

  renderChart(document.getElementById("chartCanvas"), result.series, "");
  setupChartTooltip();
  renderLegend(document.getElementById("chartLegend"), result.series);

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
});

// ── WASM init + auto-load ─────────────────────────────────────────────

loadWasm().then((ok) => {
  if (!ok) {
    console.warn("WASM unavailable — ColumnStore features disabled");
  }

  // Render scenario cards (user clicks to load — no auto-load)
  datasetController.renderScenarioCards();
  datasetController.bindCustomGenerator();
});
