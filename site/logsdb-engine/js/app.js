// @ts-nocheck
// ── LogsDB Engine — App Entry Point ───────────────────────────────────
// Three-panel interactive experience:
//   1. Storage Explorer — byte-level chunk inspection
//   2. Logs Explorer — curated service health + insights
//   3. Query Builder — full query API exposed in UI

import { DATASET_PRESETS, generateLogs } from "./data-gen.js";
import { analyzeStore } from "./logs-model.js";
import {
  buildQuerySpec,
  computeSeverityDistribution,
  computeServiceDistribution,
  createQueryState,
  executeQuery,
  formatBody,
  formatBodyPreview,
  formatTimestamp,
  severityColor,
  severityLabel,
} from "./query-model.js";
import {
  createStore,
  getChunkDetails,
  getServiceBreakdown,
  getStoreStats,
  ingestRecords,
} from "./storage-model.js";

// ── State ─────────────────────────────────────────────────────────────

let store = null;
let genStats = null;
let queryState = createQueryState();
let lastQueryResult = null;
let currentTab = "storage";

// ── DOM Helpers ───────────────────────────────────────────────────────

function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setHtml(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

function show(id) {
  const el = $(id);
  if (el) el.hidden = false;
}

function hide(id) {
  const el = $(id);
  if (el) el.hidden = true;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatNum(n) {
  return n.toLocaleString();
}

// ── Dataset Generation ───────────────────────────────────────────────

function initDatasetButtons() {
  const container = $("dataset-buttons");
  if (!container) return;

  container.innerHTML = Object.entries(DATASET_PRESETS)
    .map(
      ([key, preset]) => `
    <button class="dataset-btn" data-preset="${key}">
      <span class="dataset-label">${preset.label}</span>
      <span class="dataset-desc">${preset.description}</span>
    </button>
  `
    )
    .join("");

  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".dataset-btn");
    if (!btn) return;
    const preset = btn.dataset.preset;
    generateDataset(preset);
  });
}

async function generateDataset(presetKey) {
  const preset = DATASET_PRESETS[presetKey];
  if (!preset) return;

  // Disable buttons during generation
  const buttons = document.querySelectorAll(".dataset-btn");
  buttons.forEach((b) => (b.disabled = true));
  show("gen-progress");
  setText("gen-status", "Generating log records...");

  // Use requestAnimationFrame to allow UI updates
  await new Promise((r) => requestAnimationFrame(r));

  const t0 = performance.now();

  // Generate in a setTimeout to not block UI
  await new Promise((resolve) => {
    setTimeout(() => {
      const result = generateLogs({
        count: preset.count,
        durationMinutes: preset.durationMinutes,
        onProgress: (p) => {
          const pct = Math.round(p * 100);
          setText("gen-status", `Generating... ${pct}%`);
          const bar = $("gen-bar");
          if (bar) bar.style.width = `${pct}%`;
        },
      });

      genStats = result.stats;
      const genTime = performance.now() - t0;

      setText("gen-status", `Ingesting ${formatNum(preset.count)} records into LogStore...`);

      // Create store and ingest
      store = createStore();
      const ingestResult = ingestRecords(store, result.records);

      const totalTime = performance.now() - t0;

      // Update stats
      const storeStats = getStoreStats(store);
      setText("stat-logs", formatNum(storeStats.totalLogs));
      setText("stat-bytes-per-log", `${storeStats.bytesPerLogFormatted} B/log`);
      setText("stat-compression", `${storeStats.compressionRatio.toFixed(0)}×`);
      setText("stat-streams", formatNum(storeStats.streams));
      setText("stat-chunks", formatNum(storeStats.chunks));
      setText("stat-total-bytes", formatBytes(storeStats.totalChunkBytes));
      setText("stat-ingest-rate", `${formatNum(ingestResult.logsPerSecond)} logs/s`);
      setText("stat-gen-time", `${totalTime.toFixed(0)}ms`);

      show("stats-panel");
      show("tabs-panel");
      hide("gen-progress");

      // Render initial tab
      renderCurrentTab();

      buttons.forEach((b) => (b.disabled = false));
      resolve();
    }, 10);
  });
}

