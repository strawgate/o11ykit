import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  MetricsBatch,
  type MetricPoint,
  type ResourceContext,
} from "@benchkit/format";
import type {
  MonitorContext,
  IndexFile,
  RunEntry,
  SeriesFile,
  DataPoint,
} from "@octo11y/core";

/** A parsed benchmark run with its identifier. */
export interface ParsedRun {
  id: string;
  batch: MetricsBatch;
  /** ISO timestamp for run ordering. */
  timestamp: string;
  monitor?: MonitorContext;
}

const OTLP_JSON_SUFFIX = ".otlp.json";
const OTLP_JSONL_SUFFIX = ".otlp.jsonl";
const OTLP_JSONL_GZ_SUFFIX = ".otlp.jsonl.gz";

/**
 * When a scenario name starts with `_monitor/`, prefix the metric name
 * so Dashboard can partition monitor metrics from user benchmarks.
 */
export function resolveMetricName(scenario: string, metricName: string): string {
  if (metricName.startsWith("_monitor/")) return metricName;
  if (metricName.startsWith("_monitor.")) {
    return `_monitor/${metricName.slice("_monitor.".length)}`;
  }
  return scenario.startsWith("_monitor/") ? `_monitor/${metricName}` : metricName;
}

/** Sort runs by timestamp (oldest first). */
export function sortRuns(runs: ParsedRun[]): void {
  runs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Remove the oldest runs so that at most `maxRuns` remain.
 * Returns the IDs of the pruned runs.
 */
export function pruneRuns(runs: ParsedRun[], maxRuns: number): string[] {
  if (maxRuns <= 0 || runs.length <= maxRuns) return [];
  const removed = runs.splice(0, runs.length - maxRuns);
  return removed.map((r) => r.id);
}

/** Build the index file from a set of runs (assumes runs are already sorted oldest-first). */
export function buildIndex(runs: ParsedRun[]): IndexFile {
  const allMetrics = new Set<string>();
  const indexRuns: RunEntry[] = runs.map((r) => {
    const metricNames = new Set<string>();
    const scenarioNames = new Set<string>();
    for (const p of r.batch.points) {
      scenarioNames.add(p.scenario);
      const resolved = resolveMetricName(p.scenario, p.metric);
      metricNames.add(resolved);
      allMetrics.add(resolved);
    }
    return {
      id: r.id,
      timestamp: r.timestamp,
      commit: r.batch.context.commit,
      ref: r.batch.context.ref,
      benchmarks: scenarioNames.size,
      metrics: Array.from(metricNames).sort(),
      monitor: r.monitor,
    };
  });

  return {
    runs: [...indexRuns].reverse(), // newest first
    metrics: Array.from(allMetrics).sort(),
  };
}

/**
 * Build series files from runs. When a run has multiple points with the
 * same series key + metric (e.g. Go `-count=N`), their values are averaged and the
 * range is computed from the spread.
 */
export function buildSeries(runs: ParsedRun[]): Map<string, SeriesFile> {
  const seriesMap = new Map<string, SeriesFile>();

  for (const r of runs) {
    // Group points by (seriesKey, metric) within this run
    const groups = new Map<
      string,
      Map<
        string,
        {
          sum: number;
          count: number;
          min: number;
          max: number;
          unit?: string;
          direction?: "bigger_is_better" | "smaller_is_better";
          tags: Record<string, string>;
          scenario: string;
        }
      >
    >();

    for (const p of r.batch.points) {
      const tagsStr = Object.keys(p.tags).length > 0
        ? Object.entries(p.tags)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(",")
        : "";
      const groupKey = tagsStr ? `${p.scenario} [${tagsStr}]` : p.scenario;

      let metricMap = groups.get(groupKey);
      if (!metricMap) {
        metricMap = new Map();
        groups.set(groupKey, metricMap);
      }

      let agg = metricMap.get(p.metric);
      if (!agg) {
        agg = {
          sum: 0,
          count: 0,
          min: Infinity,
          max: -Infinity,
          unit: p.unit || undefined,
          direction: p.direction,
          tags: p.tags as Record<string, string>,
          scenario: p.scenario,
        };
        metricMap.set(p.metric, agg);
      }
      agg.sum += p.value;
      agg.count++;
      agg.min = Math.min(agg.min, p.value);
      agg.max = Math.max(agg.max, p.value);
    }

    // Emit one point per (seriesKey, metric) per run
    for (const [seriesKey, metricMap] of groups) {
      for (const [metricName, agg] of metricMap) {
        const resolvedMetric = resolveMetricName(agg.scenario, metricName);
        let series = seriesMap.get(resolvedMetric);
        if (!series) {
          series = {
            metric: resolvedMetric,
            unit: agg.unit,
            direction: agg.direction,
            series: {},
          };
          seriesMap.set(resolvedMetric, series);
        }

        if (!series.series[seriesKey]) {
          const tags = Object.keys(agg.tags).length > 0 ? agg.tags : undefined;
          series.series[seriesKey] = { tags, points: [] };
        }

        const avg = agg.sum / agg.count;
        const range = agg.count > 1 ? agg.max - agg.min : undefined;
        const point: DataPoint = {
          timestamp: r.timestamp,
          value: Math.round(avg * 100) / 100,
          commit: r.batch.context.commit,
          run_id: r.id,
          range:
            range !== null && range !== undefined ? Math.round(range * 100) / 100 : undefined,
        };
        series.series[seriesKey].points.push(point);
      }
    }
  }

  return seriesMap;
}

/**
 * Read all run JSON files from `runsDir`.
 * Expects OTLP JSON (resourceMetrics) format.
 * Throws on corrupted (non-parseable) run files so the caller can surface
 * a clear error message including the offending file name.
 */
export function readRuns(runsDir: string): ParsedRun[] {
  if (!fs.existsSync(runsDir)) return [];
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const runs: ParsedRun[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const parsed = parseRunDirectory(runsDir, entry.name);
      if (parsed) runs.push(parsed);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const id = path.basename(entry.name, ".json");
      const fileName = entry.name;
      const filePath = path.join(runsDir, entry.name);
      runs.push(parseRunFileFromJsonDocument(id, fileName, filePath));
    }
  }

  runs.sort((a, b) => a.id.localeCompare(b.id));
  return runs;
}

