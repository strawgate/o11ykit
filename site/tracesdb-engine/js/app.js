// @ts-nocheck
// ── TracesDB Engine Demo — App Entry Point ───────────────────────────

import { SCENARIOS } from "./data-gen.js";
import {
  $,
  escapeHtml,
  formatBytes,
  formatDurationMs,
  formatDurationNs,
  formatNum,
  hexFromBytes,
  shortTraceId,
} from "./utils.js";
import { renderLegend, renderWaterfall } from "./waterfall.js";

// ── State ─────────────────────────────────────────────────────────────

let store = null;
let queryModule = null;
let aggregateModule = null;
let selectedScenario = null;
let generatedData = null;
let _lastQueryResult = null;
let waterfallCleanup = null;

// ── Module Loading ────────────────────────────────────────────────────
// We dynamically import the tracesdb package to avoid bundler requirements.
// In production this would be an importmap or bundled.

async function loadTracesDB() {
  // Build the package path - adjust for your dev setup
  const base = "../../packages/o11ytracesdb/src/";
  const [engine, query, qbuilder, aggregate, types] = await Promise.all([
    import(`${base}engine.js`),
    import(`${base}query.js`),
    import(`${base}aggregate.js`),
    import(`${base}query-builder.js`),
    import(`${base}types.js`),
  ]);
  return { engine, query, aggregate, qbuilder, types };
}

// ── Initialization ────────────────────────────────────────────────────

async function init() {
  renderScenarios();
  setupEventListeners();

  try {
    const modules = await loadTracesDB();
    queryModule = modules.query;
    aggregateModule = modules.aggregate;
    window._tracesdb = modules; // Debug access
    $("#generateStatus").textContent = "✓ TracesDB loaded";
  } catch (err) {
    console.warn("Could not load tracesdb modules (expected in static serving):", err);
    $("#generateStatus").textContent = "⚠ Running in demo mode (mock data)";
    // Fall back to mock mode — still show UI
  }
}

// ── Scenario Grid ─────────────────────────────────────────────────────

function renderScenarios() {
  const grid = $("#scenarioGrid");
  grid.innerHTML = "";

  for (const scenario of SCENARIOS) {
    const card = document.createElement("div");
    card.className = "scenario-card";
    card.dataset.id = scenario.id;
    card.innerHTML = `
      <h3>${escapeHtml(scenario.name)}</h3>
      <p>${escapeHtml(scenario.description)}</p>
      <div class="scenario-meta">${escapeHtml(scenario.meta)}</div>
    `;
    card.addEventListener("click", () => selectScenario(scenario.id));
    grid.appendChild(card);
  }
}

function selectScenario(id) {
  selectedScenario = SCENARIOS.find((s) => s.id === id);
  document.querySelectorAll(".scenario-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.id === id);
  });
  $("#btnGenerate").disabled = false;
}

// ── Generate / Ingest ─────────────────────────────────────────────────

async function generateTraces() {
  if (!selectedScenario) return;

  const btn = $("#btnGenerate");
  const status = $("#generateStatus");
  btn.disabled = true;
  status.textContent = "Generating traces…";

  // Generate data
  const t0 = performance.now();
  generatedData = selectedScenario.generate();
  const genTime = performance.now() - t0;

  // Create store and ingest
  const t1 = performance.now();
  if (window._tracesdb) {
    const { engine } = window._tracesdb;
    store = new engine.TraceStore({ chunkSize: 128 });
    const resource = { attributes: [{ key: "service.name", value: "demo" }] };
    const scope = { name: "demo", version: "1.0" };
    store.append(resource, scope, generatedData.spans);
    store.flush();
  } else {
    // Mock store for static serving
    store = {
      _spans: generatedData.spans,
      stats() {
        return {
          sealedSpans: generatedData.spans.length,
          chunks: Math.ceil(generatedData.spans.length / 128),
          payloadBytes: generatedData.spans.length * 80,
        };
      },
    };
  }
  const ingestTime = performance.now() - t1;

  // Show stats
  const stats = store.stats();
  $("#statTraces").textContent = formatNum(generatedData.traceCount);
  $("#statSpans").textContent = formatNum(stats.sealedSpans);
  $("#statServices").textContent = String(generatedData.serviceCount);
  $("#statIngestTime").textContent = formatDurationMs(ingestTime);

  const rawSize = generatedData.spans.length * 120; // rough estimate
  const ratio = stats.payloadBytes > 0 ? `${(rawSize / stats.payloadBytes).toFixed(1)}×` : "—";
  $("#statCompression").textContent = ratio;

  $("#ingestStats").hidden = false;
  status.textContent = `Generated in ${formatDurationMs(genTime)} · Ingested in ${formatDurationMs(ingestTime)}`;
  btn.disabled = false;

  // Show subsequent sections
  showStorageExplorer(stats);
  showQuerySection();
}

