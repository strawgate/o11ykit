import { useState, useEffect } from "preact/hooks";
import type { IndexFile, SeriesFile } from "@benchkit/format";
import { DATA_REPO_OWNER, DATA_REPO_NAME, fmtBenchName } from "../constants";
import { cachedFetchJson } from "../cached-fetch";

export type BenchData = {
  loading: boolean;
  error: string | null;
  index: IndexFile | null;
  seriesMap: Map<string, SeriesFile>;
};

export function useBenchData(): BenchData {
  const [state, setState] = useState<BenchData>({
    loading: true,
    error: null,
    index: null,
    seriesMap: new Map(),
  });

  useEffect(() => {
    const ctrl = new AbortController();
    const { signal } = ctrl;

    const base = `https://raw.githubusercontent.com/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/bench-data`;

    (async () => {
      try {
        const idx = await cachedFetchJson<IndexFile>(`${base}/data/index.json`, signal);
        const results = await Promise.allSettled(
          (idx.metrics ?? []).map(async (m) => {
            const sf = await cachedFetchJson<SeriesFile>(`${base}/data/series/${m}.json`, signal);
            return [m, sf] as const;
          }),
        );
        const map = new Map<string, SeriesFile>();
        for (const r of results) {
          if (r.status === "fulfilled") map.set(r.value[0], r.value[1]);
        }
        if (!signal.aborted) setState({ loading: false, error: null, index: idx, seriesMap: map });
      } catch (e) {
        if (!signal.aborted) setState({ loading: false, error: String(e), index: null, seriesMap: new Map() });
      }
    })();

    return () => ctrl.abort();
  }, []);

  return state;
}

export type BenchmarkSummary = {
  name: string;
  displayName: string;
  metrics: Map<string, { latest: number; points: Array<{ timestamp: string; value: number }>; unit?: string; direction?: string }>;
  latestTimestamp: string;
  latestCommit?: string;
  runId?: string;
  tags?: Record<string, string>;
};

export function deriveBenchmarks(seriesMap: Map<string, SeriesFile>): BenchmarkSummary[] {
  const benchMap = new Map<string, BenchmarkSummary>();

  for (const [metricName, sf] of seriesMap) {
    for (const [seriesName, entry] of Object.entries(sf.series)) {
      let bench = benchMap.get(seriesName);
      if (!bench) {
        bench = {
          name: seriesName,
          displayName: fmtBenchName(seriesName),
          metrics: new Map(),
          latestTimestamp: "",
          tags: entry.tags,
        };
        benchMap.set(seriesName, bench);
      }
      const pts = entry.points ?? [];
      const latest = pts[pts.length - 1];
      if (latest) {
        bench.metrics.set(metricName, {
          latest: latest.value,
          points: pts.map((p) => ({ timestamp: p.timestamp, value: p.value })),
          unit: sf.unit,
          direction: sf.direction,
        });
        if (!bench.latestTimestamp || latest.timestamp > bench.latestTimestamp) {
          bench.latestTimestamp = latest.timestamp;
          bench.latestCommit = latest.commit;
          bench.runId = latest.run_id;
        }
      }
    }
  }

  return Array.from(benchMap.values()).sort((a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp));
}
