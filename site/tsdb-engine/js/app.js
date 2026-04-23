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

  if (queryWorkerPool) {
    queryWorkerPool.markComplete(reason, {
      scannedSeries: 0,
      scannedSamples: 0,
      resultSeries: 0,
      queryTimeMs: queryTime,
    });
  }

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
  void _provisionQueryWorkers(store);
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
    await queryWorkerPool.loadStore(store);
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
  const workers = state.workers || [];
  const plan = state.plan || null;
  const phaseSummary = _workerPhaseSummary(workers);
  const expandWorkers =
    state.phase === "running" || state.phase === "loading" || state.phase === "fallback";
  cards.push(`
    <article class="fabric-card fabric-card-coordinator phase-${escapeHtml(state.coordinator?.phase || "idle")}">
      <div class="fabric-card-top fabric-card-top-compact">
        <span class="fabric-role">Coordinator</span>
        <span class="fabric-coordinator-meta">${escapeHtml(_planMeta(plan, workers.length || 0))}</span>
      </div>
      <div class="fabric-detail fabric-detail-compact">${escapeHtml(_coordinatorNarrative(state))}</div>
      ${
        workers.length
          ? `
      <details class="fabric-worker-toggle" ${expandWorkers ? "open" : ""}>
        <summary class="fabric-worker-toggle-summary">
          <span>Show ${workers.length} query workers</span>
          <span class="fabric-worker-toggle-meta">${escapeHtml(phaseSummary)}</span>
        </summary>
        <div class="fabric-worker-grid">
          ${workers
            .map((worker) => {
              const phase = escapeHtml(worker.phase || "idle");
              const role = escapeHtml(_workerRoleLabel(worker.role));
              const isExpanded =
                worker.phase === "running" ||
                worker.phase === "loading" ||
                worker.phase === "fallback";
              return `
                <details class="fabric-worker-mini phase-${phase} role-${role}" ${isExpanded ? "open" : ""}>
                  <summary class="fabric-worker-mini-summary">
                    <div class="fabric-worker-mini-top">
                      <span class="fabric-worker-mini-name">${escapeHtml(worker.name)}</span>
                      <span class="fabric-status">${phase}</span>
                    </div>
                    <div class="fabric-worker-mini-meta">
                      <span>${role}</span>
                      <span>${worker.seriesCount?.toLocaleString() || 0} series</span>
                      <span>${worker.durationMs ? `${worker.durationMs.toFixed(1)} ms` : worker.task || "Idle"}</span>
                    </div>
                    <div class="fabric-meter fabric-meter-compact"><span style="width:${_workerMeterWidth(worker)}%"></span></div>
                  </summary>
                  <div class="fabric-worker-mini-body">
                    <div class="fabric-detail">${escapeHtml(worker.detail || "Idle")}</div>
                    <div class="fabric-task">${escapeHtml(worker.task || "Idle")}</div>
                    <div class="fabric-metrics">
                      <span>${worker.sampleCount?.toLocaleString() || 0} samples resident</span>
                      <span>${worker.scannedSeries?.toLocaleString() || 0} scanned</span>
                      <span>${worker.scannedSamples?.toLocaleString() || 0} pts</span>
                      <span>${worker.durationMs ? `${worker.durationMs.toFixed(1)} ms` : "No query yet"}</span>
                    </div>
                  </div>
                </details>
              `;
            })
            .join("")}
        </div>
      </details>`
          : ""
      }
    </article>
  `);

  gridEl.innerHTML = cards.join("");
}

