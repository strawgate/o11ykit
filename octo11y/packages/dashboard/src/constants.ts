import type { DataSource } from "@benchkit/chart";
import type { SeriesEntry } from "@benchkit/format";

export const PRODUCT_REPO_OWNER = "strawgate";
export const PRODUCT_REPO_NAME = "o11ykit";

const DEFAULT_DATA_REPO = "strawgate/o11ykit-playground";
const DATA_REPO_QUERY_KEY = "dataRepo";
const queryValue = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get(
      DATA_REPO_QUERY_KEY,
    );
  } catch {
    return null;
  }
})();
const DATA_REPO_SLUG =
  queryValue && queryValue.includes("/") ? queryValue : DEFAULT_DATA_REPO;
const [parsedDataOwner, parsedDataRepo] = DATA_REPO_SLUG.split("/", 2);
export const DATA_REPO_OWNER = parsedDataOwner || "strawgate";
export const DATA_REPO_NAME = parsedDataRepo || "o11ykit-playground";
export const DATA_SOURCE: DataSource = {
  owner: DATA_REPO_OWNER,
  repo: DATA_REPO_NAME,
};

export const METRIC_LABELS: Record<string, string> = {
  ns_per_op: "Duration",
  bytes_per_op: "Memory",
  allocs_per_op: "Allocations",
  requests_per_sec: "Throughput",
  p99_latency_ms: "P99 Latency",
  stars: "Stars",
  forks: "Forks",
  open_issues: "Open Issues",
  open_prs: "Open PRs",
  contributors: "Contributors",
  releases: "Releases",
  repo_size_kb: "Repo Size",
  workflow_success_pct: "Workflow Success",
  ts_file_count: "TypeScript Files",
};

export const METRIC_UNITS: Record<string, string> = {
  ns_per_op: "ns/op",
  bytes_per_op: "B/op",
  allocs_per_op: "allocs/op",
  requests_per_sec: "req/s",
  p99_latency_ms: "ms",
  stars: "★",
  forks: "forks",
  open_issues: "issues",
  open_prs: "PRs",
  contributors: "people",
  releases: "releases",
  repo_size_kb: "KB",
  workflow_success_pct: "%",
  ts_file_count: "files",
};

export const METRIC_ICONS: Record<string, string> = {
  ns_per_op: "⏱",
  bytes_per_op: "📦",
  allocs_per_op: "🧮",
  requests_per_sec: "🚀",
  p99_latency_ms: "📊",
  stars: "⭐",
  forks: "🍴",
  open_issues: "🐛",
  open_prs: "📝",
  contributors: "👥",
  releases: "📦",
  repo_size_kb: "💿",
  workflow_success_pct: "✅",
  ts_file_count: "📄",
};

export function fmtMetric(m: string): string {
  return METRIC_LABELS[m] ?? m.replace(/_/g, " ");
}

export function fmtBenchName(name: string): string {
  return name.replace(/^Benchmark/, "");
}

export function fmtSeriesName(name: string, _entry: SeriesEntry): string {
  return fmtBenchName(name);
}

export function fmtValue(v: number, metric?: string): string {
  if (metric === "requests_per_sec" && v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v % 1 === 0 ? String(v) : v.toFixed(1);
}

export function commitHref(sha: string): string {
  return `https://github.com/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/commit/${sha}`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
