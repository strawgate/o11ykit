// @ts-nocheck
// ── Traces Explorer — Service health, insights, problematic traces ──

import { renderSparkline } from "./chart.js";
import {
  computeServiceMetrics,
  detectProblematicTraces,
  generateInsights,
  groupByTrace,
} from "./traces-model.js";
import {
  $,
  el,
  formatDurationNs,
  formatNum,
  formatPercent,
  hexFromBytes,
  normalizeTraceId,
  serviceColor,
  serviceColorVar,
  shortTraceId,
} from "./utils.js";

let currentSpans = [];
let currentServiceNames = [];
let serviceMetrics = null;
let onTraceSelect = null;

/**
 * Build traces explorer UI.
 * @param {Array} spans
 * @param {string[]} serviceNames
 * @param {{ onTraceSelect: Function }} callbacks
 */
export function buildTracesExplorer(spans, serviceNames, callbacks = {}) {
  currentSpans = spans;
  currentServiceNames = serviceNames;
  onTraceSelect = callbacks.onTraceSelect || null;

  serviceMetrics = computeServiceMetrics(spans, serviceNames);

  renderServiceHealthGrid();
  renderInsightsPanel();
  renderProblematicTraces();
}

export function refreshTracesExplorer(spans, serviceNames) {
  currentSpans = spans;
  currentServiceNames = serviceNames;
  serviceMetrics = computeServiceMetrics(spans, serviceNames);
  renderServiceHealthGrid();
  renderInsightsPanel();
  renderProblematicTraces();
}

// ── Service Health Grid ──────────────────────────────────────────────

function renderServiceHealthGrid() {
  const container = $("#serviceHealthGrid");
  if (!container) return;
  container.innerHTML = "";

  for (const [name, metrics] of serviceMetrics) {
    const card = el("button", {
      type: "button",
      className: `service-health-card${metrics.errorRate > 0.05 ? " has-errors" : ""}`,
    });

    const header = el(
      "div",
      { className: "shc-header" },
      el("span", { className: "shc-name" }, name),
      el("span", {
        className: "shc-swatch",
        style: { background: serviceColorVar(name, currentServiceNames) },
      })
    );
    card.appendChild(header);

    const metricsRow = el("div", { className: "shc-metrics" });

    // Rate
    metricsRow.appendChild(
      el(
        "div",
        { className: "shc-metric" },
        el("div", { className: "shc-metric-value rate" }, formatNum(metrics.spanCount)),
        el("div", { className: "shc-metric-label" }, "Spans")
      )
    );

    // Error rate
    metricsRow.appendChild(
      el(
        "div",
        { className: "shc-metric" },
        el(
          "div",
          { className: `shc-metric-value${metrics.errorRate > 0.05 ? " error" : ""}` },
          formatPercent(metrics.errorRate * 100)
        ),
        el("div", { className: "shc-metric-label" }, "Errors")
      )
    );

    // P99 duration
    metricsRow.appendChild(
      el(
        "div",
        { className: "shc-metric" },
        el(
          "div",
          { className: "shc-metric-value duration" },
          formatDurationNs(metrics.p99DurationNs)
        ),
        el("div", { className: "shc-metric-label" }, "p99")
      )
    );
    card.appendChild(metricsRow);

    // Sparkline
    if (metrics.errorTimeBuckets) {
      const sparkDiv = el("div", { className: "shc-sparkline" });
      const canvas = el("canvas", {});
      sparkDiv.appendChild(canvas);
      card.appendChild(sparkDiv);

      requestAnimationFrame(() => {
        if (canvas.clientWidth > 0) {
          renderSparkline(canvas, metrics.rateBuckets, {
            color: serviceColor(name),
            width: canvas.clientWidth,
            height: 24,
          });
        }
      });
    }

    card.addEventListener("click", () => {
      document.querySelectorAll(".service-health-card").forEach((c) => {
        c.classList.remove("selected");
      });
      card.classList.add("selected");
      showServiceTraces(name);
    });

    container.appendChild(card);
  }
}

// ── Insights Panel ───────────────────────────────────────────────────

