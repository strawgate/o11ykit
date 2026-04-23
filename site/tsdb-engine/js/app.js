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
import { QueryWorkerPool, supportsParallelQuery } from "./query-pool.js";
import { loadWasm, wasmReady } from "./wasm.js";

const CHUNK_SIZE = 640;
const NS_PER_MS = 1_000_000n;

// ── State ─────────────────────────────────────────────────────────────

let currentStore = null;
const currentEngine = new ScanEngine();
let generatedMetrics = [];
let activeMatchers = []; // [{label, op, value}]
const availableLabels = new Map(); // label -> Set of values
let _lastIngestTime = 0;
let _storagePopulated = false;
let _queryPopulated = false;
let currentDataRange = null;
let queryWorkerPool = null;
let _queryRunSeq = 0;

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

function onDataLoaded(store, metrics, ingestTime, numPoints, intervalMs, seriesData) {
  currentStore = store;
  generatedMetrics = metrics;
  _storagePopulated = false;
  _queryPopulated = false;
  currentDataRange =
    seriesData && seriesData.length > 0
      ? {
          minT: seriesData[0].timestamps[0],
          maxT: seriesData[0].timestamps[seriesData[0].timestamps.length - 1],
        }
      : null;

  // Reset matchers from previous dataset
  activeMatchers = [];
  availableLabels.clear();

  // Populate available labels for matcher UI
  _buildAvailableLabels(store);

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
    const doneEl = activeCard.querySelector(".sc-done-stats");
    if (doneEl) {
      doneEl.textContent = `✓ ${totalPts.toLocaleString()} pts in ${ingestTime.toFixed(0)} ms · ${ratio.toFixed(0)}× compression · ${formatBytes(memBytes)}`;
    }
  }

  // Hide storage/query/results — let user choose via fork
  hideSection("section-storage");
  hideSection("section-query");
  hideSection("section-results");

  // Show fork in the road
  showSection("section-fork", true);
  autoSelectQueryStep(intervalMs, numPoints);
  void _provisionQueryWorkers(seriesData);
}

async function _provisionQueryWorkers(seriesData) {
  if (!seriesData?.length || typeof Worker === "undefined") {
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
    await queryWorkerPool.loadSeriesData(seriesData);
  } catch (error) {
    console.error("Failed to provision query workers", error);
    queryWorkerPool.markFallback("Worker pool failed to initialize");
  }
}

function _renderQueryFabricMonitor(state) {
  const panelEl = document.getElementById("queryExecutionPanel");
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
  if (state.phase === "complete") return state.summary || "Latest query finished across the worker pool.";
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
    .map(([k, v]) => `${k}=${v}`)
    .join("\0");
}

function _deserializeWorkerResult(result) {
  return {
    scannedSeries: result.scannedSeries,
    scannedSamples: result.scannedSamples,
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
  return { series, scannedSeries, scannedSamples };
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
    series: [...groups.values()].map((group) => {
      const points = [...group.points.values()].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
      );
      return {
        labels: group.labels,
        timestamps: BigInt64Array.from(points.map((point) => point.timestamp)),
        values: Float64Array.from(points.map((point) => (point.count > 0 ? point.sum / point.count : 0))),
      };
    }),
  };
}

function _canRunOnWorkers(opts) {
  return queryWorkerPool?.state?.phase === "ready" && supportsParallelQuery(opts);
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
  const sel = document.getElementById("queryGroupBy");
  if (!sel) return;
  const existing = [...availableLabels.keys()];
  sel.innerHTML = '<option value="">No grouping</option>';
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

// ── Matcher UI ────────────────────────────────────────────────────────

function _refreshMatcherLabelSelect() {
  const sel = document.getElementById("matcherLabel");
  if (!sel) return;
  sel.innerHTML = '<option value="">label…</option>';
  for (const k of availableLabels.keys()) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  }
}

document.getElementById("matcherLabel")?.addEventListener("change", () => {
  const label = document.getElementById("matcherLabel").value;
  const valSel = document.getElementById("matcherValue");
  if (!valSel) return;
  valSel.innerHTML = '<option value="">value…</option>';
  const vals = availableLabels.get(label) || new Set();
  for (const v of vals) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    valSel.appendChild(opt);
  }
});

