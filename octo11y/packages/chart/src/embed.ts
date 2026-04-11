/**
 * Standalone embed entry point for @benchkit/chart.
 *
 * Include via `<script>` tag with data attributes:
 *
 * ```html
 * <div id="benchkit-chart"></div>
 * <script
 *   type="module"
 *   src="https://cdn.example.com/@benchkit/chart/embed.js"
 *   data-target="#benchkit-chart"
 *   data-owner="strawgate"
 *   data-repo="benchkit"
 *   data-branch="bench-data"
 *   data-mode="dashboard"
 * ></script>
 * ```
 *
 * Supported modes: "dashboard" (default), "trend", "leaderboard"
 *
 * This module does NOT handle cross-file joins or arbitrary queries.
 * It renders a single chart surface from the configured data source.
 */

import { render, type ComponentChild, h } from "preact";
import { useState, useEffect } from "preact/hooks";
import type { SeriesFile } from "@octo11y/core";
import { Dashboard } from "./Dashboard.js";
import { fetchSeries, type DataSource } from "./fetch.js";
import { TrendChart } from "./components/TrendChart.js";
import { Leaderboard } from "./components/Leaderboard.js";

export type EmbedMode = "dashboard" | "trend" | "leaderboard";

export interface EmbedOptions {
  /** CSS selector or HTMLElement for the mount target. */
  target: string | HTMLElement;
  /** Data source configuration. */
  source: DataSource;
  /** Which surface to render. Default: "dashboard". */
  mode?: EmbedMode;
  /** Metric name (required for "trend" and "leaderboard" modes). */
  metric?: string;
  /** Maximum data points for trend charts. Default: 30. */
  maxPoints?: number;
  /** Regression threshold percentage. Default: 10. */
  regressionThreshold?: number;
}

/**
 * Mount a benchkit chart into the given target element.
 * Returns a dispose function that unmounts the component.
 */
export function mount(options: EmbedOptions): () => void {
  const el =
    typeof options.target === "string"
      ? document.querySelector(options.target)
      : options.target;

  if (!el || !(el instanceof HTMLElement)) {
    throw new Error(
      `benchkit embed: target "${options.target}" not found or not an HTMLElement`,
    );
  }

  const source = options.source;
  const mode = options.mode ?? "dashboard";

  let vnode: ComponentChild;

  if (mode === "dashboard") {
    vnode = h(Dashboard, {
      source,
      maxPoints: options.maxPoints ?? 30,
      regressionThreshold: options.regressionThreshold ?? 10,
    });
  } else if (mode === "trend") {
    vnode = h(EmbedTrend, {
      source,
      metric: options.metric ?? "",
      maxPoints: options.maxPoints ?? 30,
    });
  } else if (mode === "leaderboard") {
    vnode = h(EmbedLeaderboard, {
      source,
      metric: options.metric ?? "",
    });
  } else {
    throw new Error(`benchkit embed: unknown mode "${mode}"`);
  }

  render(vnode, el);

  return () => {
    render(null, el);
  };
}

// ── Internal wrapper components for single-metric embeds ─────────────

function EmbedTrend({
  source,
  metric,
  maxPoints,
}: {
  source: DataSource;
  metric: string;
  maxPoints: number;
}) {
  const [seriesFile, setSeriesFile] = useState<SeriesFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!metric) {
      setError("No metric specified for trend chart");
      return;
    }
    const ctrl = new AbortController();
    fetchSeries(source, metric, ctrl.signal)
      .then((sf) => {
        if (!ctrl.signal.aborted) setSeriesFile(sf);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(String(err));
      });
    return () => ctrl.abort();
  }, [source.owner, source.repo, source.branch, source.baseUrl, metric]);

  if (error) return h("div", { class: "bk-state" }, error);
  if (!seriesFile) return h("div", { class: "bk-loading" }, "Loading…");

  return h(TrendChart, {
    series: seriesFile,
    maxPoints,
  });
}

function EmbedLeaderboard({
  source,
  metric,
}: {
  source: DataSource;
  metric: string;
}) {
  const [seriesFile, setSeriesFile] = useState<SeriesFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!metric) {
      setError("No metric specified for leaderboard");
      return;
    }
    const ctrl = new AbortController();
    fetchSeries(source, metric, ctrl.signal)
      .then((sf) => {
        if (!ctrl.signal.aborted) setSeriesFile(sf);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(String(err));
      });
    return () => ctrl.abort();
  }, [source.owner, source.repo, source.branch, source.baseUrl, metric]);

  if (error) return h("div", { class: "bk-state" }, error);
  if (!seriesFile) return h("div", { class: "bk-loading" }, "Loading…");

  return h(Leaderboard, { series: seriesFile });
}

// ── Auto-mount from script tag ───────────────────────────────────────

/**
 * Parse data attributes from the current `<script>` tag and auto-mount.
 * Called automatically when loaded as a `<script type="module">`.
 */
function autoMount(): void {
  const script = document.currentScript;
  if (!script) return;

  const target = script.getAttribute("data-target");
  if (!target) return;

  const source: DataSource = {};
  const owner = script.getAttribute("data-owner");
  const repo = script.getAttribute("data-repo");
  const branch = script.getAttribute("data-branch");
  const baseUrl = script.getAttribute("data-base-url");

  if (owner) source.owner = owner;
  if (repo) source.repo = repo;
  if (branch) source.branch = branch;
  if (baseUrl) source.baseUrl = baseUrl;

  const mode = (script.getAttribute("data-mode") ?? "dashboard") as EmbedMode;
  const metric = script.getAttribute("data-metric") ?? undefined;
  const maxPoints = script.getAttribute("data-max-points");
  const threshold = script.getAttribute("data-regression-threshold");

  mount({
    target,
    source,
    mode,
    metric,
    maxPoints: maxPoints ? parseInt(maxPoints, 10) : undefined,
    regressionThreshold: threshold ? parseFloat(threshold) : undefined,
  });
}

// Auto-mount when loaded as a module script in the browser.
if (typeof document !== "undefined") {
  autoMount();
}
