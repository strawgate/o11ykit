// @ts-nocheck
// ── Query Builder — UI controller ───────────────────────────────────

import { aggregateResults, buildQueryPreview, executeQuery } from "./query-model.js";
import { $, debounce, el, formatDurationNs, formatNum, shortTraceId } from "./utils.js";

let store = null;
let serviceNames = [];
let onTraceSelect = null;
let currentMode = "traces";

/**
 * Initialize the query builder.
 */
export function initQueryBuilder(chunkStore, svcNames, callbacks = {}) {
  store = chunkStore;
  serviceNames = svcNames;
  onTraceSelect = callbacks.onTraceSelect || null;

  populateServiceDropdown();
  setupAttrFilters();
  setupStructuralPredicates();
  setupTraceIntrinsics();
  setupAggToggle();
  setupRecipes();
  bindQueryEvents();
  updatePreview();
}

export function updateQueryData(chunkStore, svcNames) {
  store = chunkStore;
  serviceNames = svcNames;
  populateServiceDropdown();
}

// ── Populate Dropdowns ───────────────────────────────────────────────

function populateServiceDropdown() {
  const selects = [$("#qService"), $("#qStructService"), $("#qIntrinsicRootService")];
  for (const sel of selects) {
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = '<option value="">Any</option>';
    for (const name of serviceNames) {
      sel.appendChild(el("option", { value: name }, name));
    }
    if (current) sel.value = current;
  }
}

// ── Attribute Filters ────────────────────────────────────────────────

function setupAttrFilters() {
  const addBtn = $("#addAttrFilter");
  if (!addBtn) return;
  addBtn.addEventListener("click", () => addAttrFilterRow());
}

function addAttrFilterRow() {
  const list = $("#attrFilterList");
  if (!list) return;

  const row = el("div", { className: "attr-filter-row" });
  row.appendChild(
    el("input", { type: "text", placeholder: "key (e.g. http.method)", className: "attr-key" })
  );
  row.appendChild(createSelect(["=", "!=", "~", ">", "<"], "attr-op"));
  row.appendChild(el("input", { type: "text", placeholder: "value", className: "attr-val" }));

  const removeBtn = el("button", { type: "button", className: "remove-attr-btn" }, "×");
  removeBtn.addEventListener("click", () => {
    row.remove();
    updatePreview();
  });
  row.appendChild(removeBtn);

  list.appendChild(row);

  row.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("input", debouncedPreview);
  });
}

function createSelect(options, className) {
  const sel = el("select", { className });
  for (const opt of options) {
    sel.appendChild(el("option", { value: opt }, opt));
  }
  return sel;
}

function getAttrFilters() {
  const rows = document.querySelectorAll("#attrFilterList .attr-filter-row");
  const filters = [];
  for (const row of rows) {
    const key = row.querySelector(".attr-key")?.value || "";
    const op = row.querySelector(".attr-op")?.value || "=";
    const val = row.querySelector(".attr-val")?.value || "";
    if (key) filters.push({ key, op, value: val });
  }
  return filters;
}

// ── Structural Predicates ────────────────────────────────────────────

function setupStructuralPredicates() {
  const typeSelect = $("#qStructType");
  if (!typeSelect) return;
  typeSelect.addEventListener("change", () => {
    const panel = $("#structuralPredicateFields");
    if (panel) panel.style.display = typeSelect.value === "none" ? "none" : "";
    updatePreview();
  });
}

function getStructuralPredicate() {
  const type = $("#qStructType")?.value || "none";
  if (type === "none") return null;
  return {
    type,
    service: $("#qStructService")?.value || "",
    spanName: $("#qStructSpanName")?.value || "",
    status: Number($("#qStructStatus")?.value ?? -1),
  };
}

// ── Trace Intrinsics ─────────────────────────────────────────────────

function setupTraceIntrinsics() {
  const fields = ["#qIntrinsicRootService", "#qIntrinsicRootSpan", "#qIntrinsicMinDuration"];
  for (const sel of fields) {
    const elem = $(sel);
    if (elem) elem.addEventListener("input", debouncedPreview);
  }
}

function getTraceIntrinsics() {
  const rootService = $("#qIntrinsicRootService")?.value || "";
  const rootSpanName = $("#qIntrinsicRootSpan")?.value || "";
  const minDur = Number($("#qIntrinsicMinDuration")?.value) || 0;
  if (!rootService && !rootSpanName && !minDur) return null;
  return { rootService, rootSpanName, minTraceDurationMs: minDur };
}

// ── Aggregation ──────────────────────────────────────────────────────

