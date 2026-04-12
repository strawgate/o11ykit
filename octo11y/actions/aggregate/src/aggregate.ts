import * as fs from "node:fs";
import * as path from "node:path";
import {
  MetricsBatch,
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

const RUN_BENCHMARK_FILE = "benchmark.otlp.json";

/**
 * When a scenario name starts with `_monitor/`, prefix the metric name
 * so Dashboard can partition monitor metrics from user benchmarks.
 */
export function resolveMetricName(scenario: string, metricName: string): string {
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
  const runFiles = entries
    .flatMap((entry): Array<{ id: string; fileName: string; filePath: string }> => {
      if (entry.isDirectory()) {
        const runId = entry.name;
        const fileName = RUN_BENCHMARK_FILE;
        const filePath = path.join(runsDir, runId, fileName);
        if (!fs.existsSync(filePath)) {
          return [];
        }
        return [{ id: runId, fileName: `${runId}/${fileName}`, filePath }];
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const id = path.basename(entry.name, ".json");
        const fileName = entry.name;
        const filePath = path.join(runsDir, entry.name);
        return [{ id, fileName, filePath }];
      }
      return [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return runFiles.map(({ id, fileName, filePath }) => {
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
    return parseRunFile(id, parsed as Record<string, unknown>);
  });
}

/** Convert a parsed JSON object into a ParsedRun. Expects OTLP format. */
function parseRunFile(id: string, data: Record<string, unknown>): ParsedRun {
  if (!Array.isArray(data.resourceMetrics)) {
    throw new Error(
      `Run file '${id}.json' is not valid OTLP JSON (missing resourceMetrics array).`,
    );
  }
  const batch = MetricsBatch.fromOtlp(data as unknown as import("@benchkit/format").OtlpMetricsDocument);
  let timestamp = new Date().toISOString();
  if (batch.points.length > 0 && batch.points[0].timestamp) {
    const nanos = BigInt(batch.points[0].timestamp);
    timestamp = new Date(Number(nanos / 1_000_000n)).toISOString();
  }
  return { id, batch, timestamp };
}