document.getElementById("btnAddMatcher")?.addEventListener("click", () => {
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
  chips.querySelectorAll(".mc-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeMatchers.splice(parseInt(btn.dataset.idx, 10), 1);
      _renderMatcherChips();
      if (currentStore) runQuery();
    });
  });
  updateQueryPreview();
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

    document.getElementById("statStoragePts").textContent = totalPts.toLocaleString();
    document.getElementById("statStorageSeries").textContent =
      currentStore.seriesCount.toLocaleString();
    document.getElementById("statStorageMem").textContent = formatBytes(memBytes);
    document.getElementById("statStorageRatio").textContent = `${ratio.toFixed(1)}×`;
    document.getElementById("statStorageIngestRate").textContent = `${formatNum(ingestRate)} pts/s`;

    // Compute chunk stats for the merged stats row
    let totalChunks = 0,
      totalFrozen = 0;
    for (let id = 0; id < currentStore.seriesCount; id++) {
      const info = currentStore.getChunkInfo(id);
      totalFrozen += info.frozen.length;
      totalChunks += info.frozen.length + (info.hot.count > 0 ? 1 : 0);
    }
    document.getElementById("statStorageChunks").textContent = totalChunks.toLocaleString();
    document.getElementById("statStorageFrozen").textContent = totalFrozen.toLocaleString();

    buildStorageExplorer(currentStore);
  }
  hideSection("section-query");
  hideSection("section-results");
  showSection("section-storage", true);
  _updateExploreNav("section-storage");
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
document.getElementById("forkQuery")?.addEventListener("click", _revealQuery);

// Explore nav buttons (breadcrumb switching)
document.querySelectorAll(".explore-nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.target === "section-storage") _revealStorage();
    else if (btn.dataset.target === "section-query") _revealQuery();
  });
});

// ── Scenario picker ───────────────────────────────────────────────────

