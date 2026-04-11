import type { IndexFile, SeriesFile, PrIndexEntry, RefIndexEntry, MetricSummaryEntry, OtlpMetricsDocument } from "@octo11y/core";
import type { RunDetailView, ComparisonResult, ThresholdConfig } from "@benchkit/format";
import { compareRuns as compare, buildOtlpResult, MetricsBatch, DEFAULT_DATA_BRANCH } from "@benchkit/format";

export interface DataSource {
  owner?: string;
  repo?: string;
  branch?: string;
  /** Absolute URL override — if set, owner/repo/branch are ignored. */
  baseUrl?: string;
}

export function rawUrl(ds: DataSource, filePath: string): string {
  if (ds.baseUrl) {
    let base = ds.baseUrl;
    while (base.endsWith("/")) base = base.slice(0, -1);
    let path = filePath;
    while (path.startsWith("/")) path = path.slice(1);
    return `${base}/${path}`;
  }
  if (!ds.owner || !ds.repo) {
    throw new Error("DataSource must have either baseUrl or owner+repo");
  }
  const branch = ds.branch ?? DEFAULT_DATA_BRANCH;
  return `https://raw.githubusercontent.com/${ds.owner}/${ds.repo}/${branch}/${filePath}`;
}

async function fetchJson<T>(ds: DataSource, filePath: string, signal?: AbortSignal): Promise<T> {
  const url = rawUrl(ds, filePath);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchIndex(ds: DataSource, signal?: AbortSignal): Promise<IndexFile> {
  return fetchJson<IndexFile>(ds, "data/index.json", signal);
}

export function fetchSeries(ds: DataSource, metric: string, signal?: AbortSignal): Promise<SeriesFile> {
  return fetchJson<SeriesFile>(ds, `data/series/${metric}.json`, signal);
}

export function fetchRun(ds: DataSource, runId: string, signal?: AbortSignal): Promise<OtlpMetricsDocument> {
  return fetchJson<OtlpMetricsDocument>(ds, `data/runs/${runId}.json`, signal);
}

export function fetchPrIndex(ds: DataSource, signal?: AbortSignal): Promise<PrIndexEntry[]> {
  return fetchJson<PrIndexEntry[]>(ds, "data/index/prs.json", signal);
}

export function fetchRefIndex(ds: DataSource, signal?: AbortSignal): Promise<RefIndexEntry[]> {
  return fetchJson<RefIndexEntry[]>(ds, "data/index/refs.json", signal);
}

export function fetchMetricSummary(ds: DataSource, signal?: AbortSignal): Promise<MetricSummaryEntry[]> {
  return fetchJson<MetricSummaryEntry[]>(ds, "data/index/metrics.json", signal);
}

export function fetchRunDetail(ds: DataSource, runId: string, signal?: AbortSignal): Promise<RunDetailView> {
  return fetchJson<RunDetailView>(ds, `data/views/runs/${runId}/detail.json`, signal);
}

/**
 * Fetch two run detail views, convert to BenchmarkResult, and compare.
 * Returns the comparison result plus both detail views for downstream use.
 */
export async function compareRuns(
  ds: DataSource,
  currentRunId: string,
  baselineRunId: string,
  threshold?: ThresholdConfig,
  signal?: AbortSignal,
): Promise<{ comparison: ComparisonResult; currentDetail: RunDetailView; baselineDetail: RunDetailView }> {
  const [currentDetail, baselineDetail] = await Promise.all([
    fetchRunDetail(ds, currentRunId, signal),
    fetchRunDetail(ds, baselineRunId, signal),
  ]);
  const currentBatch = detailViewToBatch(currentDetail);
  const baselineBatch = detailViewToBatch(baselineDetail);
  const comparison = compare(currentBatch, [baselineBatch], threshold);
  return { comparison, currentDetail, baselineDetail };
}

/** Convert a RunDetailView directly to MetricsBatch. */
function detailViewToBatch(detail: RunDetailView): MetricsBatch {
  const benchmarks = detail.metricSnapshots.flatMap((snap) =>
    snap.values.map((v) => ({
      name: v.name,
      tags: v.tags,
      metrics: { [snap.metric]: { value: v.value, unit: v.unit, direction: v.direction } },
    })),
  );
  const doc = buildOtlpResult({
    benchmarks,
    context: { sourceFormat: "otlp" },
  });
  return MetricsBatch.fromOtlp(doc);
}
