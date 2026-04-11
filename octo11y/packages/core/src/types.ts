/** Direction hint for a metric — smaller or bigger is better. */
export type MetricDirection = "bigger_is_better" | "smaller_is_better";

export type OtlpAggregationTemporality = "unspecified" | "delta" | "cumulative";

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
}

export interface OtlpAttribute {
  key: string;
  value?: OtlpAnyValue;
}

export interface OtlpGaugeDataPoint {
  attributes?: OtlpAttribute[];
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  asDouble?: number;
  asInt?: string;
}

export interface OtlpHistogramDataPoint {
  attributes?: OtlpAttribute[];
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  count?: string | number;
  sum?: number;
}

export interface OtlpGaugeMetric {
  dataPoints?: OtlpGaugeDataPoint[];
}

export interface OtlpSumMetric {
  dataPoints?: OtlpGaugeDataPoint[];
  aggregationTemporality?: number;
  isMonotonic?: boolean;
}

export interface OtlpHistogramMetric {
  dataPoints?: OtlpHistogramDataPoint[];
  aggregationTemporality?: number;
}

export interface OtlpMetric {
  name: string;
  description?: string;
  unit?: string;
  gauge?: OtlpGaugeMetric;
  sum?: OtlpSumMetric;
  histogram?: OtlpHistogramMetric;
}

export interface OtlpScopeMetrics {
  metrics?: OtlpMetric[];
}

export interface OtlpResource {
  attributes?: OtlpAttribute[];
}

export interface OtlpResourceMetrics {
  resource?: OtlpResource;
  scopeMetrics?: OtlpScopeMetrics[];
}

export interface OtlpMetricsDocument {
  resourceMetrics: OtlpResourceMetrics[];
}

// ---------------------------------------------------------------------------
// Generic view/index types — consumed by aggregation and chart surfaces
// ---------------------------------------------------------------------------

/** Series format — pre-aggregated data produced by aggregation. */
export interface SeriesFile {
  metric: string;
  unit?: string;
  direction?: MetricDirection;
  series: Record<string, SeriesEntry>;
}

export interface SeriesEntry {
  tags?: Record<string, string>;
  points: DataPoint[];
}

export interface DataPoint {
  timestamp: string;
  value: number;
  commit?: string;
  run_id?: string;
  range?: number;
}

/** Index format — run listing on the data branch. */
export interface IndexFile {
  runs: RunEntry[];
  metrics?: string[];
}

export interface RunEntry {
  id: string;
  timestamp: string;
  commit?: string;
  ref?: string;
  benchmarks?: number;
  metrics?: string[];
  monitor?: MonitorContext;
}

export interface MonitorContext {
  monitor_version: string;
  poll_interval_ms: number;
  duration_ms: number;
  runner_os?: string;
  runner_arch?: string;
  poll_count?: number;
  kernel?: string;
  cpu_model?: string;
  cpu_count?: number;
  total_memory_mb?: number;
}

/** Navigation index types. */
export interface RefIndexEntry {
  ref: string;
  latestRunId: string;
  latestTimestamp: string;
  latestCommit?: string;
  runCount: number;
}

export interface PrIndexEntry {
  prNumber: number;
  ref: string;
  latestRunId: string;
  latestTimestamp: string;
  latestCommit?: string;
  runCount: number;
}

export interface MetricSummaryEntry {
  metric: string;
  latestSeriesCount: number;
  latestRunId?: string;
  latestTimestamp?: string;
}