function parseRunDirectory(runsDir: string, runId: string): ParsedRun | undefined {
  const runPath = path.join(runsDir, runId);
  const entries = fs.readdirSync(runPath, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      name.endsWith(OTLP_JSON_SUFFIX)
      || name.endsWith(OTLP_JSONL_SUFFIX)
      || name.endsWith(OTLP_JSONL_GZ_SUFFIX))
    .sort();

  if (files.length === 0) {
    return undefined;
  }

  const batches: MetricsBatch[] = files.map((fileName) => {
    const filePath = path.join(runPath, fileName);
    if (fileName.endsWith(OTLP_JSONL_GZ_SUFFIX)) {
      const compressed = fs.readFileSync(filePath);
      const content = gunzipSync(compressed).toString("utf-8");
      return parseJsonlFile(runId, `${runId}/${fileName}`, content);
    }
    if (fileName.endsWith(OTLP_JSONL_SUFFIX)) {
      const content = fs.readFileSync(filePath, "utf-8");
      return parseJsonlFile(runId, `${runId}/${fileName}`, content);
    }
    return parseRunFileFromJsonDocument(runId, `${runId}/${fileName}`, filePath).batch;
  });

  const merged = mergeBatches(batches);
  return buildParsedRun(runId, normalizeMonitorTelemetryPoints(merged));
}

