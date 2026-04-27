// @ts-nocheck
// ── TracesDB Engine Demo — App Orchestrator ─────────────────────────
// Single entry point. Manages scenario loading, progressive section reveal,
// fork routing, tab nav, and wires all explorer modules together.

import {
  estimateScenarioBytes,
  estimateScenarioSpans,
  generateScenarioData,
  SCENARIOS,
} from "./data-gen.js";
import { initQueryBuilder } from "./query-builder.js";
import { buildStorageExplorer } from "./storage-explorer.js";
import { buildTracesExplorer } from "./traces-explorer.js";
import {
  $,
  el,
  escapeHtml,
  formatBytes,
  formatDurationMs,
  formatDurationNs,
  formatNum,
  hideSection,
  shortTraceId,
  showSection,
  spanServiceName,
} from "./utils.js";
import { renderLegend, renderWaterfall } from "./waterfall.js";

// ── State ─────────────────────────────────────────────────────────────

let _selectedScenario = null;
let generatedData = null;
let waterfallCleanup = null;
let _storagePopulated = false;
let _tracesPopulated = false;
let _queryPopulated = false;

// ── Initialization ────────────────────────────────────────────────────

function init() {
  renderScenarioCards();
  setupForkCards();
  setupExploreNav();
  setupHeroActions();
}

// ── Scenario Cards ────────────────────────────────────────────────────

function renderScenarioCards() {
  const grid = $("#scenarioGrid");
  if (!grid) return;
  grid.innerHTML = "";

  for (const scenario of SCENARIOS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "scenario-card";
    card.dataset.scenarioId = scenario.id;
    card.setAttribute("aria-pressed", "false");

    const spanCount = estimateScenarioSpans(scenario);
    const rawBytes = estimateScenarioBytes(scenario);

    card.innerHTML = `
      <span class="sc-selected-badge">✓ Selected</span>
      <div class="sc-emoji">${scenario.emoji}</div>
      <div class="sc-name">${escapeHtml(scenario.name)}</div>
      <div class="sc-desc">${escapeHtml(scenario.description)}</div>
      ${
        scenario.sampleOps?.length
          ? `
        <div class="sc-meta-label">Sample Operations:</div>
        <div class="sc-meta">
          ${scenario.sampleOps.map((op) => `<span class="sc-metric">${escapeHtml(op)}</span>`).join("")}
        </div>
      `
          : ""
      }
      <div class="sc-stats">${scenario.id !== "custom" ? `~${formatNum(spanCount)} spans · ${scenario.meta.services} services · ~${formatBytes(rawBytes)}` : "User-configured"}</div>
      <div class="sc-loading-indicator"><span class="sc-spinner"></span><span>Generating…</span></div>
      <div class="sc-done-stats"></div>
    `;

    card.addEventListener("click", () => {
      if (scenario.id === "custom") {
        toggleCustomGenerator();
      } else {
        selectScenario(scenario.id);
      }
    });

    grid.appendChild(card);
  }
}

function selectScenario(id) {
  _selectedScenario = SCENARIOS.find((s) => s.id === id);
  document.querySelectorAll(".scenario-card").forEach((card) => {
    const isTarget = card.dataset.scenarioId === id;
    card.classList.toggle("active", isTarget);
    card.setAttribute("aria-pressed", isTarget ? "true" : "false");
  });
  generateTraces(id);
}

// ── Custom Generator ──────────────────────────────────────────────────

function toggleCustomGenerator() {
  const gen = $("#customGeneratorInline");
  if (!gen) return;
  gen.hidden = !gen.hidden;
  if (!gen.hidden) {
    gen.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setupCustomControls();
  }
}

function setupCustomControls() {
  const servicesSlider = $("#customServices");
  const tracesSlider = $("#customTraces");
  const depthSlider = $("#customDepth");
  const errorSlider = $("#customErrorRate");

  function updateLabels() {
    const sv = $("#customServicesValue");
    const tv = $("#customTracesValue");
    const dv = $("#customDepthValue");
    const ev = $("#customErrorValue");
    if (sv) sv.textContent = servicesSlider?.value || "6";
    if (tv) tv.textContent = formatNum(Number(tracesSlider?.value || 1000));
    if (dv) dv.textContent = depthSlider?.value || "3";
    if (ev) ev.textContent = `${Number(errorSlider?.value || 5)}%`;
  }

  [servicesSlider, tracesSlider, depthSlider, errorSlider].forEach((s) => {
    if (s) s.addEventListener("input", updateLabels);
  });
  updateLabels();

  const genBtn = $("#customGenerate");
  if (genBtn) {
    genBtn.addEventListener("click", () => {
      const services = Number(servicesSlider?.value || 6);
      const traces = Number(tracesSlider?.value || 1000);
      const depth = Number(depthSlider?.value || 3);
      const errorRate = Number(errorSlider?.value || 5) / 100;
      const width = Math.min(6, Math.max(2, Math.ceil(traces / 200)));
      generateTraces("custom", {
        services,
        targetSpans: traces * estimateSpansPerTrace(depth, width),
        depth,
        width,
        errorRate,
      });
    });
  }
}