function _renderScenarioCards() {
  const grid = document.getElementById("scenarioGrid");
  if (!grid) return;
  const scenarioCards = SCENARIOS.map((s) => {
    const seriesCount = scenarioSeriesCount(s);
    const sampleCount = scenarioSampleCount(s);
    const interval =
      s.intervalMs >= 60000 ? `${s.intervalMs / 60000}min` : `${s.intervalMs / 1000}s`;
    return `
    <button type="button" class="scenario-card" data-scenario-id="${escapeHtml(s.id)}">
      <div class="sc-emoji">${s.emoji}</div>
      <div class="sc-name">${escapeHtml(s.name)}</div>
      <div class="sc-desc">${escapeHtml(s.description)}</div>
      <div class="sc-meta">
        ${s.metrics.map((m) => `<span class="sc-metric">${escapeHtml(m.name)}</span>`).join("")}
      </div>
      <div class="sc-stats">${seriesCount.toLocaleString()} series · ${sampleCount.toLocaleString()} pts · ${interval} interval</div>
      <div class="sc-loading-indicator"><span class="sc-spinner"></span><span class="sc-loading-text">Generating data…</span></div>
      <div class="sc-done-stats"></div>
    </button>`;
  }).join("");

  const customCard = `
    <button type="button" class="scenario-card scenario-card-custom" id="openCustomGenerator">
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
      inline.hidden = !inline.hidden;
      if (!inline.hidden) inline.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

function loadScenario(scenario, clickedCard) {
  // Show loading state
  document.querySelectorAll(".scenario-card").forEach((c) => {
    c.classList.remove("active", "loading", "loaded");
  });
  if (clickedCard) clickedCard.classList.add("loading");

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

        onDataLoaded(
          store,
          metrics,
          _lastIngestTime,
          scenario.numPoints,
          scenario.intervalMs,
          seriesData
        );
      } catch (err) {
        console.error("Failed to load scenario:", err);
        if (clickedCard) clickedCard.classList.remove("loading");
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
  onDataLoaded(store, [...metricsUsed], ingestTime, numPoints, intervalMs, seriesData);
  autoSelectQueryStep(intervalMs, numPoints);
}

// ── Query Lab ─────────────────────────────────────────────────────────

document.getElementById("btnQuery")?.addEventListener("click", runQuery);

for (const id of ["queryMetric", "queryAgg", "queryGroupBy", "queryStep", "queryTransform"]) {
  document.getElementById(id)?.addEventListener("change", () => {
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
  const groupByVal = document.getElementById("queryGroupBy")?.value;
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
    if (groupByVal) {
      expr += ` <span class="qp-kw">by</span> (<span class="qp-group">${groupByVal}</span>)`;
    }
  }

  el.innerHTML = expr;
}

async function runQuery() {
  if (!currentStore) return;
  const runSeq = ++_queryRunSeq;

  const metric = document.getElementById("queryMetric")?.value;
  const agg = document.getElementById("queryAgg")?.value || undefined;
  const groupByVal = document.getElementById("queryGroupBy")?.value;
  const groupBy = groupByVal ? [groupByVal] : undefined;
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
  const minT = currentDataRange?.minT ?? 0n;
  const maxT = currentDataRange?.maxT ?? 0n;

  const queryOpts = {
    metric,
    start: minT,
    end: maxT,
    agg,
    groupBy,
    step,
    transform: transform || undefined,
    matchers: activeMatchers.length > 0 ? activeMatchers : undefined,
  };

  const t0 = performance.now();
  let result;
  let workerQueryId = null;

  if (_canRunOnWorkers(queryOpts)) {
    const workerResponses = await queryWorkerPool.query(queryOpts);
    if (runSeq !== _queryRunSeq) return;
    workerQueryId = workerResponses[0]?.queryId ?? null;

    if (agg === "avg") {
      const sumResults = workerResponses.map((response) => _deserializeWorkerResult(response.sum));
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
  } else {
    if (queryWorkerPool) {
      queryWorkerPool.markFallback(
        supportsParallelQuery(queryOpts)
          ? "Worker pool provisioning; running on coordinator"
          : `${agg || "raw"} queries stay on the coordinator`
      );
    }
    result = currentEngine.query(currentStore, queryOpts);
  }

  const queryTime = performance.now() - t0;
  if (runSeq !== _queryRunSeq) return;

  if (queryWorkerPool && workerQueryId != null) {
    queryWorkerPool.markMerged(
      workerQueryId,
      `Merged ${result.series.length.toLocaleString()} series from ${queryWorkerPool.workers.length} workers in ${queryTime.toFixed(1)} ms`
    );
  }

  showSection("section-results");
  updateQueryPreview();

  // ── Pipeline visualization ──
  const pipelineEl = document.getElementById("queryPipeline");
  if (pipelineEl) {
    pipelineEl.hidden = false;
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
    // Animate stages in
    for (const stage of pipelineEl.querySelectorAll(".pipeline-stage")) {
      stage.classList.add("pipeline-active");
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

  const legendEl = document.getElementById("chartLegend");
  if (legendEl) {
    legendEl.innerHTML = "";
    for (let i = 0; i < result.series.length; i++) {
      const s = result.series[i];
      const color = CHART_COLORS[i % CHART_COLORS.length];
      const labelStr =
        [...s.labels]
          .filter(([k]) => k !== "__name__")
          .map(([k, v]) => `${escapeHtml(k)}="${escapeHtml(v)}"`)
          .join(", ") || "all";
      const item = document.createElement("div");
      item.className = "legend-item";
      item.innerHTML = `<span class="legend-swatch" style="background:${color}"></span>${labelStr} (${s.timestamps.length.toLocaleString()} pts)`;
      legendEl.appendChild(item);
    }
  }
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
      if (currentStore && resultsSection && !resultsSection.hidden) runQuery();
    },
    { signal: resizeController.signal }
  );
}
installResizeListener();

// ── WASM init + auto-load ─────────────────────────────────────────────

loadWasm().then((ok) => {
  if (!ok) {
    console.warn("WASM unavailable — ColumnStore features disabled");
  }

  // Render scenario cards (user clicks to load — no auto-load)
  _renderScenarioCards();
});
