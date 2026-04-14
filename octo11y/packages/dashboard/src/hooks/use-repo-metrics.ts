import { useState, useEffect } from "preact/hooks";
import {
  DATA_REPO_OWNER,
  DATA_REPO_NAME,
  METRIC_LABELS,
  METRIC_UNITS,
  METRIC_ICONS,
} from "../constants";
import { cachedFetchJson } from "../cached-fetch";

/* Repo-health metrics that belong on the GuidePage story.
   Benchmark-specific metrics (ns_per_op, bytes_per_op, allocs_per_op, etc.)
   live on the Benchmarks pages and are NOT fetched here. */
const REPO_METRIC_NAMES = new Set([
  "stars", "forks", "open_issues", "open_prs", "contributors",
  "releases", "repo_size_kb", "workflow_success_pct", "ts_file_count",
]);

export type MetricSnapshot = {
  name: string;
  label: string;
  icon: string;
  unit: string;
  latest: number;
  direction: string;
  points: Array<{ t: string; v: number }>;
};

export type RepoMetrics = {
  loading: boolean;
  runs: number;
  metrics: MetricSnapshot[];
};

export function useRepoMetrics(): RepoMetrics {
  const [state, setState] = useState<RepoMetrics>({ loading: true, runs: 0, metrics: [] });

  useEffect(() => {
    const ctrl = new AbortController();
    const branch = "bench-data";
    const base = `https://raw.githubusercontent.com/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/${branch}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchJson = (path: string): Promise<any> =>
      cachedFetchJson(`${base}/${path}`, ctrl.signal).catch(() => null);

    (async () => {
      try {
        const idx = await fetchJson("data/index.json");
        if (!idx?.metrics) { setState({ loading: false, runs: 0, metrics: [] }); return; }

        const results = await Promise.allSettled(
          (idx.metrics as string[])
            .filter((m: string) => REPO_METRIC_NAMES.has(m))
            .map(async (m: string) => {
            const sf = await fetchJson(`data/series/${m}.json`);
            return { metric: m, sf };
          }),
        );

        const metrics: MetricSnapshot[] = [];
        for (const r of results) {
          if (r.status !== "fulfilled" || !r.value.sf) continue;
          const { metric, sf } = r.value;
          const entries = Object.values(sf.series ?? {}) as Array<{ points?: Array<{ timestamp: string; value: number }> }>;
          const allPoints = entries.flatMap(e => (e.points ?? []).map(p => ({ t: p.timestamp, v: p.value })));
          allPoints.sort((a, b) => a.t.localeCompare(b.t));
          const latest = allPoints[allPoints.length - 1];
          if (!latest) continue;
          metrics.push({
            name: metric,
            label: METRIC_LABELS[metric] ?? metric.replace(/_/g, " "),
            icon: METRIC_ICONS[metric] ?? "📈",
            unit: METRIC_UNITS[metric] ?? sf.unit ?? "",
            latest: latest.v,
            direction: sf.direction ?? "bigger_is_better",
            points: allPoints,
          });
        }

        if (!ctrl.signal.aborted) {
          setState({ loading: false, runs: idx.runs?.length ?? 0, metrics });
        }
      } catch {
        if (!ctrl.signal.aborted) setState({ loading: false, runs: 0, metrics: [] });
      }
    })();

    return () => ctrl.abort();
  }, []);

  return state;
}