// ── Storage Explorer ──────────────────────────────────────────────────

function showStorageExplorer(stats) {
  const section = $("#section-storage");
  section.hidden = false;

  const grid = $("#storageGrid");
  const items = [
    { label: "Total Chunks", value: formatNum(stats.chunks) },
    { label: "Total Spans", value: formatNum(stats.sealedSpans) },
    { label: "Stored Bytes", value: formatBytes(stats.payloadBytes) },
    {
      label: "Bytes/Span",
      value:
        stats.sealedSpans > 0 ? `${(stats.payloadBytes / stats.sealedSpans).toFixed(1)} B` : "—",
    },
    { label: "Bloom Filters", value: formatNum(stats.chunks) },
    { label: "Unique Services", value: String(generatedData.serviceCount) },
  ];

  grid.innerHTML = items
    .map(
      (item) => `
    <div class="storage-stat">
      <div class="stat-value">${item.value}</div>
      <div class="stat-label">${item.label}</div>
    </div>
  `
    )
    .join("");
}

// ── Query Section ─────────────────────────────────────────────────────

function showQuerySection() {
  const section = $("#section-query");
  section.hidden = false;
  $("#btnQuery").disabled = false;

  // Populate service dropdown
  const sel = $("#qService");
  sel.innerHTML = '<option value="">Any</option>';
  for (const svc of generatedData.serviceNames) {
    sel.innerHTML += `<option value="${escapeHtml(svc)}">${escapeHtml(svc)}</option>`;
  }
}

