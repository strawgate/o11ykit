// @ts-check

/** @typedef {import("../site-types").QueryMatcher} QueryMatcher */
/** @typedef {import("../site-types").QueryPreviewOptions} QueryPreviewOptions */
/** @typedef {import("../site-types").QueryRecipeConfig} QueryRecipeConfig */
/** @typedef {import("../site-types").StepResolutionResult} StepResolutionResult */

import { escapeHtml, formatDuration } from "./utils.js";

/**
 * @param {import("../site-types").StepValue} stepNs
 * @returns {string}
 */
export function formatStepLabel(stepNs) {
  if (stepNs === null || stepNs === undefined) return "raw";
  const stepMs = Number(stepNs) / 1_000_000;
  if (!Number.isFinite(stepMs) || stepMs <= 0) return "raw";
  const roundedMs = Math.max(1, Math.round(stepMs));
  if (roundedMs < 1000) return `${roundedMs}ms`;

  const totalSec = Math.round(roundedMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;

  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) return remSec === 0 ? `${totalMin}m` : `${totalMin}m ${remSec}s`;

  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin === 0 ? `${totalHr}h` : `${totalHr}h ${remMin}m`;
}

/**
 * @param {QueryPreviewOptions} options
 * @returns {string}
 */
export function buildQueryPreviewHtml({
  metric,
  matchers = [],
  transform,
  agg,
  groupBy = [],
  stepMs,
}) {
  const metricName = metric || "…";
  let matcherStr = "";
  if (matchers.length > 0) {
    const parts = matchers.map(
      /** @param {QueryMatcher} m */
      (m) =>
        `<span class="qp-label">${escapeHtml(m.label)}</span><span class="qp-op">${escapeHtml(m.op)}</span><span class="qp-val">"${escapeHtml(m.value)}"</span>`
    );
    matcherStr = `{${parts.join(", ")}}`;
  }

  let expr = `<span class="qp-metric">${escapeHtml(metricName)}</span>${matcherStr}`;
  if (transform) {
    expr = `<span class="qp-fn">${transform}</span>(${expr})`;
  }

  if (agg) {
    expr = `<span class="qp-fn">${agg}</span>(${expr}`;
    if ((stepMs ?? 0) > 0) {
      expr += ` <span class="qp-kw">[${formatDuration(stepMs)}]</span>`;
    }
    expr += ")";
    if (groupBy.length > 0) {
      expr += ` <span class="qp-kw">by</span> (<span class="qp-group">${groupBy.join(", ")}</span>)`;
    }
  }

  return expr;
}

/**
 * @param {string} recipe
 * @param {string | null | undefined} metric
 * @param {(metric: string, count?: number) => string[]} recommendGroupBy
 * @returns {QueryRecipeConfig | null}
 */
export function buildQueryRecipeConfig(recipe, metric, recommendGroupBy) {
  /** @param {number} count */
  const recommended = (count) => (metric ? recommendGroupBy(metric, count) : []);
  switch (recipe) {
    case "raw":
      return { agg: "", transform: "", stepMs: 0, groupBy: [] };
    case "rate-sum":
      return { agg: "sum", transform: "rate", stepMs: 60000, groupBy: recommended(1) };
    case "p95":
      return { agg: "p95", transform: "", stepMs: 60000, groupBy: recommended(1) };
    case "count":
      return { agg: "count", transform: "", stepMs: 60000, groupBy: recommended(2) };
    case "last":
      return { agg: "last", transform: "", stepMs: 0, groupBy: recommended(1) };
    default:
      return null;
  }
}

/**
 * @param {StepResolutionResult} result
 * @returns {string}
 */
export function summarizeStepResolution(result) {
  const resolvedStep = formatStepLabel(result.effectiveStep);
  const requestedStep = formatStepLabel(result.requestedStep);
  const stepChanged =
    result.requestedStep !== null &&
    result.requestedStep !== undefined &&
    result.effectiveStep !== result.requestedStep;
  if (result.effectiveStep === null || result.effectiveStep === undefined) return "raw resolution";
  if (stepChanged) {
    return `step widened from ${requestedStep} to ${resolvedStep} for ~${result.pointBudget?.toLocaleString() ?? "?"} points`;
  }
  return `step ${resolvedStep}`;
}

/**
 * @param {StepResolutionResult} result
 * @returns {string}
 */
export function formatEffectiveStepStat(result) {
  if (result.effectiveStep === null || result.effectiveStep === undefined) {
    return `Step: <strong>raw</strong>`;
  }
  if (
    result.requestedStep !== null &&
    result.requestedStep !== undefined &&
    result.effectiveStep !== result.requestedStep
  ) {
    return `Step: <strong>${formatStepLabel(result.effectiveStep)}</strong> <span title="Requested ${formatStepLabel(result.requestedStep)} for about ${result.pointBudget?.toLocaleString() ?? "?"} points">auto</span>`;
  }
  return `Step: <strong>${formatStepLabel(result.effectiveStep)}</strong>`;
}
