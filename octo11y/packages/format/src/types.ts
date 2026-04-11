// Re-export generic OTLP and view types from @octo11y/core
export type {
  MetricDirection,
  OtlpAggregationTemporality,
  OtlpAnyValue,
  OtlpAttribute,
  OtlpGaugeDataPoint,
  OtlpHistogramDataPoint,
  OtlpGaugeMetric,
  OtlpSumMetric,
  OtlpHistogramMetric,
  OtlpMetric,
  OtlpScopeMetrics,
  OtlpResource,
  OtlpResourceMetrics,
  OtlpMetricsDocument,
  MonitorContext,
  SeriesFile,
  SeriesEntry,
  DataPoint,
  IndexFile,
  RunEntry,
  RefIndexEntry,
  PrIndexEntry,
  MetricSummaryEntry,
} from "@octo11y/core";

export type BenchkitRunKind = "code" | "workflow" | "hybrid";

// Benchmark-specific types that remain in @benchkit/format

import type { MetricDirection, RunEntry } from "@octo11y/core";

export interface Sample {
  t: number;
  [metricName: string]: number;
}

/** Comparison types — produced by compare(). */

export type ComparisonStatus = "improved" | "stable" | "regressed";

export interface ComparisonEntry {
  benchmark: string;
  metric: string;
  unit?: string;
  direction: "bigger_is_better" | "smaller_is_better";
  baseline: number;
  current: number;
  percentChange: number;
  status: ComparisonStatus;
}

export interface ComparisonResult {
  entries: ComparisonEntry[];
  hasRegression: boolean;
  warnings?: string[];
}

export interface FormatComparisonMarkdownOptions {
  title?: string;
  currentLabel?: string;
  baselineLabel?: string;
  currentCommit?: string;
  currentRef?: string;
  maxRegressions?: number;
  includeDetails?: boolean;
  footerHref?: string;
}

export interface ThresholdConfig {
  test: "percentage";
  threshold: number;
}

/** View types — produced by the aggregate action for use by frontends. */

export interface RunSnapshotMetric {
  name: string;
  value: number;
  unit?: string;
  direction?: MetricDirection;
  range?: number;
  tags?: Record<string, string>;
}

export interface RunDetailMetricSnapshot {
  metric: string;
  unit?: string;
  direction?: MetricDirection;
  values: RunSnapshotMetric[];
}

export interface RunDetailView {
  run: RunEntry;
  metricSnapshots: RunDetailMetricSnapshot[];
}