function setupAggToggle() {
  const btns = document.querySelectorAll(".agg-toggle-btn");
  btns.forEach((btn) => {
    btn.addEventListener("click", () => {
      btns.forEach((b) => {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      currentMode = btn.dataset.mode || "traces";
      const aggConfig = $("#aggConfig");
      if (aggConfig) aggConfig.classList.toggle("active", currentMode === "aggregate");
    });
  });
}

function getAggOpts() {
  if (currentMode !== "aggregate") return null;
  return {
    fn: $("#aggFn")?.value || "count",
    field: $("#aggField")?.value || "duration",
    groupBy: $("#aggGroupBy")?.value || null,
  };
}

// ── Quick Query Recipes ───────────────────────────────────────────────

const RECIPES = {
  errors: { statusCode: 2, sortBy: "duration", sortDir: "desc" },
  slow: { minDurationMs: 1000, sortBy: "duration", sortDir: "desc" },
  "root-errors": {
    statusCode: 2,
    traceIntrinsics: { minTraceDurationMs: 0 },
    sortBy: "duration",
    sortDir: "desc",
  },
  "long-chains": { minDurationMs: 500, sortBy: "spanCount", sortDir: "desc", limit: 50 },
  p99: {
    sortBy: "duration",
    sortDir: "desc",
    limit: 50,
    _aggregate: { fn: "p99", field: "duration", groupBy: "rootService" },
  },
};

function setupRecipes() {
  const container = $("#queryRecipes");
  if (!container) return;
  container.querySelectorAll(".recipe-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const recipe = RECIPES[btn.dataset.recipe];
      if (!recipe) return;
      applyRecipe(recipe);
      btn.classList.add("active");
      setTimeout(() => btn.classList.remove("active"), 600);
    });
  });
}

function applyRecipe(recipe) {
  // Reset form
  if ($("#qService")) $("#qService").value = recipe.service || "";
  if ($("#qSpanName")) $("#qSpanName").value = recipe.spanName || "";
  if ($("#qStatus")) $("#qStatus").value = String(recipe.statusCode ?? -1);
  if ($("#qKind")) $("#qKind").value = String(recipe.spanKind ?? -1);
  if ($("#qMinDuration")) $("#qMinDuration").value = recipe.minDurationMs || "";
  if ($("#qMaxDuration")) $("#qMaxDuration").value = recipe.maxDurationMs || "";
  if ($("#qSortBy")) $("#qSortBy").value = recipe.sortBy || "duration";
  if ($("#qSortDir")) $("#qSortDir").value = recipe.sortDir || "desc";
  if ($("#qLimit")) $("#qLimit").value = String(recipe.limit || 100);

  // Handle aggregation mode
  if (recipe._aggregate) {
    currentMode = "aggregate";
    document.querySelectorAll(".agg-toggle-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === "aggregate");
    });
    const aggConfig = $("#aggConfig");
    if (aggConfig) aggConfig.classList.add("active");
    if ($("#aggFn")) $("#aggFn").value = recipe._aggregate.fn;
    if ($("#aggField")) $("#aggField").value = recipe._aggregate.field;
    if ($("#aggGroupBy")) $("#aggGroupBy").value = recipe._aggregate.groupBy || "";
  } else {
    currentMode = "traces";
    document.querySelectorAll(".agg-toggle-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === "traces");
    });
    const aggConfig = $("#aggConfig");
    if (aggConfig) aggConfig.classList.remove("active");
  }

  updatePreview();
  runQuery();
}

// ── Build Query Opts ─────────────────────────────────────────────────

function buildOpts() {
  return {
    service: $("#qService")?.value || "",
    spanName: $("#qSpanName")?.value || "",
    statusCode: Number($("#qStatus")?.value ?? -1),
    spanKind: Number($("#qKind")?.value ?? -1),
    minDurationMs: Number($("#qMinDuration")?.value) || 0,
    maxDurationMs: Number($("#qMaxDuration")?.value) || 0,
    attrFilters: getAttrFilters(),
    structural: getStructuralPredicate(),
    traceIntrinsics: getTraceIntrinsics(),
    sortBy: $("#qSortBy")?.value || "duration",
    sortDir: $("#qSortDir")?.value || "desc",
    limit: Number($("#qLimit")?.value) || 100,
  };
}

// ── Query Preview ────────────────────────────────────────────────────

const debouncedPreview = debounce(() => updatePreview(), 150);

function updatePreview() {
  const code = $("#queryPreviewCode");
  if (!code) return;
  const opts = buildOpts();
  code.innerHTML = buildQueryPreview(opts, serviceNames);
}

// ── Execute Query ────────────────────────────────────────────────────