function estimateSpansPerTrace(depth, width) {
  let total = 1;
  let levelSize = 1;
  for (let d = 0; d < depth; d++) {
    levelSize = Math.ceil(levelSize * width * 0.7);
    total += levelSize;
  }
  return total;
}

// ── Generate Traces ───────────────────────────────────────────────────

async function generateTraces(scenarioId, overrides = {}) {
  // Reset downstream sections
  _storagePopulated = false;
  _tracesPopulated = false;
  _queryPopulated = false;
  hideSection("section-fork");
  hideSection("section-storage");
  hideSection("section-traces");
  hideSection("section-query");
  hideSection("section-waterfall");

  // Mark card loading
  const card = document.querySelector(`.scenario-card[data-scenario-id="${scenarioId}"]`);
  document.querySelectorAll(".scenario-card").forEach((c) => {
    c.classList.remove("loading", "loaded", "active");
  });
  if (card) card.classList.add("loading");

  // Show progress
  const progress = $("#progressContainer");
  const progressFill = $("#progressFill");
  const progressText = $("#progressText");
  if (progress) progress.classList.add("active");

  const t0 = performance.now();

  try {
    generatedData = await generateScenarioData(scenarioId, overrides, (p) => {
      if (progressFill) progressFill.style.width = `${(p.current / p.total) * 100}%`;
      if (progressText)
        progressText.textContent = `${formatNum(p.spans)} spans (${p.current}/${p.total} traces)`;
    });
  } catch (err) {
    console.error("Generation failed:", err);
    if (card) card.classList.remove("loading");
    if (progress) progress.classList.remove("active");
    return;
  }

  const genTime = performance.now() - t0;

  // Update card state
  if (card) {
    card.classList.remove("loading");
    card.classList.add("loaded", "active");
    const doneStats = card.querySelector(".sc-done-stats");
    if (doneStats) {
      doneStats.textContent = `✓ ${formatNum(generatedData.spans.length)} spans in ${formatDurationMs(genTime)}`;
    }
  }

  // Hide progress
  if (progress) progress.classList.remove("active");

  // Show ingest stats
  showIngestStats(genTime);

  // Reveal fork
  showSection("section-fork", true);
}

function showIngestStats(genTime) {
  const container = $("#ingestStats");
  if (!container || !generatedData) return;
  container.hidden = false;

  const rawBytes = generatedData.spans.length * 280;
  const compressedBytes = Math.round(rawBytes * 0.35);
  const ratio = compressedBytes > 0 ? (rawBytes / compressedBytes).toFixed(1) : "—";

  container.innerHTML = "";
  const items = [
    { label: "Traces", value: formatNum(generatedData.traceCount) },
    { label: "Spans", value: formatNum(generatedData.spans.length) },
    { label: "Services", value: String(generatedData.serviceCount) },
    { label: "Generation", value: formatDurationMs(genTime) },
    { label: "Raw Size", value: formatBytes(rawBytes) },
    { label: "Compression", value: `${ratio}×` },
  ];
  for (const item of items) {
    container.appendChild(
      el(
        "div",
        { className: "stat-badge" },
        el("span", { className: "stat-value" }, item.value),
        el("span", { className: "stat-label" }, item.label)
      )
    );
  }
}

// ── Fork Cards ────────────────────────────────────────────────────────

function setupForkCards() {
  document.querySelectorAll(".fork-card").forEach((card) => {
    card.addEventListener("click", () => {
      const target = card.dataset.target;
      if (target === "section-storage") revealStorage(true);
      else if (target === "section-traces") revealTraces(true);
      else if (target === "section-query") revealQuery(true);
    });
  });
}

// ── Explore Nav (tab bar) ────────────────────────────────────────────

function setupExploreNav() {
  document.querySelectorAll(".explore-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      if (target === "section-storage") revealStorage();
      else if (target === "section-traces") revealTraces();
      else if (target === "section-query") revealQuery();
    });
  });
}