function runQuery() {
  if (!generatedData) {
    const status = $("#queryStatus");
    status.textContent = "⚠ Generate data first";
    status.className = "query-status error";
    return;
  }
  const status = $("#queryStatus");
  const t0 = performance.now();

  // Build query opts
  const service = $("#qService").value || undefined;
  const spanNameRaw = $("#qSpanName").value || undefined;
  const statusCode = $("#qStatus").value ? Number($("#qStatus").value) : undefined;
  const durMin = $("#qDurMin").value
    ? BigInt(Math.round(Number($("#qDurMin").value) * 1_000_000))
    : undefined;
  const durMax = $("#qDurMax").value
    ? BigInt(Math.round(Number($("#qDurMax").value) * 1_000_000))
    : undefined;
  const sortBy = $("#qSort").value;
  const sortOrder = $("#qSortDir").value;
  const limit = Number($("#qLimit").value) || 50;

  // Attribute predicate
  const attrKey = $("#qAttrKey").value;
  const attrOp = $("#qAttrOp").value;
  const attrVal = $("#qAttrVal").value;
  const attributePredicates = [];
  if (attrKey) {
    const pred = { key: attrKey, op: attrOp };
    if (attrOp !== "exists" && attrOp !== "notExists") {
      // Coerce to number if the value is numeric (for comparison operators)
      const numVal = Number(attrVal);
      pred.value = !Number.isNaN(numVal) && attrVal.trim() !== "" ? numVal : attrVal;
    }
    attributePredicates.push(pred);
  }

  let spanNameRegex;
  if (spanNameRaw) {
    try {
      spanNameRegex = new RegExp(spanNameRaw);
    } catch {
      status.textContent = "⚠ Invalid regex in span name filter";
      return;
    }
  }

  const opts = {
    ...(service ? { serviceName: service } : {}),
    ...(spanNameRegex ? { spanNameRegex } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(durMin ? { minDurationNanos: durMin } : {}),
    ...(durMax ? { maxDurationNanos: durMax } : {}),
    ...(attributePredicates.length > 0 ? { attributePredicates } : {}),
    sortBy,
    sortOrder,
    limit,
  };

  let result;
  if (queryModule && store && !store._spans) {
    result = queryModule.queryTraces(store, opts);
  } else {
    // Mock query for static mode
    result = mockQuery(opts);
  }

  const queryTime = performance.now() - t0;
  _lastQueryResult = result;

  status.textContent = `${result.traces.length} traces found in ${formatDurationMs(queryTime)}`;
  showResults(result, queryTime);
}

function mockQuery(opts) {
  // Simple mock: filter raw spans, group by traceId
  const spans = generatedData.spans;
  const traceMap = new Map();
  for (const s of spans) {
    const tid = hexFromBytes(s.traceId);
    if (!traceMap.has(tid)) traceMap.set(tid, []);
    traceMap.get(tid).push(s);
  }

  const traces = [];
  for (const [_tid, tspans] of traceMap) {
    const root = tspans.find((s) => !s.parentSpanId) || tspans[0];
    const svcAttr = root.attributes?.find((a) => a.key === "service.name");

    // Basic filters
    if (opts.serviceName) {
      const hasService = tspans.some((s) =>
        s.attributes?.some((a) => a.key === "service.name" && a.value === opts.serviceName)
      );
      if (!hasService) continue;
    }
    if (opts.statusCode !== undefined) {
      const hasStatus = tspans.some((s) => s.statusCode === opts.statusCode);
      if (!hasStatus) continue;
    }

    const startNs = tspans.reduce(
      (m, s) => (s.startTimeUnixNano < m ? s.startTimeUnixNano : m),
      tspans[0].startTimeUnixNano
    );
    const endNs = tspans.reduce(
      (m, s) => (s.endTimeUnixNano > m ? s.endTimeUnixNano : m),
      tspans[0].endTimeUnixNano
    );

    traces.push({
      traceId: tspans[0].traceId,
      spans: tspans,
      rootSpan: root,
      durationNanos: endNs - startNs,
      spanCount: tspans.length,
      rootServiceName: svcAttr?.value || "unknown",
      rootSpanName: root.name,
      hasError: tspans.some((s) => s.statusCode === 2),
    });
  }

  // Sort
  if (opts.sortBy === "duration") {
    traces.sort((a, b) =>
      opts.sortOrder === "asc"
        ? Number(a.durationNanos - b.durationNanos)
        : Number(b.durationNanos - a.durationNanos)
    );
  } else if (opts.sortBy === "spanCount") {
    traces.sort((a, b) =>
      opts.sortOrder === "asc" ? a.spanCount - b.spanCount : b.spanCount - a.spanCount
    );
  }

  return { traces: traces.slice(0, opts.limit || 50), totalTraces: traces.length, queryTimeMs: 0 };
}

// ── Results Display ───────────────────────────────────────────────────

function showResults(result, queryTimeMs) {
  const section = $("#section-results");
  section.hidden = false;
  $("#section-waterfall").hidden = false;

  // Stats
  const statsEl = $("#queryStats");
  statsEl.innerHTML = `
    <div class="stat-badge"><span class="stat-value">${result.traces.length}</span><span class="stat-label">Traces</span></div>
    <div class="stat-badge"><span class="stat-value">${formatDurationMs(queryTimeMs)}</span><span class="stat-label">Query Time</span></div>
    <div class="stat-badge"><span class="stat-value">${result.totalTraces || result.traces.length}</span><span class="stat-label">Total Matches</span></div>
  `;

  // Aggregation
  if (aggregateModule && result.traces.length > 0) {
    try {
      const agg = aggregateModule.aggregateTraces(result.traces, [
        { fn: "count" },
        { fn: "avg", field: "duration" },
        { fn: "p50", field: "duration" },
        { fn: "p99", field: "duration" },
      ]);
      const aggGrid = $("#aggGrid");
      aggGrid.hidden = false;
      aggGrid.innerHTML = agg.results
        .map(
          (r) => `
        <div class="agg-card">
          <div class="agg-value">${r.fn === "count" ? r.value : formatDurationNs(BigInt(Math.round(r.value)))}</div>
          <div class="agg-label">${r.fn}${r.field ? `(${r.field})` : ""}</div>
        </div>
      `
        )
        .join("");
    } catch (_e) {
      // aggregation not available in mock mode
    }
  }

  // Results table
  const tbody = $("#resultsBody");
  tbody.innerHTML = "";
  for (let i = 0; i < result.traces.length; i++) {
    const trace = result.traces[i];
    const hasError = trace.hasError || trace.spans?.some((s) => s.statusCode === 2);
    const rootSvc =
      trace.rootServiceName ||
      trace.rootSpan?.attributes?.find((a) => a.key === "service.name")?.value ||
      "—";
    const rootOp = trace.rootSpanName || trace.rootSpan?.name || "—";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="trace-id-cell">${shortTraceId(trace.traceId)}</td>
      <td>${escapeHtml(rootSvc)}</td>
      <td>${escapeHtml(rootOp)}</td>
      <td>${trace.spanCount || trace.spans?.length || 0}</td>
      <td class="duration-cell">${formatDurationNs(trace.durationNanos)}</td>
      <td><span class="status-dot ${hasError ? "error" : "ok"}"></span>${hasError ? "Error" : "OK"}</td>
    `;
    tr.addEventListener("click", () => showWaterfall(trace));
    tbody.appendChild(tr);
  }
}

// ── Waterfall ─────────────────────────────────────────────────────────

function showWaterfall(trace) {
  const container = $("#waterfallContainer");
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
    const svc = s.attributes?.find((a) => a.key === "service.name")?.value;
    if (svc) services.add(svc);
  }
  renderLegend($("#waterfallLegend"), [...services]);

  // Scroll into view
  $("#section-waterfall").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#waterfallIntro").textContent =
    `Trace ${shortTraceId(trace.traceId)} · ${trace.spans.length} spans · ${formatDurationNs(trace.durationNanos)}`;
}

function showSpanDetail(span) {
  const detail = $("#spanDetail");
  detail.classList.add("visible");

  const svc = span.attributes?.find((a) => a.key === "service.name")?.value || "unknown";
  const attrs = (span.attributes || []).filter((a) => a.key !== "service.name");

  detail.innerHTML = `
    <h4>${escapeHtml(span.name)}</h4>
    <table>
      <tr><td>Service</td><td>${escapeHtml(svc)}</td></tr>
      <tr><td>Span ID</td><td style="font-family:var(--mono);font-size:12px">${hexFromBytes(span.spanId)}</td></tr>
      <tr><td>Duration</td><td>${formatDurationNs(span.durationNanos)}</td></tr>
      <tr><td>Status</td><td><span class="status-dot ${span.statusCode === 2 ? "error" : "ok"}"></span>${span.statusCode === 2 ? "Error" : span.statusCode === 1 ? "OK" : "Unset"}</td></tr>
      <tr><td>Kind</td><td>${["Unspecified", "Internal", "Server", "Client", "Producer", "Consumer"][span.kind] || span.kind}</td></tr>
      ${attrs.map((a) => `<tr><td>${escapeHtml(a.key)}</td><td>${escapeHtml(String(a.value))}</td></tr>`).join("")}
      ${span.events?.length ? `<tr><td>Events</td><td>${span.events.map((e) => escapeHtml(e.name)).join(", ")}</td></tr>` : ""}
    </table>
  `;
}

// ── Event Listeners ───────────────────────────────────────────────────

function setupEventListeners() {
  $("#btnGenerate").addEventListener("click", generateTraces);
  $("#btnQuery").addEventListener("click", runQuery);

  // Enter key in query fields triggers query
  const queryInputs = document.querySelectorAll("#queryPanel input, #queryPanel select");
  for (const input of queryInputs) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runQuery();
    });
  }
}

// ── Boot ──────────────────────────────────────────────────────────────
init();
