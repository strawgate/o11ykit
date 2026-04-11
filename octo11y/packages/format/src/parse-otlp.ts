import type {
  OtlpAggregationTemporality,
  OtlpAnyValue,
  OtlpAttribute,
  OtlpMetric,
  OtlpMetricsDocument,
} from "./types.js";

function anyValueToString(value: OtlpAnyValue | undefined): string {
  if (!value) return "";
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return String(value.boolValue);
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  return "";
}

/**
 * Flatten an OTLP `KeyValue` attribute array into a plain string record.
 *
 * All OTLP value types (string, bool, int, double) are coerced to strings.
 * Attributes with an absent or unrecognised value are stored as empty strings.
 *
 * @param attributes - Optional OTLP attribute array to flatten.
 * @returns A `Record<string, string>` mapping each attribute key to its string value.
 */
export function otlpAttributesToRecord(attributes: OtlpAttribute[] | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const attribute of attributes ?? []) {
    record[attribute.key] = anyValueToString(attribute.value);
  }
  return record;
}

/**
 * Parse and minimally validate an OTLP metrics JSON string.
 *
 * Validates that the top-level object contains a `resourceMetrics` array.
 * Throws if the input is not valid JSON or if `resourceMetrics` is absent/not
 * an array.
 *
 * @param input - Raw OTLP metrics JSON string.
 * @returns The parsed `OtlpMetricsDocument`.
 */
export function parseOtlp(input: string): OtlpMetricsDocument {
  const parsed: unknown = JSON.parse(input);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).resourceMetrics)
  ) {
    throw new Error("[parse-otlp] OTLP metrics JSON must contain a top-level resourceMetrics array.");
  }
  return parsed as OtlpMetricsDocument;
}

/**
 * Determine the data kind of an OTLP metric.
 *
 * Supported kinds are `"gauge"`, `"sum"`, and `"histogram"`.
 * Throws an `Error` if none of those fields are present on the metric.
 *
 * @param metric - The OTLP metric to inspect.
 * @returns `"gauge"`, `"sum"`, or `"histogram"`.
 */
export function getOtlpMetricKind(metric: OtlpMetric): "gauge" | "sum" | "histogram" {
  if (metric.gauge) return "gauge";
  if (metric.sum) return "sum";
  if (metric.histogram) return "histogram";
  throw new Error(`[parse-otlp] Unsupported OTLP metric kind for metric '${metric.name}'.`);
}

/**
 * Resolve the aggregation temporality for an OTLP sum or histogram metric.
 *
 * Maps the raw numeric OTLP enum to a human-readable string:
 * - `1` → `"delta"`
 * - `2` → `"cumulative"`
 * - anything else (including absent) → `"unspecified"`
 *
 * @param metric - The OTLP metric to inspect.
 * @returns The `OtlpAggregationTemporality` string value.
 */
export function getOtlpTemporality(metric: OtlpMetric): OtlpAggregationTemporality {
  const raw = metric.sum?.aggregationTemporality ?? metric.histogram?.aggregationTemporality;
  if (raw === 1) return "delta";
  if (raw === 2) return "cumulative";
  return "unspecified";
}