function runQuery() {
  const panel = $("#queryResultsPanel");
  if (panel) {
    panel.innerHTML = '<div class="query-loading">Querying…</div>';
  }
  // Yield to browser to paint loading state before heavy computation
  setTimeout(() => {
    try {
      const opts = buildOpts();
      const result = executeQuery(store, opts);

      const aggOpts = getAggOpts();
      if (aggOpts) {
        const aggResult = aggregateResults(result.traces, aggOpts);
        showAggResults(aggResult, result);
      } else {
        showTraceResults(result);
      }
    } catch (err) {
      console.error("Query execution failed:", err);
      if (panel) {
        panel.innerHTML = `<div class="query-error">Query failed: ${err.message}</div>`;
      }
    }
  }, 0);
}

function showTraceResults(result) {
  const panel = $("#queryResultsPanel");
  if (!panel) return;
  panel.innerHTML = "";

  // Stats
  const pruneInfo =
    result.chunksPruned !== undefined
      ? `, ${result.chunksScanned} chunks scanned, ${result.chunksPruned} pruned`
      : "";
  const stats = el(
    "div",
    { className: "query-stats" },
    el("span", {}, `${result.traceCount} traces`),
    el("span", {}, `${formatNum(result.matchedSpans)} matched spans`),
    el("span", {}, `${result.elapsed.toFixed(1)}ms${pruneInfo}`)
  );
  panel.appendChild(stats);

  if (result.traces.length === 0) {
    panel.appendChild(
      el("p", { style: { color: "var(--ink-muted)" } }, "No matching traces found.")
    );
    return;
  }

  // Results table
  const table = el("table", { className: "results-table" });
  const thead = el(
    "thead",
    {},
    el(
      "tr",
      {},
      el("th", {}, "Trace ID"),
      el("th", {}, "Root Service"),
      el("th", {}, "Root Span"),
      el("th", {}, "Spans"),
      el("th", {}, "Duration"),
      el("th", {}, "Status")
    )
  );
  table.appendChild(thead);

  const tbody = el("tbody", {});
  for (const trace of result.traces) {
    const statusClass = trace.hasError ? "error" : "ok";
    const row = el(
      "tr",
      {},
      el("td", { className: "trace-id-cell" }, shortTraceId(trace.traceId)),
      el("td", {}, trace.rootService),
      el("td", {}, trace.rootSpan),
      el("td", {}, String(trace.spanCount)),
      el("td", { className: "duration-cell" }, formatDurationNs(trace.duration)),
      el(
        "td",
        {},
        el("span", { className: `status-dot ${statusClass}` }),
        trace.hasError ? "Error" : "OK"
      )
    );

    row.addEventListener("click", () => {
      tbody.querySelectorAll("tr").forEach((r) => {
        r.classList.remove("selected");
      });
      row.classList.add("selected");
      if (onTraceSelect) onTraceSelect(trace);
    });

    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
}

function showAggResults(aggResult, queryResult) {
  const panel = $("#queryResultsPanel");
  if (!panel) return;
  panel.innerHTML = "";

  const stats = el(
    "div",
    { className: "query-stats" },
    el("span", {}, `${queryResult.traceCount} traces`),
    el("span", {}, `${aggResult.groups.length} groups`),
    el("span", {}, `${queryResult.elapsed.toFixed(1)}ms`)
  );
  panel.appendChild(stats);

  const grid = el("div", { className: "agg-grid" });
  for (const group of aggResult.groups.slice(0, 20)) {
    const formattedVal =
      typeof group.value === "number" && group.value > 1_000_000
        ? formatDurationNs(group.value)
        : formatNum(group.value);

    grid.appendChild(
      el(
        "div",
        { className: "agg-card" },
        el("div", { className: "agg-value" }, formattedVal),
        el("div", { className: "agg-label" }, `${group.key} (${group.count})`)
      )
    );
  }
  panel.appendChild(grid);
}

// ── Event Binding ────────────────────────────────────────────────────

function bindQueryEvents() {
  const executeBtn = $("#executeQuery");
  if (executeBtn) executeBtn.addEventListener("click", runQuery);

  const inputs = [
    "#qService",
    "#qSpanName",
    "#qStatus",
    "#qKind",
    "#qMinDuration",
    "#qMaxDuration",
    "#qSortBy",
    "#qSortDir",
    "#qLimit",
    "#qStructType",
    "#qStructService",
    "#qStructSpanName",
    "#qStructStatus",
    "#qIntrinsicRootService",
    "#qIntrinsicRootSpan",
    "#qIntrinsicMinDuration",
  ];
  for (const sel of inputs) {
    const elem = $(sel);
    if (elem) elem.addEventListener("input", debouncedPreview);
    if (elem) elem.addEventListener("change", debouncedPreview);
  }

  // Enter key to execute
  document.querySelectorAll("#section-query input, #section-query select").forEach((elem) => {
    elem.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runQuery();
    });
  });
}
