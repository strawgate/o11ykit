/**
 * Benchkit OTLP Semantic Conventions
 *
 * Canonical attribute names and valid values for the benchkit OTLP contract.
 * Source of truth: docs/otlp-semantic-conventions.md
 *
 * Every benchkit OTLP producer and consumer should import from this module
 * rather than hard-coding attribute strings.
 */

// ---------------------------------------------------------------------------
// Resource attributes (run-level metadata on every ResourceMetrics)
// ---------------------------------------------------------------------------

/** Unique run artifact identifier, e.g. `"12345678-1"`. Required. */
export const ATTR_RUN_ID = "benchkit.run_id";

/** Benchmark kind: code, workflow, or hybrid. Required. */
export const ATTR_KIND = "benchkit.kind";

/** Parser / origin format that produced the OTLP data. Required. */
export const ATTR_SOURCE_FORMAT = "benchkit.source_format";

/** Git ref (branch or tag). Strongly recommended. */
export const ATTR_REF = "benchkit.ref";

/** Full commit SHA. Strongly recommended. */
export const ATTR_COMMIT = "benchkit.commit";

/** GitHub Actions workflow name. Strongly recommended. */
export const ATTR_WORKFLOW = "benchkit.workflow";

/** GitHub Actions job name. Strongly recommended. */
export const ATTR_JOB = "benchkit.job";

/** Retry/rerun attempt number. Optional. */
export const ATTR_RUN_ATTEMPT = "benchkit.run_attempt";

/** Human-readable runner description. Optional. */
export const ATTR_RUNNER = "benchkit.runner";

/** OpenTelemetry standard service name. Strongly recommended. */
export const ATTR_SERVICE_NAME = "service.name";

/** Application or service version. Optional. */
export const ATTR_SERVICE_VERSION = "service.version";

/** All resource attributes that MUST be present. */
export const REQUIRED_RESOURCE_ATTRIBUTES = [
  ATTR_RUN_ID,
  ATTR_KIND,
  ATTR_SOURCE_FORMAT,
] as const;

// ---------------------------------------------------------------------------
// Datapoint attributes (metric identity on every data-point)
// ---------------------------------------------------------------------------

/** Primary benchmark scenario / workload name. Required. */
export const ATTR_SCENARIO = "benchkit.scenario";

/** Series identity within a scenario. Required. */
export const ATTR_SERIES = "benchkit.series";

/** Metric improvement direction. Required for comparison-eligible metrics. */
export const ATTR_METRIC_DIRECTION = "benchkit.metric.direction";

/** Metric role: outcome or diagnostic. Recommended. */
export const ATTR_METRIC_ROLE = "benchkit.metric.role";

/**
 * Datapoint attributes consumed internally by the projection logic.
 * These are not forwarded as user-visible benchmark tags.
 */
export const RESERVED_DATAPOINT_ATTRIBUTES = new Set([
  ATTR_SCENARIO,
  ATTR_SERIES,
  ATTR_METRIC_DIRECTION,
  ATTR_METRIC_ROLE,
]);

// ---------------------------------------------------------------------------
// Valid enum values
// ---------------------------------------------------------------------------

/** Valid values for `benchkit.kind`. */
export const VALID_RUN_KINDS = ["code", "workflow", "hybrid"] as const;
export type RunKind = (typeof VALID_RUN_KINDS)[number];

/** Valid values for `benchkit.metric.direction`. */
export const VALID_DIRECTIONS = [
  "bigger_is_better",
  "smaller_is_better",
] as const;
export type Direction = (typeof VALID_DIRECTIONS)[number];

/** Valid values for `benchkit.metric.role`. */
export const VALID_METRIC_ROLES = ["outcome", "diagnostic"] as const;
export type MetricRole = (typeof VALID_METRIC_ROLES)[number];

/** Valid values for `benchkit.source_format`. */
export const VALID_SOURCE_FORMATS = [
  "go",
  "otlp",
  "rust",
  "hyperfine",
  "pytest-benchmark",
  "benchmark-action",
] as const;
export type SourceFormat = (typeof VALID_SOURCE_FORMATS)[number];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default Git branch name used for storing benchmark data. */
export const DEFAULT_DATA_BRANCH = "bench-data";

// ---------------------------------------------------------------------------
// Metric naming conventions
// ---------------------------------------------------------------------------

/**
 * Prefix reserved for infrastructure / diagnostic metrics emitted by the
 * benchkit monitor action (e.g. `_monitor.cpu_user_pct`).
 */
export const MONITOR_METRIC_PREFIX = "_monitor.";