function parseJsonlFile(runId: string, fileName: string, content: string): MetricsBatch {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return MetricsBatch.fromOtlp({ resourceMetrics: [] });
  }

  const batches: MetricsBatch[] = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Failed to parse run file '${fileName}' line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `Run file '${fileName}' line ${index + 1} must contain a JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
      );
    }
    return parseRunObject(runId, parsed as Record<string, unknown>, fileName).batch;
  });
  return mergeBatches(batches);
}

function mergeBatches(batches: readonly MetricsBatch[]): MetricsBatch {
  if (batches.length === 0) {
    return MetricsBatch.fromOtlp({ resourceMetrics: [] });
  }
  let runId: string | undefined;
  let kind: string | undefined;
  let sourceFormat: string | undefined;
  let commit: string | undefined;
  let ref: string | undefined;
  let workflow: string | undefined;
  let job: string | undefined;
  let runAttempt: string | undefined;
  let runner: string | undefined;
  let serviceName: string | undefined;
  const points: MetricPoint[] = [];
  for (const batch of batches) {
    points.push(...batch.points);
    runId ??= batch.context.runId;
    kind ??= batch.context.kind;
    sourceFormat ??= batch.context.sourceFormat;
    commit ??= batch.context.commit;
    ref ??= batch.context.ref;
    workflow ??= batch.context.workflow;
    job ??= batch.context.job;
    runAttempt ??= batch.context.runAttempt;
    runner ??= batch.context.runner;
    serviceName ??= batch.context.serviceName;
  }
  const context: ResourceContext = {
    runId,
    kind,
    sourceFormat,
    commit,
    ref,
    workflow,
    job,
    runAttempt,
    runner,
    serviceName,
  };
  return MetricsBatch.fromPoints(points, context);
}

function normalizeMonitorTelemetryPoints(batch: MetricsBatch): MetricsBatch {
  const normalized = batch.points.map((point) => {
    const scenario = point.scenario.trim();
    const series = point.series.trim();

    const isMonitorScenario = scenario.startsWith("_monitor/");
    const isMonitorMetric = point.metric.startsWith("_monitor.") || point.metric.startsWith("_monitor/");
    if (isMonitorScenario) {
      const normalizedSeries = series || scenario.slice("_monitor/".length) || "system";
      return {
        ...point,
        series: normalizedSeries,
        role: point.role ?? "diagnostic",
      };
    }
    if (scenario) {
      return point;
    }

    if (!isMonitorMetric && series) {
      return point;
    }

    const monitorSeries = series || "system";
    return {
      ...point,
      scenario: `_monitor/${monitorSeries}`,
      series: monitorSeries,
      role: point.role ?? "diagnostic",
    };
  });
  return MetricsBatch.fromPoints(normalized, batch.context);
}

function parseRunFileFromJsonDocument(id: string, fileName: string, filePath: string): ParsedRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse run file '${fileName}': ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Run file '${fileName}' must contain a JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }
  return parseRunObject(id, parsed as Record<string, unknown>, fileName);
}

/** Convert a parsed JSON object into a ParsedRun. Expects OTLP format. */
function parseRunObject(id: string, data: Record<string, unknown>, fileName: string): ParsedRun {
  if (!Array.isArray(data.resourceMetrics)) {
    throw new Error(
      `Run file '${fileName}' is not valid OTLP JSON (missing resourceMetrics array).`,
    );
  }
  const batch = MetricsBatch.fromOtlp(data as unknown as import("@benchkit/format").OtlpMetricsDocument);
  return buildParsedRun(id, normalizeMonitorTelemetryPoints(batch));
}

function buildParsedRun(id: string, batch: MetricsBatch): ParsedRun {
  let timestamp = new Date().toISOString();
  if (batch.points.length > 0 && batch.points[0].timestamp) {
    const nanos = BigInt(batch.points[0].timestamp);
    timestamp = new Date(Number(nanos / 1_000_000n)).toISOString();
  }
  return { id, batch, timestamp };
}
