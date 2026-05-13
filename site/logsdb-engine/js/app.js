// @ts-nocheck
// ── LogsDB Engine — App Entry Point ───────────────────────────────────
// Three-panel interactive experience:
//   1. Storage Explorer — byte-level chunk inspection
//   2. Logs Explorer — curated service health + insights
//   3. Query Builder — full query API exposed in UI

import { DATASET_PRESETS, generateLogs } from "./data-gen.js";
import { analyzeStore } from "./logs-model.js";
import {
  computeServiceDistribution,
  computeSeverityDistribution,
  createQueryState,
  executeQuery,
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
let _genStats = null;
const queryState = createQueryState();
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
  buttons.forEach((b) => {
    b.disabled = true;
  });
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

      _genStats = result.stats;
      const _genTime = performance.now() - t0;

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

      buttons.forEach((b) => {
        b.disabled = false;
      });
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
      tabBtns.forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
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

let _cachedChunks = null;

function renderStorageExplorer() {
  if (!store) return;

  const chunks = getChunkDetails(store);
  _cachedChunks = chunks;
  const services = getServiceBreakdown(store);

  // Service breakdown table with visual compression bars
  setHtml(
    "service-breakdown",
    `<table class="data-table" role="table">
      <thead><tr>
        <th>Service</th><th>Logs</th><th>Chunks</th><th>Bytes</th><th>B/log</th><th>Ratio</th><th>Efficiency</th>
      </tr></thead>
      <tbody>
        ${services
          .map(
            (s) => {
              const ratio = Number(s.compressionRatio);
              const barWidth = Math.min(100, ratio * 2);
              return `<tr>
          <td><code>${escapeHtml(s.name)}</code></td>
          <td>${formatNum(s.logs)}</td>
          <td>${s.chunks}</td>
          <td>${formatBytes(s.bytes)}</td>
          <td>${s.bytesPerLog}</td>
          <td>${s.compressionRatio}×</td>
          <td class="compression-bar-cell">
            <div class="compression-bar" style="--bar-width: ${barWidth}%">
              <div class="compression-bar-fill"></div>
            </div>
          </td>
        </tr>`;
            }
          )
          .join("")}
      </tbody>
    </table>`
  );

  // Chunk list with clickable cards
  const maxChunksShown = 60;
  const shownChunks = chunks.slice(0, maxChunksShown);
  setHtml(
    "chunk-list",
    `<div class="chunk-grid">
      ${shownChunks
        .map(
          (c, i) => {
            const sevRange = c.severityRange;
            const sevMin = sevRange ? sevRange.min : 0;
            const sevMax = sevRange ? sevRange.max : 0;
            return `
        <button type="button" class="chunk-card" data-index="${i}" aria-label="Inspect chunk ${c.chunkIndex} from ${c.service}">
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
          ${sevMin > 0 ? `<div class="chunk-severity-range">
            <span class="sev-pill mini" style="background: ${_sevColor(sevMin)}">${_sevLabel(sevMin)}</span>
            ${sevMin !== sevMax ? `<span class="sev-range-arrow">→</span><span class="sev-pill mini" style="background: ${_sevColor(sevMax)}">${_sevLabel(sevMax)}</span>` : ''}
          </div>` : ''}
          <div class="chunk-bar" style="--ratio: ${Math.min(1, Number(c.bytesPerLog) / 30)}">
            <div class="chunk-bar-fill"></div>
          </div>
        </button>`;
          }
        )
        .join("")}
    </div>
    ${chunks.length > maxChunksShown ? `<p class="muted">Showing ${maxChunksShown} of ${chunks.length} chunks</p>` : ""}`
  );

  // Wire up chunk click handlers
  const container = $("chunk-list");
  if (container) {
    container.addEventListener("click", (e) => {
      const card = e.target.closest(".chunk-card");
      if (!card) return;
      const idx = Number(card.dataset.index);
      if (idx >= 0 && idx < shownChunks.length) {
        showChunkDetail(shownChunks[idx]);
      }
    });
  }
}

function showChunkDetail(chunk) {
  const panel = $("chunk-detail");
  if (!panel) return;

  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const sevRange = chunk.severityRange;
  const timeMin = chunk.timeRange?.min;
  const timeMax = chunk.timeRange?.max;
  const timeStr = timeMin && timeMax
    ? `${new Date(Number(BigInt(timeMin) / 1_000_000n)).toISOString().slice(11, 23)} → ${new Date(Number(BigInt(timeMax) / 1_000_000n)).toISOString().slice(11, 23)}`
    : "unknown";

  // Build a visual byte breakdown
  const payloadPct = chunk.totalBytes > 0 ? ((chunk.payloadBytes / chunk.totalBytes) * 100) : 0;
  const headerPct = 100 - payloadPct;

  panel.innerHTML = `
    <div class="chunk-detail-header">
      <h4>Chunk #${chunk.chunkIndex} — <code>${escapeHtml(chunk.service)}</code></h4>
      <button type="button" class="chunk-detail-close" aria-label="Close detail">&times;</button>
    </div>

    <div class="chunk-detail-grid">
      <div class="chunk-detail-stat">
        <span class="chunk-detail-value">${formatNum(chunk.nLogs)}</span>
        <span class="chunk-detail-label">Records</span>
      </div>
      <div class="chunk-detail-stat">
        <span class="chunk-detail-value">${formatBytes(chunk.totalBytes)}</span>
        <span class="chunk-detail-label">Total Size</span>
      </div>
      <div class="chunk-detail-stat">
        <span class="chunk-detail-value">${chunk.bytesPerLog} B</span>
        <span class="chunk-detail-label">Per Log</span>
      </div>
      <div class="chunk-detail-stat">
        <span class="chunk-detail-value">${chunk.compressionRatio}×</span>
        <span class="chunk-detail-label">Compression</span>
      </div>
    </div>

    <div class="chunk-detail-section">
      <strong>Time Range</strong>
      <code>${timeStr}</code>
    </div>

    ${sevRange ? `<div class="chunk-detail-section">
      <strong>Severity Range</strong>
      <span class="sev-pill mini" style="background: ${_sevColor(sevRange.min)}">${_sevLabel(sevRange.min)}</span>
      ${sevRange.min !== sevRange.max ? `→ <span class="sev-pill mini" style="background: ${_sevColor(sevRange.max)}">${_sevLabel(sevRange.max)}</span>` : ''}
      <span class="muted-inline">(zone map enables severity-based chunk pruning)</span>
    </div>` : ''}

    <div class="chunk-detail-section">
      <strong>Byte Layout</strong>
      <div class="byte-layout-bar">
        <div class="byte-segment header-seg" style="width:${Math.max(2, headerPct)}%" title="Header: ~${formatBytes(chunk.headerBytes)}">
          ${headerPct > 15 ? `Header` : ''}
        </div>
        <div class="byte-segment payload-seg" style="width:${Math.max(2, payloadPct)}%" title="Payload: ${formatBytes(chunk.payloadBytes)}">
          ${payloadPct > 15 ? `Payload` : ''}
        </div>
      </div>
      <div class="byte-layout-legend">
        <span><span class="legend-dot header-dot"></span> Header ~${formatBytes(chunk.headerBytes)}</span>
        <span><span class="legend-dot payload-dot"></span> Payload ${formatBytes(chunk.payloadBytes)}</span>
      </div>
    </div>

    <div class="learn-callout learn-callout-sm">
      💡 <strong>Why so small?</strong> The TypedColumnarDrainPolicy extracts Drain templates
      from log bodies, then stores variable slots in typed columns (integers, UUIDs, timestamps).
      Repeated structure = massive compression.
    </div>
  `;

  panel.querySelector(".chunk-detail-close")?.addEventListener("click", () => {
    panel.hidden = true;
  });
}

function _sevColor(num) {
  if (num <= 4) return "#6b7280";
  if (num <= 8) return "#3b82f6";
  if (num <= 12) return "#10b981";
  if (num <= 16) return "#f59e0b";
  if (num <= 20) return "#ef4444";
  return "#dc2626";
}

function _sevLabel(num) {
  if (num <= 4) return "TRACE";
  if (num <= 8) return "DEBUG";
  if (num <= 12) return "INFO";
  if (num <= 16) return "WARN";
  if (num <= 20) return "ERROR";
  return "FATAL";
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

    // Severity timeline
    renderSeverityTimeline(analysis.timeline);

    // Service health cards with sparkline-style indicators
    setHtml(
      "service-health",
      analysis.services
        .map(
          (s) => {
            const errPct = Number(s.errorRate);
            const healthClass = errPct > 10 ? "service-critical" : errPct > 5 ? "service-unhealthy" : "";
            return `
        <div class="service-card ${healthClass}">
          <div class="service-name">${escapeHtml(s.name)}</div>
          <div class="service-stats">
            <span>${formatNum(s.logs)} logs</span>
            <span class="service-errors">${s.errors} errors (${s.errorRate}%)</span>
            <span>${formatBytes(s.bytes)}</span>
          </div>
          <div class="service-error-bar" style="--err-pct: ${Math.min(100, errPct)}%">
            <div class="service-error-bar-fill"></div>
          </div>
        </div>`;
          }
        )
        .join("")
    );

    // Error clusters with click-to-query
    if (analysis.errors.length > 0) {
      setHtml(
        "error-clusters",
        `<div class="error-list">
          ${analysis.errors
            .slice(0, 10)
            .map(
              (e) => `
            <button type="button" class="error-item error-item-btn" data-body="${escapeHtml(e.body.slice(0, 40))}" aria-label="Search for this error pattern">
              <div class="error-body"><code>${escapeHtml(e.body.slice(0, 120))}</code></div>
              <div class="error-meta">
                <span class="error-count">${e.count}× occurrences</span>
                <span class="error-services">${e.services.join(", ")}</span>
              </div>
            </button>`
            )
            .join("")}
        </div>`
      );

      // Wire click-to-query on error items
      const errContainer = $("error-clusters");
      if (errContainer) {
        errContainer.addEventListener("click", (e) => {
          const btn = e.target.closest(".error-item-btn");
          if (!btn) return;
          const body = btn.dataset.body;
          if (body) {
            queryState.bodyContains.enabled = true;
            queryState.bodyContains.value = body;
            queryState.severity.enabled = true;
            queryState.severity.min = "ERROR";
            currentTab = "query";
            document.querySelectorAll(".tab-btn").forEach((b) => {
              b.classList.toggle("active", b.dataset.tab === "query");
              b.setAttribute("aria-selected", b.dataset.tab === "query" ? "true" : "false");
            });
            renderCurrentTab();
            handleRunQuery();
          }
        });
      }
    } else {
      setHtml("error-clusters", "<p class='muted'>✅ No errors found.</p>");
    }

    // Template analysis
    if (analysis.templates.length > 0) {
      setHtml(
        "template-analysis",
        `<div class="template-list">
          ${analysis.templates
            .slice(0, 10)
            .map(
              (t) => `
            <div class="template-item">
              <code class="template-pattern">${escapeHtml(t.pattern.slice(0, 120))}</code>
              <span class="template-count">${t.count}×</span>
            </div>`
            )
            .join("")}
        </div>`
      );
    }
  });
}

