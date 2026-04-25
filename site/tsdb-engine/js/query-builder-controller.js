import { buildQueryPreviewHtml, buildQueryRecipeConfig } from "./query-builder-model.js";
import { escapeHtml } from "./utils.js";

export function createQueryBuilderController({ getStore, recommendGroupByForMetric, onRunQuery }) {
  let activeMatchers = [];
  let activeGroupBy = [];
  const availableLabels = new Map();

  function selectedMetricValue() {
    const sel = document.getElementById("queryMetric");
    if (!(sel instanceof HTMLSelectElement)) return "";
    return sel.value || sel.options[0]?.value || "";
  }

  function clearActiveRecipe() {
    document.querySelectorAll(".query-recipe.active").forEach((btn) => {
      btn.classList.remove("active");
    });
  }

  function setActiveRecipe(recipe) {
    document.querySelectorAll(".query-recipe").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.recipe === recipe);
    });
  }

  function populateQueryMetrics(metrics) {
    const sel = document.getElementById("queryMetric");
    if (!sel) return;
    const previousValue = sel.value;
    sel.innerHTML = "";
    for (const metric of metrics) {
      const opt = document.createElement("option");
      opt.value = metric;
      opt.textContent = metric;
      sel.appendChild(opt);
    }
    const nextValue =
      metrics.includes(previousValue) && previousValue ? previousValue : metrics[0] || "";
    sel.value = nextValue;
  }

  function populateGroupByOptions() {
    const sel = document.getElementById("groupByLabel");
    if (!sel) return;
    sel.innerHTML = '<option value="">label…</option>';
    for (const key of availableLabels.keys()) {
      if (key === "__name__") continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = key;
      sel.appendChild(opt);
    }
  }

  function refreshMatcherLabelSelect() {
    const sel = document.getElementById("matcherLabel");
    if (!sel) return;
    sel.innerHTML = '<option value="">Filter label…</option>';
    for (const key of availableLabels.keys()) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = key;
      sel.appendChild(opt);
    }
  }

  function updateQueryPreview() {
    const el = document.getElementById("queryPreview")?.querySelector(".query-preview-code");
    if (!el) return;

    const metric = selectedMetricValue() || "…";
    const agg = document.getElementById("queryAgg")?.value;
    const transform = document.getElementById("queryTransform")?.value;
    const stepMs = parseInt(document.getElementById("queryStep")?.value || "0", 10);
    el.innerHTML = buildQueryPreviewHtml({
      metric,
      matchers: activeMatchers,
      transform,
      agg,
      groupBy: activeGroupBy,
      stepMs,
    });
  }

  function renderMatcherChips() {
    const chips = document.getElementById("matcherChips");
    if (!chips) return;
    if (activeMatchers.length === 0) {
      chips.innerHTML =
        '<span class="matcher-empty">No filters yet. Add exact label matches here.</span>';
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
        renderMatcherChips();
        if (getStore()) onRunQuery();
      });
    });
    updateQueryPreview();
  }

  function renderGroupByChips() {
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
        renderGroupByChips();
        if (getStore()) onRunQuery();
      });
    });
    updateQueryPreview();
  }

  function buildAvailableLabels(store) {
    availableLabels.clear();
    for (let id = 0; id < store.seriesCount; id++) {
      const labels = store.labels(id);
      if (!labels) continue;
      for (const [key, value] of labels) {
        if (key === "__name__") continue;
        if (!availableLabels.has(key)) availableLabels.set(key, new Set());
        availableLabels.get(key).add(value);
      }
    }
    refreshMatcherLabelSelect();
    populateGroupByOptions();
  }

  function applyQueryRecipe(recipe) {
    const aggEl = document.getElementById("queryAgg");
    const transformEl = document.getElementById("queryTransform");
    const stepEl = document.getElementById("queryStep");
    const metric = selectedMetricValue();
    if (!aggEl || !transformEl || !stepEl) return;
    const recipeConfig = buildQueryRecipeConfig(recipe, metric, recommendGroupByForMetric);
    if (!recipeConfig) return;

    aggEl.value = recipeConfig.agg;
    transformEl.value = recipeConfig.transform;
    stepEl.value = String(recipeConfig.stepMs);
    activeGroupBy = [...recipeConfig.groupBy];

    setActiveRecipe(recipe);
    renderGroupByChips();
    updateQueryPreview();
    if (getStore()) onRunQuery();
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
    renderMatcherChips();
    renderGroupByChips();
    updateQueryPreview();
  }

  function resetForDataset(store, metrics) {
    activeMatchers = [];
    activeGroupBy = [];
    clearActiveRecipe();
    buildAvailableLabels(store);
    populateQueryMetrics(metrics);
    renderMatcherChips();
    renderGroupByChips();
    updateQueryPreview();
  }

  function bindEvents() {
    document.getElementById("matcherLabel")?.addEventListener("change", () => {
      clearActiveRecipe();
      const label = document.getElementById("matcherLabel").value;
      const valSel = document.getElementById("matcherValue");
      if (!valSel) return;
      valSel.innerHTML = '<option value="">Filter value…</option>';
      const vals = availableLabels.get(label) || new Set();
      for (const value of vals) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
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
      renderMatcherChips();
      if (getStore()) onRunQuery();
    });

    document.getElementById("btnAddGroupBy")?.addEventListener("click", () => {
      clearActiveRecipe();
      const label = document.getElementById("groupByLabel")?.value;
      if (!label || activeGroupBy.includes(label)) return;
      activeGroupBy.push(label);
      renderGroupByChips();
      if (getStore()) onRunQuery();
    });

    document.getElementById("btnQuery")?.addEventListener("click", () => onRunQuery());

    for (const id of ["queryMetric", "queryAgg", "queryStep", "queryTransform"]) {
      document.getElementById(id)?.addEventListener("change", () => {
        clearActiveRecipe();
        updateQueryPreview();
        if (getStore()) onRunQuery();
      });
    }

    document.querySelectorAll(".query-recipe").forEach((btn) => {
      btn.addEventListener("click", () => applyQueryRecipe(btn.dataset.recipe));
    });
  }

  function getActiveMatchers() {
    return [...activeMatchers];
  }

  function getActiveGroupBy() {
    return [...activeGroupBy];
  }

  function readConfig() {
    return {
      metric: selectedMetricValue(),
      agg: document.getElementById("queryAgg")?.value || undefined,
      transform: document.getElementById("queryTransform")?.value || undefined,
      stepMs: parseInt(document.getElementById("queryStep")?.value || "0", 10),
      groupBy: activeGroupBy.length > 0 ? [...activeGroupBy] : undefined,
      matchers: activeMatchers.length > 0 ? [...activeMatchers] : undefined,
    };
  }

  bindEvents();

  return {
    resetForDataset,
    updatePreview: updateQueryPreview,
    applyQueryConfig,
    getActiveMatchers,
    getActiveGroupBy,
    readConfig,
  };
}
