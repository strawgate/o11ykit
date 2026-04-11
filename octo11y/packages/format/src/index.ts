export type {
  MetricDirection,
  BenchkitRunKind,
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
  Sample,
  MonitorContext,
  SeriesFile,
  SeriesEntry,
  DataPoint,
  IndexFile,
  RunEntry,
  ComparisonResult,
  ComparisonEntry,
  ComparisonStatus,
  FormatComparisonMarkdownOptions,
  ThresholdConfig,
  RefIndexEntry,
  PrIndexEntry,
  RunSnapshotMetric,
  RunDetailMetricSnapshot,
  RunDetailView,
  MetricSummaryEntry,
} from "./types.js";

/** Parse benchmark output in any supported format (auto-detect, go, otlp, benchmark-action). */
export { parseBenchmarks } from "./parse.js";
export type { Format } from "./parse.js";
/** Infer the `direction` ("smaller_is_better" / "bigger_is_better") from a metric unit string. */
export { inferDirection } from "./infer-direction.js";
/** Convert a benchmark unit string to a normalized metric name (e.g. "ns/op" -> "ns_per_op"). */
export { unitToMetricName } from "./parser-utils.js";
/** Parse Go testing/benchmark output text. */
export { parseGoBench } from "./parse-go.js";
/** Parse Rust cargo bench (libtest) output text. */
export { parseRustBench } from "./parse-rust.js";
/** Parse benchmark-action/github-action-benchmark JSON format. */
export { parseBenchmarkAction } from "./parse-benchmark-action.js";
/** Parse Hyperfine JSON format. */
export { parseHyperfine } from "./parse-hyperfine.js";
/** Parse pytest-benchmark JSON format. */
export { parsePytestBenchmark } from "./parse-pytest-benchmark.js";
/** Parse OTLP metrics JSON. */
export {
  parseOtlp,
  otlpAttributesToRecord,
  getOtlpMetricKind,
  getOtlpTemporality,
} from "./parse-otlp.js";
/** OTLP semantic convention constants — attribute names, valid values, reserved keys. */
export {
  ATTR_RUN_ID,
  ATTR_KIND,
  ATTR_SOURCE_FORMAT,
  ATTR_REF,
  ATTR_COMMIT,
  ATTR_WORKFLOW,
  ATTR_JOB,
  ATTR_RUN_ATTEMPT,
  ATTR_RUNNER,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_SCENARIO,
  ATTR_SERIES,
  ATTR_METRIC_DIRECTION,
  ATTR_METRIC_ROLE,
  REQUIRED_RESOURCE_ATTRIBUTES,
  RESERVED_DATAPOINT_ATTRIBUTES,
  VALID_RUN_KINDS,
  VALID_DIRECTIONS,
  VALID_METRIC_ROLES,
  VALID_SOURCE_FORMATS,
  MONITOR_METRIC_PREFIX,
  DEFAULT_DATA_BRANCH,
} from "./otlp-conventions.js";
export type { RunKind, Direction, MetricRole, SourceFormat } from "./otlp-conventions.js";
/** Runtime validators for the benchkit OTLP semantic contract. */
export {
  validateRequiredResourceAttributes,
  validateRequiredDatapointAttributes,
  validateRunKind,
  validateDirection,
  validateMetricRole,
  validateSourceFormat,
  isValidRunKind,
  isValidDirection,
  isValidMetricRole,
  isValidSourceFormat,
  isMonitorMetric,
} from "./otlp-validation.js";
/** Compare a current benchmark run against baseline runs to detect regressions. */
export { compareRuns } from "./compare.js";
/** Format a ComparisonResult as markdown for job summaries and PR comments. */
export { formatComparisonMarkdown } from "./format-comparison-markdown.js";
/** Retry helpers for push operations. */
export { computeRetryDelayMs, sleep, DEFAULT_PUSH_RETRY_COUNT, RETRY_DELAY_MIN_MS, RETRY_DELAY_MAX_MS } from "./retry.js";
/** Build an OtlpMetricsDocument from a simple benchmark input shape. */
export { buildOtlpResult } from "./build-otlp-result.js";
export type { OtlpResultMetric, OtlpResultBenchmark, OtlpResultContext, BuildOtlpResultOptions } from "./build-otlp-result.js";
/** Ergonomic batch wrapper over OtlpMetricsDocument. */
export { MetricsBatch, seriesKey } from "./metrics-batch.js";
export type { MetricPoint, ResourceContext } from "./metrics-batch.js";