function renderSeverityTimeline(timeline) {
  const container = $("severity-timeline");
  if (!container || !timeline || timeline.length === 0) {
    if (container) container.innerHTML = "<p class='muted'>Not enough data for timeline.</p>";
    return;
  }

  const maxTotal = Math.max(...timeline.map((b) => b.total));
  const barCount = timeline.length;

  container.innerHTML = `
    <div class="timeline-chart" role="img" aria-label="Severity distribution over time">
      ${timeline
        .map((bucket) => {
          const totalH = maxTotal > 0 ? (bucket.total / maxTotal) * 100 : 0;
          const errorH = maxTotal > 0 ? (bucket.errors / maxTotal) * 100 : 0;
          const warnH = maxTotal > 0 ? (bucket.warnings / maxTotal) * 100 : 0;
          const normalH = totalH - errorH - warnH;
          const time = new Date(bucket.timestamp).toISOString().slice(11, 19);
          return `
          <div class="timeline-bar-group" title="${time}: ${bucket.total} total, ${bucket.errors} errors, ${bucket.warnings} warnings" style="width: ${100 / barCount}%">
            <div class="timeline-bar" style="height: ${totalH}%">
              <div class="timeline-seg normal" style="height: ${normalH > 0 ? (normalH / totalH) * 100 : 0}%"></div>
              <div class="timeline-seg warn" style="height: ${warnH > 0 ? (warnH / totalH) * 100 : 0}%"></div>
              <div class="timeline-seg error" style="height: ${errorH > 0 ? (errorH / totalH) * 100 : 0}%"></div>
            </div>
          </div>`;
        })
        .join("")}
    </div>
    <div class="timeline-legend">
      <span><span class="legend-dot" style="background: var(--severity-info)"></span> Normal</span>
      <span><span class="legend-dot" style="background: var(--severity-warn)"></span> Warnings</span>
      <span><span class="legend-dot" style="background: var(--severity-error)"></span> Errors</span>
    </div>
  `;
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
          .map(
            (s) =>
              `<option value="${s}" ${queryState.severity.min === s ? "selected" : ""}>${s}</option>`
          )
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
       <button id="run-query-btn" class="stamp-fill demo-btn">Run Query</button>
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
  const _svcDist = computeServiceDistribution(records);

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