// ── Tab Navigation ───────────────────────────────────────────────────

function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      renderCurrentTab();
    });
  });
}

function renderCurrentTab() {
  hide("panel-storage");
  hide("panel-logs");
  hide("panel-query");
  show(`panel-${currentTab}`);

  switch (currentTab) {
    case "storage":
      renderStorageExplorer();
      break;
    case "logs":
      renderLogsExplorer();
      break;
    case "query":
      renderQueryBuilder();
      break;
  }
}

// ── Storage Explorer ─────────────────────────────────────────────────

function renderStorageExplorer() {
  if (!store) return;

  const chunks = getChunkDetails(store);
  const services = getServiceBreakdown(store);

  // Service breakdown table
  setHtml(
    "service-breakdown",
    `<table class="data-table">
      <thead><tr>
        <th>Service</th><th>Logs</th><th>Chunks</th><th>Bytes</th><th>B/log</th><th>Ratio</th>
      </tr></thead>
      <tbody>
        ${services
          .map(
            (s) => `<tr>
          <td><code>${escapeHtml(s.name)}</code></td>
          <td>${formatNum(s.logs)}</td>
          <td>${s.chunks}</td>
          <td>${formatBytes(s.bytes)}</td>
          <td>${s.bytesPerLog}</td>
          <td>${s.compressionRatio}×</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`
  );

  // Chunk list
  const maxChunksShown = 50;
  const shownChunks = chunks.slice(0, maxChunksShown);
  setHtml(
    "chunk-list",
    `<div class="chunk-grid">
      ${shownChunks
        .map(
          (c, i) => `
        <div class="chunk-card" data-index="${i}">
          <div class="chunk-header">
            <span class="chunk-service">${escapeHtml(c.service)}</span>
            <span class="chunk-meta">#${c.chunkIndex}</span>
          </div>
          <div class="chunk-stats">
            <span>${formatNum(c.nLogs)} logs</span>
            <span>${formatBytes(c.totalBytes)}</span>
            <span>${c.bytesPerLog} B/log</span>
            <span>${c.compressionRatio}× ratio</span>
          </div>
          <div class="chunk-bar" style="--ratio: ${Math.min(1, Number(c.bytesPerLog) / 30)}">
            <div class="chunk-bar-fill"></div>
          </div>
        </div>`
        )
        .join("")}
    </div>
    ${chunks.length > maxChunksShown ? `<p class="muted">Showing ${maxChunksShown} of ${chunks.length} chunks</p>` : ""}`
  );
}

// ── Logs Explorer ────────────────────────────────────────────────────

function renderLogsExplorer() {
  if (!store) return;

  setText("logs-loading", "Analyzing...");
  show("logs-loading");

  // Defer to allow UI update
  requestAnimationFrame(() => {
    const analysis = analyzeStore(store);
    hide("logs-loading");

    // Service health cards
    setHtml(
      "service-health",
      analysis.services
        .map(
          (s) => `
        <div class="service-card ${Number(s.errorRate) > 5 ? "service-unhealthy" : ""}">
          <div class="service-name">${escapeHtml(s.name)}</div>
          <div class="service-stats">
            <span>${formatNum(s.logs)} logs</span>
            <span class="service-errors">${s.errors} errors (${s.errorRate}%)</span>
            <span>${formatBytes(s.bytes)}</span>
          </div>
        </div>`
        )
        .join("")
    );

    // Error clusters
    if (analysis.errors.length > 0) {
      setHtml(
        "error-clusters",
        `<h4>Error Clusters (${analysis.errors.length} patterns)</h4>
        <div class="error-list">
          ${analysis.errors
            .slice(0, 10)
            .map(
              (e) => `
            <div class="error-item">
              <div class="error-body"><code>${escapeHtml(e.body.slice(0, 100))}</code></div>
              <div class="error-meta">
                <span class="error-count">${e.count}× occurrences</span>
                <span class="error-services">${e.services.join(", ")}</span>
              </div>
            </div>`
            )
            .join("")}
        </div>`
      );
    } else {
      setHtml("error-clusters", "<p class='muted'>No errors found.</p>");
    }

    // Template analysis
    if (analysis.templates.length > 0) {
      setHtml(
        "template-analysis",
        `<h4>Top Log Templates</h4>
        <div class="template-list">
          ${analysis.templates
            .slice(0, 10)
            .map(
              (t) => `
            <div class="template-item">
              <code class="template-pattern">${escapeHtml(t.pattern.slice(0, 100))}</code>
              <span class="template-count">${t.count}×</span>
            </div>`
            )
            .join("")}
        </div>`
      );
    }
  });
}

// ── Query Builder ────────────────────────────────────────────────────

function renderQueryBuilder() {
  if (!store) return;
  renderQueryForm();
  if (lastQueryResult) renderQueryResults(lastQueryResult);
}

function renderQueryForm() {
  const form = $("query-form");
  if (!form) return;

  form.innerHTML = `
    <div class="query-row">
      <label>
        <input type="checkbox" id="qf-severity-en" ${queryState.severity.enabled ? "checked" : ""} />
        Severity ≥
      </label>
      <select id="qf-severity-val" ${!queryState.severity.enabled ? "disabled" : ""}>
        ${["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]
          .map((s) => `<option value="${s}" ${queryState.severity.min === s ? "selected" : ""}>${s}</option>`)
          .join("")}
      </select>
    </div>

    <div class="query-row">
      <label>
        <input type="checkbox" id="qf-body-en" ${queryState.bodyContains.enabled ? "checked" : ""} />
        Body contains
      </label>
      <input type="text" id="qf-body-val" value="${escapeHtml(queryState.bodyContains.value)}"
        placeholder="e.g. timeout, error, payment" ${!queryState.bodyContains.enabled ? "disabled" : ""} />
    </div>

    <div class="query-row">
      <label>
        <input type="checkbox" id="qf-resource-en" ${queryState.resourceEquals.enabled ? "checked" : ""} />
        Service name =
      </label>
      <input type="text" id="qf-resource-val" value="${escapeHtml(queryState.resourceEquals.value)}"
        placeholder="e.g. api-gateway, database" ${!queryState.resourceEquals.enabled ? "disabled" : ""} />
    </div>

    <div class="query-row">
      <label>
        <input type="checkbox" id="qf-leaf-en" ${queryState.bodyLeafEquals.enabled ? "checked" : ""} />
        Body field =
      </label>
      <input type="text" id="qf-leaf-path" value="${escapeHtml(queryState.bodyLeafEquals.path)}"
        placeholder="e.g. req.method" style="width:120px" ${!queryState.bodyLeafEquals.enabled ? "disabled" : ""} />
      <input type="text" id="qf-leaf-val" value="${escapeHtml(queryState.bodyLeafEquals.value)}"
        placeholder="value" style="width:100px" ${!queryState.bodyLeafEquals.enabled ? "disabled" : ""} />
    </div>

    <div class="query-row">
      <label>
        <input type="checkbox" id="qf-limit-en" ${queryState.limit.enabled ? "checked" : ""} />
        Limit
      </label>
      <input type="number" id="qf-limit-val" value="${queryState.limit.value}" min="1" max="10000"
        ${!queryState.limit.enabled ? "disabled" : ""} />
    </div>

    <div class="query-actions">
      <button id="run-query-btn" class="cta cta-primary">Run Query</button>
    </div>
  `;

  // Wire up event handlers
  $("run-query-btn").addEventListener("click", handleRunQuery);

  // Checkbox toggles
  for (const [prefix, field] of [
    ["qf-severity", "severity"],
    ["qf-body", "bodyContains"],
    ["qf-resource", "resourceEquals"],
    ["qf-leaf", "bodyLeafEquals"],
    ["qf-limit", "limit"],
  ]) {
    const cb = $(`${prefix}-en`);
    if (cb)
      cb.addEventListener("change", () => {
        queryState[field].enabled = cb.checked;
        renderQueryForm();
      });
  }
}

function handleRunQuery() {
  // Read form state
  queryState.severity.enabled = $("qf-severity-en")?.checked ?? false;
  queryState.severity.min = $("qf-severity-val")?.value ?? "WARN";
  queryState.bodyContains.enabled = $("qf-body-en")?.checked ?? false;
  queryState.bodyContains.value = $("qf-body-val")?.value ?? "";
  queryState.resourceEquals.enabled = $("qf-resource-en")?.checked ?? false;
  queryState.resourceEquals.value = $("qf-resource-val")?.value ?? "";
  queryState.bodyLeafEquals.enabled = $("qf-leaf-en")?.checked ?? false;
  queryState.bodyLeafEquals.path = $("qf-leaf-path")?.value ?? "";
  queryState.bodyLeafEquals.value = $("qf-leaf-val")?.value ?? "";
  queryState.limit.enabled = $("qf-limit-en")?.checked ?? false;
  queryState.limit.value = Number($("qf-limit-val")?.value ?? 100);

  const result = executeQuery(store, queryState);
  lastQueryResult = result;
  renderQueryResults(result);
}

function renderQueryResults(result) {
  const container = $("query-results");
  if (!container) return;

  const { records, stats } = result;

  // Stats bar
  const sevDist = computeSeverityDistribution(records);
  const svcDist = computeServiceDistribution(records);

  container.innerHTML = `
    <div class="query-stats-bar">
      <span class="qs-item"><strong>${formatNum(stats.recordsEmitted)}</strong> results</span>
      <span class="qs-item"><strong>${stats.totalTimeMs}</strong>ms</span>
      <span class="qs-item"><strong>${formatNum(stats.chunksScanned)}</strong> chunks scanned</span>
      <span class="qs-item"><strong>${formatNum(stats.chunksPruned)}</strong> chunks pruned</span>
      <span class="qs-item"><strong>${stats.decodeMillis.toFixed(1)}</strong>ms decode</span>
    </div>

    <div class="query-distributions">
      <div class="dist-severity">
        ${Object.entries(sevDist)
          .filter(([, v]) => v > 0)
          .map(
            ([k, v]) =>
              `<span class="sev-badge" style="--sev-color: ${severityColor({ TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 }[k])}">${k}: ${v}</span>`
          )
          .join("")}
      </div>
    </div>

    <div class="log-table-wrap">
      <table class="log-table">
        <thead><tr>
          <th>Time</th><th>Sev</th><th>Service</th><th>Body</th>
        </tr></thead>
        <tbody>
          ${records
            .slice(0, 200)
            .map(
              (r) => `
            <tr class="log-row sev-${severityLabel(r.severityNumber).toLowerCase()}">
              <td class="log-time"><code>${formatTimestamp(r.timeUnixNano).slice(11, 23)}</code></td>
              <td class="log-sev"><span class="sev-pill" style="background: ${severityColor(r.severityNumber)}">${severityLabel(r.severityNumber)}</span></td>
              <td class="log-svc"><code>${escapeHtml(r.attributes?.find((a) => a.key === "service.name")?.value ?? "")}</code></td>
              <td class="log-body"><code>${escapeHtml(formatBodyPreview(r.body, 100))}</code></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      ${records.length > 200 ? `<p class="muted">Showing 200 of ${records.length} results</p>` : ""}
    </div>
  `;
}

// ── Init ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initDatasetButtons();
  initTabs();
});