function updateExploreNav(activeId) {
  document.querySelectorAll(".explore-nav-btn").forEach((btn) => {
    const isActive = btn.dataset.target === activeId;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

// ── Section Reveal Functions ──────────────────────────────────────────

function revealStorage(scroll = false) {
  if (!generatedData) return;
  if (!_storagePopulated) {
    _storagePopulated = true;
    buildStorageExplorer(generatedData.spans, generatedData.serviceNames);
  }
  hideSection("section-traces");
  hideSection("section-query");
  hideSection("section-waterfall");
  showSection("section-storage", scroll);
  updateExploreNav("section-storage");
}

function revealTraces(scroll = false) {
  if (!generatedData) return;
  if (!_tracesPopulated) {
    _tracesPopulated = true;
    buildTracesExplorer(generatedData.spans, generatedData.serviceNames, {
      onTraceSelect: showWaterfall,
    });
  }
  hideSection("section-storage");
  hideSection("section-query");
  showSection("section-traces", scroll);
  showSection("section-waterfall");
  updateExploreNav("section-traces");
}

function revealQuery(scroll = false) {
  if (!generatedData) return;
  if (!_queryPopulated) {
    _queryPopulated = true;
    initQueryBuilder(generatedData.spans, generatedData.serviceNames, {
      onTraceSelect: showWaterfall,
    });
  }
  hideSection("section-storage");
  hideSection("section-traces");
  showSection("section-query", scroll);
  showSection("section-waterfall");
  updateExploreNav("section-query");
}

// ── Waterfall ─────────────────────────────────────────────────────────

function showWaterfall(trace) {
  if (!trace?.spans) return;
  showSection("section-waterfall");

  const container = $("#waterfallContainer");
  if (!container) return;
  container.innerHTML = "";

  const canvas = document.createElement("canvas");
  container.appendChild(canvas);

  if (waterfallCleanup) waterfallCleanup();

  const { cleanup } = renderWaterfall(canvas, trace, {
    onSpanClick(span) {
      showSpanDetail(span);
    },
  });
  waterfallCleanup = cleanup;

  // Legend
  const services = new Set();
  for (const s of trace.spans) {
    const svc = spanServiceName(s);
    if (svc !== "unknown") services.add(svc);
  }
  renderLegend($("#waterfallLegend"), [...services]);

  // Header
  const intro = $("#waterfallIntro");
  if (intro) {
    const dur = trace.duration
      ? formatDurationNs(trace.duration)
      : trace.spans[0]?.durationNanos
        ? formatDurationNs(trace.spans[0].durationNanos)
        : "";
    intro.textContent = `Trace ${shortTraceId(trace.traceId)} · ${trace.spans.length} spans${dur ? ` · ${dur}` : ""}`;
  }

  $("#section-waterfall").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showSpanDetail(span) {
  const detail = $("#spanDetail");
  if (!detail) return;
  detail.classList.add("visible");

  const svc = spanServiceName(span);
  const attrs = (span.attributes || []).filter((a) => a.key !== "service.name");
  const kinds = ["Unspecified", "Internal", "Server", "Client", "Producer", "Consumer"];

  let html = `<h4>${escapeHtml(span.name)}</h4><table>`;
  html += `<tr><td>Service</td><td>${escapeHtml(svc)}</td></tr>`;
  html += `<tr><td>Span ID</td><td style="font-family:var(--mono);font-size:12px">${escapeHtml(String(span.spanId))}</td></tr>`;

  const dur = span.durationNanos || span.endTimeUnixNano - span.startTimeUnixNano;
  html += `<tr><td>Duration</td><td>${formatDurationNs(dur)}</td></tr>`;
  html += `<tr><td>Status</td><td><span class="status-dot ${span.statusCode === 2 ? "error" : "ok"}"></span>${span.statusCode === 2 ? "Error" : span.statusCode === 1 ? "OK" : "Unset"}</td></tr>`;
  html += `<tr><td>Kind</td><td>${kinds[span.kind] || span.kind}</td></tr>`;

  for (const a of attrs) {
    html += `<tr><td>${escapeHtml(a.key)}</td><td>${escapeHtml(String(a.value))}</td></tr>`;
  }
  html += "</table>";

  // Events
  if (span.events?.length) {
    html += '<div class="span-events"><strong>Events</strong>';
    for (const evt of span.events) {
      html += `<div class="event-row">`;
      html += `<span class="event-name">${escapeHtml(evt.name)}</span>`;
      if (evt.attributes) {
        for (const a of evt.attributes) {
          if (a.key === "exception.stacktrace") {
            html += `<div class="stack-trace">${escapeHtml(String(a.value))}</div>`;
          } else {
            html += `<div style="font-size:12px;color:var(--dark-muted)">${escapeHtml(a.key)}: ${escapeHtml(String(a.value))}</div>`;
          }
        }
      }
      html += "</div>";
    }
    html += "</div>";
  }

  detail.innerHTML = html;
}

// ── Hero Actions ──────────────────────────────────────────────────────

function setupHeroActions() {
  const launchBtn = $("#heroLaunch");
  if (launchBtn) {
    launchBtn.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("section-dataset")?.scrollIntoView({ behavior: "smooth" });
    });
  }
}

// ── Boot ──────────────────────────────────────────────────────────────
init();
