/**
 * Benchmark configuration — all tunable parameters live here.
 */
export interface BenchConfig {
  /** Number of unique metric series per metric type */
  seriesCount: number;
  /** Number of data points per series */
  samplesPerSeries: number;
  /** Interval between samples in seconds */
  sampleIntervalSec: number;
  /** Start time for generated data (epoch ms) */
  startTimeMs: number;
  /** Batch size for OTLP export requests */
  batchSize: number;
  /** Number of query iterations for latency measurement */
  queryIterations: number;
  /** Number of warm-up query iterations (discarded) */
  queryWarmup: number;
}

export const DEFAULT_CONFIG: BenchConfig = {
  seriesCount: 100,
  samplesPerSeries: 360,
  sampleIntervalSec: 10,
  // Start 1 hour ago so data is "recent"
  startTimeMs: Date.now() - 3_600_000,
  batchSize: 500,
  queryIterations: 50,
  queryWarmup: 5,
};

export interface TsdbTarget {
  name: string;
  /** OTLP ingest URL */
  otlpUrl: string;
  /** Extra headers for OTLP ingest */
  otlpHeaders: Record<string, string>;
  /** PromQL instant query URL */
  queryUrl: string;
  /** PromQL range query URL */
  queryRangeUrl: string;
  /** How to measure storage (docker volume name or exec command) */
  volumeName: string;
  /** Container name for docker exec */
  containerName: string;
  /** Data directory inside the container */
  dataDir: string;
}

export const TARGETS: TsdbTarget[] = [
  {
    name: "Prometheus",
    otlpUrl: "http://localhost:9090/api/v1/otlp/v1/metrics",
    otlpHeaders: {},
    queryUrl: "http://localhost:9090/api/v1/query",
    queryRangeUrl: "http://localhost:9090/api/v1/query_range",
    volumeName: "tsdb-comparison_prometheus-data",
    containerName: "tsdb-bench-prometheus",
    dataDir: "/prometheus",
  },
  {
    name: "VictoriaMetrics",
    otlpUrl: "http://localhost:8428/opentelemetry/v1/metrics",
    otlpHeaders: {},
    queryUrl: "http://localhost:8428/api/v1/query",
    queryRangeUrl: "http://localhost:8428/api/v1/query_range",
    volumeName: "tsdb-comparison_victoria-data",
    containerName: "tsdb-bench-victoria",
    dataDir: "/victoria-metrics-data",
  },
  {
    name: "Mimir",
    otlpUrl: "http://localhost:9009/otlp/v1/metrics",
    otlpHeaders: { "X-Scope-OrgID": "benchmark" },
    queryUrl: "http://localhost:9009/prometheus/api/v1/query",
    queryRangeUrl: "http://localhost:9009/prometheus/api/v1/query_range",
    volumeName: "tsdb-comparison_mimir-data",
    containerName: "tsdb-bench-mimir",
    dataDir: "/data",
  },
];
