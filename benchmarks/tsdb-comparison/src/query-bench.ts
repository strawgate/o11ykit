/**
 * PromQL query benchmark — runs identical queries against all three TSDBs
 * and measures latency percentiles.
 */

import type { BenchConfig, TsdbTarget } from "./config.js";

export interface QueryDef {
  name: string;
  description: string;
  /** PromQL expression */
  expr: string;
  /** Whether to use range query (true) or instant query (false) */
  range: boolean;
}

export interface QueryResult {
  query: string;
  target: string;
  /** Latencies in ms for each iteration */
  latencies: number[];
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  /** Number of series returned */
  seriesCount: number;
  /** Whether all iterations succeeded */
  allSucceeded: boolean;
  errors: string[];
}

export interface BenchQueryResults {
  target: string;
  queries: QueryResult[];
}

// ── Benchmark queries covering common TSDB operations ───────────────────

export const BENCHMARK_QUERIES: QueryDef[] = [
  {
    name: "simple_select",
    description: "Select all gauge series",
    expr: "bench_cpu_usage_percent_ratio",
    range: false,
  },
  {
    name: "label_filter",
    description: "Filter by label",
    expr: 'bench_cpu_usage_percent_ratio{region="region-0"}',
    range: false,
  },
  {
    name: "rate_counter",
    description: "Rate over counter",
    expr: "rate(bench_http_requests_total[5m])",
    range: false,
  },
  {
    name: "sum_by_rate",
    description: "Aggregate rate by label",
    expr: 'sum by (method) (rate(bench_http_requests_total[5m]))',
    range: false,
  },
  {
    name: "histogram_quantile",
    description: "P95 from histogram",
    expr: 'histogram_quantile(0.95, rate(bench_request_duration_seconds_bucket[5m]))',
    range: false,
  },
  {
    name: "avg_gauge",
    description: "Average gauge value",
    expr: "avg(bench_cpu_usage_percent_ratio)",
    range: false,
  },
  {
    name: "topk",
    description: "Top 10 series by value",
    expr: "topk(10, bench_cpu_usage_percent_ratio)",
    range: false,
  },
  {
    name: "range_rate",
    description: "Range query: rate over 1h",
    expr: "rate(bench_http_requests_total[5m])",
    range: true,
  },
  {
    name: "range_histogram",
    description: "Range query: histogram quantile over 1h",
    expr: 'histogram_quantile(0.95, rate(bench_request_duration_seconds_bucket[5m]))',
    range: true,
  },
  {
    name: "range_aggregation",
    description: "Range query: avg gauge over 1h",
    expr: 'avg by (region) (bench_cpu_usage_percent_ratio)',
    range: true,
  },
];

// ── Percentile helpers ──────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── Query runner ────────────────────────────────────────────────────────

async function runQuery(
  target: TsdbTarget,
  query: QueryDef,
  config: BenchConfig,
): Promise<QueryResult> {
  const latencies: number[] = [];
  const errors: string[] = [];
  let lastSeriesCount = 0;

  const totalRuns = config.queryWarmup + config.queryIterations;

  for (let i = 0; i < totalRuns; i++) {
    const isWarmup = i < config.queryWarmup;
    const headers: Record<string, string> = { ...target.otlpHeaders };

    let url: string;
    if (query.range) {
      const end = Math.floor(Date.now() / 1000);
      const start = end - 3600; // 1 hour range
      url = `${target.queryRangeUrl}?query=${encodeURIComponent(query.expr)}&start=${start}&end=${end}&step=15`;
    } else {
      url = `${target.queryUrl}?query=${encodeURIComponent(query.expr)}`;
    }

    const t0 = performance.now();
    try {
      const resp = await fetch(url, { headers });
      const elapsed = performance.now() - t0;

      if (resp.ok) {
        const body = (await resp.json()) as {
          data?: { result?: unknown[] };
        };
        lastSeriesCount = body?.data?.result?.length ?? 0;
        if (!isWarmup) {
          latencies.push(elapsed);
        }
      } else {
        const text = await resp.text();
        errors.push(`${resp.status}: ${text.slice(0, 100)}`);
        if (!isWarmup) latencies.push(elapsed);
      }
    } catch (err) {
      const elapsed = performance.now() - t0;
      errors.push((err as Error).message);
      if (!isWarmup) latencies.push(elapsed);
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    query: query.name,
    target: target.name,
    latencies,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: mean(sorted),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    seriesCount: lastSeriesCount,
    allSucceeded: errors.length === 0,
    errors: errors.slice(0, 5),
  };
}

/**
 * Run all benchmark queries against all targets.
 */
export async function runQueryBenchmark(
  targets: TsdbTarget[],
  config: BenchConfig,
): Promise<BenchQueryResults[]> {
  console.log(
    `\nRunning query benchmark (${config.queryWarmup} warmup + ${config.queryIterations} measured iterations)...`
  );

  const allResults: BenchQueryResults[] = [];

  for (const target of targets) {
    console.log(`\n  ${target.name}:`);
    const queries: QueryResult[] = [];

    for (const queryDef of BENCHMARK_QUERIES) {
      process.stdout.write(`    ${queryDef.name}... `);
      const result = await runQuery(target, queryDef, config);
      console.log(
        `p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms (${result.seriesCount} series)`
      );
      if (result.errors.length > 0) {
        console.log(`      ⚠ ${result.errors[0]}`);
      }
      queries.push(result);
    }

    allResults.push({ target: target.name, queries });
  }

  return allResults;
}