function _executionStatusText(state) {
  const plan = state.plan || null;
  switch (state.phase) {
    case "loading":
      return plan ? `Provisioning ${_planTitle(plan)}` : "Provisioning workers";
    case "running":
      return "Running now";
    case "complete":
      return "Latest query complete";
    case "fallback":
      return plan?.topology === "inline" ? "Inline engine" : "Coordinator fallback";
    case "ready":
      return plan ? `${_planTitle(plan)} ready` : "Workers ready";
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

function _planTitle(plan) {
  if (!plan) return "worker pool";
  const topology =
    plan.topology === "single-worker"
      ? "single-worker"
      : plan.topology === "split"
        ? "split"
        : plan.topology === "pooled"
          ? "pooled"
          : "inline";
  const transport = plan.transport === "shared-frozen" ? "shared" : plan.transport;
  return `${topology} ${transport}`;
}

function _planMeta(plan, workerCount) {
  if (!plan) return `${workerCount} workers`;
  const transport = plan.transport === "shared-frozen" ? "SAB" : plan.transport;
  return `${plan.actualWorkers} workers · ${plan.topology} · ${transport}`;
}

function _workerRoleLabel(role) {
  switch (role) {
    case "combined-engine":
      return "coordinator + hot + frozen";
    case "primary-engine":
      return "coordinator + hot";
    case "query-shard":
      return "frozen";
    default:
      return role || "worker";
  }
}

function _workerPhaseSummary(workers) {
  if (!workers.length) return "No workers provisioned yet.";

  const counts = new Map();
  for (const worker of workers) {
    const phase = worker.phase || "idle";
    counts.set(phase, (counts.get(phase) || 0) + 1);
  }

  const order = ["running", "loading", "ready", "complete", "fallback", "idle"];
  const parts = [];
  for (const phase of order) {
    const count = counts.get(phase);
    if (!count) continue;
    parts.push(`${count} ${phase}`);
  }
  return `${workers.length} workers · ${parts.join(" · ")}`;
}

function _coordinatorNarrative(state) {
  const workers = state.workers || [];
  const workerCount = workers.length;
  const plan = state.plan || null;
  if (!workerCount)
    return (
      plan?.reason ||
      "Handles label matching, dispatch, and result merge once workers are provisioned."
    );

  const mergedStats = state.coordinator?.stats || null;
  if (
    mergedStats &&
    mergedStats.scannedSeries === 0 &&
    mergedStats.scannedSamples === 0 &&
    mergedStats.resultSeries === 0
  ) {
    return "No series matched the current metric and label filters across the worker pool.";
  }

  const residentSeries = workers.reduce((sum, worker) => sum + (worker.seriesCount || 0), 0);
  const matchedSeries = workers.reduce((sum, worker) => sum + (worker.scannedSeries || 0), 0);
  const scannedSamples = workers.reduce((sum, worker) => sum + (worker.scannedSamples || 0), 0);
  const partialSeries = workers.reduce((sum, worker) => sum + (worker.resultSeries || 0), 0);

  switch (state.phase) {
    case "loading":
      return `Planning ${plan?.topology || "worker"} execution and partitioning ${residentSeries.toLocaleString()} series across ${workerCount} workers.`;
    case "ready":
      return `${plan?.reason || "Matches labels on the coordinator, then routes chunk scans and decode work across workers."} Using ${workerCount} workers in ${plan?.topology || "worker"} mode.`;
    case "running":
      return `Matched ${matchedSeries.toLocaleString()} of ${residentSeries.toLocaleString()} resident series and is fanning ${scannedSamples.toLocaleString()} samples out to ${workerCount} workers.`;
    case "complete":
      if (mergedStats) {
        return `Matched ${mergedStats.scannedSeries.toLocaleString()} series, pushed ${mergedStats.scannedSamples.toLocaleString()} samples through ${workerCount} workers, and merged ${mergedStats.resultSeries.toLocaleString()} outputs in ${mergedStats.queryTimeMs.toFixed(1)} ms.`;
      }
      return `Matched ${matchedSeries.toLocaleString()} series, pushed ${scannedSamples.toLocaleString()} samples through ${workerCount} workers, and merged ${partialSeries.toLocaleString()} partial outputs.`;
    case "fallback":
      return "Worker fan-out is unavailable, so the coordinator is matching labels, scanning chunks, and merging locally.";
    default:
      return "Waiting for a dataset before matching labels and dispatching chunk scans.";
  }
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
  if (!queryWorkerPool || !supportsParallelQuery(opts)) return false;
  const phase = queryWorkerPool.state?.phase;
  return phase === "loading" || phase === "ready" || phase === "complete";
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
      if (runSeq !== _queryRunSeq) return;
      console.error("Worker query failed", error);
      queryWorkerPool.markFallback("Worker query failed; running on coordinator");
    }
  } else if (queryWorkerPool) {
    if (runSeq !== _queryRunSeq) return;
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

  if (usedWorkers && workerQueryId !== null) {
    queryWorkerPool.markMerged(
      workerQueryId,
      `${queryWorkerPool.workers.length} workers merged ${result.series.length.toLocaleString()} outputs in ${queryTime.toFixed(1)} ms`,
      {
        scannedSeries: result.scannedSeries,
        scannedSamples: result.scannedSamples,
        resultSeries: result.series.length,
        queryTimeMs: queryTime,
      }
    );
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
