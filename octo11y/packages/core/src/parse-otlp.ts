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
 */
export function getOtlpMetricKind(metric: OtlpMetric): "gauge" | "sum" | "histogram" {
  if (metric.gauge) return "gauge";
  if (metric.sum) return "sum";
  if (metric.histogram) return "histogram";
  throw new Error(`[parse-otlp] Unsupported OTLP metric kind for metric '${metric.name}'.`);
}

/**
 * Resolve the aggregation temporality for an OTLP sum or histogram metric.
 */
export function getOtlpTemporality(metric: OtlpMetric): OtlpAggregationTemporality {
  const raw = metric.sum?.aggregationTemporality ?? metric.histogram?.aggregationTemporality;
  if (raw === 1) return "delta";
  if (raw === 2) return "cumulative";
  return "unspecified";
}
