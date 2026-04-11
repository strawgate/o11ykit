// @octo11y/core — generic OTLP metric types, parsing, and data structures

// OTLP types
export type {
  MetricDirection,
  OtlpAggregationTemporality,
  OtlpAttribute,
  OtlpAnyValue,
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
  // Generic view/index types
  MonitorContext,
  SeriesFile,
  SeriesEntry,
  DataPoint,
  IndexFile,
  RunEntry,
  RefIndexEntry,
  PrIndexEntry,
  MetricSummaryEntry,
} from "./types.js";

// OTLP parsing
export {
  parseOtlp,
  otlpAttributesToRecord,
  getOtlpMetricKind,
  getOtlpTemporality,
} from "./parse-otlp.js";

// Retry helpers
export {
  computeRetryDelayMs,
  sleep,
  DEFAULT_PUSH_RETRY_COUNT,
  RETRY_DELAY_MIN_MS,
  RETRY_DELAY_MAX_MS,
} from "./retry.js";