function renderInsightsPanel() {
  const container = $("#insightsPanel");
  if (!container) return;

  const insights = generateInsights(serviceMetrics);
  if (insights.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  container.innerHTML = "";

  container.appendChild(
    el("h3", {}, `🔍 ${insights.length} Insight${insights.length > 1 ? "s" : ""} Detected`)
  );

  for (const insight of insights.slice(0, 8)) {
    container.appendChild(
      el(
        "div",
        { className: `insight-item insight-severity-${insight.severity}` },
        el("span", { className: "insight-icon" }, insight.icon),
        insight.message
      )
    );
  }
}

// ── Problematic Traces ───────────────────────────────────────────────

function renderProblematicTraces() {
  const container = $("#problematicTraces");
  if (!container) return;

  const problems = detectProblematicTraces(currentSpans, serviceMetrics);
  container.innerHTML = "";

  if (problems.length === 0) {
    container.appendChild(
      el(
        "p",
        { style: { color: "var(--ink-muted)", fontSize: "14px" } },
        "✅ No problematic traces detected"
      )
    );
    return;
  }

  container.appendChild(
    el("h3", {}, `⚠️ ${problems.length} Problematic Trace${problems.length > 1 ? "s" : ""}`)
  );

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
      el("th", {}, "Issues"),
      el("th", {}, "Severity")
    )
  );
  table.appendChild(thead);

  const tbody = el("tbody", {});
  for (const problem of problems.slice(0, 20)) {
    const row = el(
      "tr",
      {},
      el("td", { className: "trace-id-cell" }, shortTraceId(problem.traceId)),
      el("td", {}, problem.rootService),
      el("td", {}, problem.rootSpan),
      el("td", {}, String(problem.spanCount)),
      el("td", { className: "duration-cell" }, formatDurationNs(problem.duration)),
      el("td", {}, problem.issues.map((i) => i.message).join(", ")),
      el(
        "td",
        {},
        el("span", { className: `insight-severity-${problem.severity}` }, problem.severity)
      )
    );

    row.addEventListener("click", () => {
      if (onTraceSelect) {
        const traceSpans = currentSpans.filter((s) => {
          return normalizeTraceId(s.traceId) === problem.traceId;
        });
        onTraceSelect({ traceId: problem.traceId, spans: traceSpans });
      }
    });

    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

// ── Service Filtered Trace List ──────────────────────────────────────

function showServiceTraces(service) {
  const container = $("#traceListPanel");
  if (!container) return;
  container.innerHTML = "";

  const svcSpans = currentSpans.filter((s) => {
    const attr = s.attributes?.find((a) => a.key === "service.name");
    return attr && attr.value === service;
  });

  const traceMap = groupByTrace(svcSpans);
  const traceSummaries = [];

  for (const [traceId, _traceSpans] of traceMap) {
    const allTraceSpans = currentSpans.filter((s) => {
      return normalizeTraceId(s.traceId) === traceId;
    });
    const root = allTraceSpans.find((s) => !s.parentSpanId) || allTraceSpans[0];
    const hasError = allTraceSpans.some((s) => s.statusCode === 2);
    const dur = root ? Number(root.endTimeUnixNano - root.startTimeUnixNano) : 0;

    traceSummaries.push({
      traceId,
      rootService: service,
      rootSpan: root?.name || "unknown",
      spanCount: allTraceSpans.length,
      duration: dur,
      hasError,
      spans: allTraceSpans,
    });
  }

  traceSummaries.sort((a, b) => b.duration - a.duration);

  container.appendChild(el("h3", {}, `Traces involving ${service} (${traceSummaries.length})`));

  const table = el("table", { className: "results-table" });
  const thead = el(
    "thead",
    {},
    el(
      "tr",
      {},
      el("th", {}, "Trace ID"),
      el("th", {}, "Root Span"),
      el("th", {}, "Spans"),
      el("th", {}, "Duration"),
      el("th", {}, "Status")
    )
  );
  table.appendChild(thead);

  const tbody = el("tbody", {});
  for (const trace of traceSummaries.slice(0, 50)) {
    const statusClass = trace.hasError ? "error" : "ok";
    const row = el(
      "tr",
      {},
      el("td", { className: "trace-id-cell" }, shortTraceId(trace.traceId)),
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
      if (onTraceSelect) onTraceSelect(trace);
    });

    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
