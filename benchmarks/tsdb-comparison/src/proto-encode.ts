/**
 * OTLP protobuf encoder.
 *
 * Encodes OTLP JSON export requests to protobuf wire format using
 * programmatic protobufjs types (avoids multi-package .proto parsing issues).
 */

import protobuf from "protobufjs";
import type { OtlpExportRequest } from "./generator.js";

// ── Build OTLP schema programmatically ─────────────────────────────────

function buildSchema(): protobuf.Root {
  const root = new protobuf.Root();

  // Common types
  const anyValue = new protobuf.Type("AnyValue")
    .add(new protobuf.OneOf("value")
      .add(new protobuf.Field("stringValue", 1, "string"))
      .add(new protobuf.Field("boolValue", 2, "bool"))
      .add(new protobuf.Field("intValue", 3, "int64"))
      .add(new protobuf.Field("doubleValue", 4, "double")));

  const keyValue = new protobuf.Type("KeyValue")
    .add(new protobuf.Field("key", 1, "string"))
    .add(new protobuf.Field("value", 2, "AnyValue"));

  const instrScope = new protobuf.Type("InstrumentationScope")
    .add(new protobuf.Field("name", 1, "string"))
    .add(new protobuf.Field("version", 2, "string"));

  const resource = new protobuf.Type("Resource")
    .add(new protobuf.Field("attributes", 1, "KeyValue", "repeated"));

  // Metric data point types
  const numberDp = new protobuf.Type("NumberDataPoint")
    .add(new protobuf.Field("attributes", 7, "KeyValue", "repeated"))
    .add(new protobuf.Field("startTimeUnixNano", 2, "fixed64"))
    .add(new protobuf.Field("timeUnixNano", 3, "fixed64"))
    .add(new protobuf.OneOf("value")
      .add(new protobuf.Field("asDouble", 4, "double"))
      .add(new protobuf.Field("asInt", 6, "sfixed64")));

  const histDp = new protobuf.Type("HistogramDataPoint")
    .add(new protobuf.Field("attributes", 9, "KeyValue", "repeated"))
    .add(new protobuf.Field("startTimeUnixNano", 2, "fixed64"))
    .add(new protobuf.Field("timeUnixNano", 3, "fixed64"))
    .add(new protobuf.Field("count", 4, "fixed64"))
    .add(new protobuf.Field("sum", 5, "double"))
    .add(new protobuf.Field("bucketCounts", 6, "fixed64", "repeated"))
    .add(new protobuf.Field("explicitBounds", 7, "double", "repeated"));

  const expBuckets = new protobuf.Type("Buckets")
    .add(new protobuf.Field("offset", 1, "sint32"))
    .add(new protobuf.Field("bucketCounts", 2, "uint64", "repeated"));

  const expHistDp = new protobuf.Type("ExponentialHistogramDataPoint")
    .add(new protobuf.Field("attributes", 1, "KeyValue", "repeated"))
    .add(new protobuf.Field("startTimeUnixNano", 2, "fixed64"))
    .add(new protobuf.Field("timeUnixNano", 3, "fixed64"))
    .add(new protobuf.Field("count", 4, "fixed64"))
    .add(new protobuf.Field("sum", 5, "double"))
    .add(new protobuf.Field("scale", 6, "sint32"))
    .add(new protobuf.Field("zeroCount", 7, "fixed64"))
    .add(new protobuf.Field("positive", 8, "Buckets"))
    .add(new protobuf.Field("negative", 9, "Buckets"));
  expHistDp.add(expBuckets);

  const quantileVal = new protobuf.Type("ValueAtQuantile")
    .add(new protobuf.Field("quantile", 1, "double"))
    .add(new protobuf.Field("value", 2, "double"));

  const summaryDp = new protobuf.Type("SummaryDataPoint")
    .add(new protobuf.Field("attributes", 7, "KeyValue", "repeated"))
    .add(new protobuf.Field("startTimeUnixNano", 2, "fixed64"))
    .add(new protobuf.Field("timeUnixNano", 3, "fixed64"))
    .add(new protobuf.Field("count", 4, "fixed64"))
    .add(new protobuf.Field("sum", 5, "double"))
    .add(new protobuf.Field("quantileValues", 6, "ValueAtQuantile", "repeated"));
  summaryDp.add(quantileVal);

  const aggTemp = new protobuf.Enum("AggregationTemporality", {
    AGGREGATION_TEMPORALITY_UNSPECIFIED: 0,
    AGGREGATION_TEMPORALITY_DELTA: 1,
    AGGREGATION_TEMPORALITY_CUMULATIVE: 2,
  });

  // Metric container types
  const gauge = new protobuf.Type("Gauge")
    .add(new protobuf.Field("dataPoints", 1, "NumberDataPoint", "repeated"));
  const sum = new protobuf.Type("Sum")
    .add(new protobuf.Field("dataPoints", 1, "NumberDataPoint", "repeated"))
    .add(new protobuf.Field("aggregationTemporality", 2, "AggregationTemporality"))
    .add(new protobuf.Field("isMonotonic", 3, "bool"));
  const histogram = new protobuf.Type("Histogram")
    .add(new protobuf.Field("dataPoints", 1, "HistogramDataPoint", "repeated"))
    .add(new protobuf.Field("aggregationTemporality", 2, "AggregationTemporality"));
  const expHistogram = new protobuf.Type("ExponentialHistogram")
    .add(new protobuf.Field("dataPoints", 1, "ExponentialHistogramDataPoint", "repeated"))
    .add(new protobuf.Field("aggregationTemporality", 2, "AggregationTemporality"));
  const summary = new protobuf.Type("Summary")
    .add(new protobuf.Field("dataPoints", 1, "SummaryDataPoint", "repeated"));

  const metric = new protobuf.Type("Metric")
    .add(new protobuf.Field("name", 1, "string"))
    .add(new protobuf.Field("description", 2, "string"))
    .add(new protobuf.Field("unit", 3, "string"))
    .add(new protobuf.OneOf("data")
      .add(new protobuf.Field("gauge", 5, "Gauge"))
      .add(new protobuf.Field("sum", 7, "Sum"))
      .add(new protobuf.Field("histogram", 9, "Histogram"))
      .add(new protobuf.Field("exponentialHistogram", 10, "ExponentialHistogram"))
      .add(new protobuf.Field("summary", 11, "Summary")));

  const scopeMetrics = new protobuf.Type("ScopeMetrics")
    .add(new protobuf.Field("scope", 1, "InstrumentationScope"))
    .add(new protobuf.Field("metrics", 2, "Metric", "repeated"));

  const resourceMetrics = new protobuf.Type("ResourceMetrics")
    .add(new protobuf.Field("resource", 1, "Resource"))
    .add(new protobuf.Field("scopeMetrics", 2, "ScopeMetrics", "repeated"));

  const exportReq = new protobuf.Type("ExportMetricsServiceRequest")
    .add(new protobuf.Field("resourceMetrics", 1, "ResourceMetrics", "repeated"));

  // Add all types to root in a flat namespace (types reference each other by name)
  root.add(anyValue);
  root.add(keyValue);
  root.add(instrScope);
  root.add(resource);
  root.add(numberDp);
  root.add(histDp);
  root.add(expHistDp);
  root.add(summaryDp);
  root.add(aggTemp);
  root.add(gauge);
  root.add(sum);
  root.add(histogram);
  root.add(expHistogram);
  root.add(summary);
  root.add(metric);
  root.add(scopeMetrics);
  root.add(resourceMetrics);
  root.add(exportReq);

  return root;
}

let _requestType: protobuf.Type | null = null;

function getRequestType(): protobuf.Type {
  if (_requestType) return _requestType;
  const root = buildSchema();
  _requestType = root.lookupType("ExportMetricsServiceRequest");
  return _requestType;
}

// ── Payload conversion helpers ─────────────────────────────────────────

type KV = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number } };

function kvToProto(kv: KV) {
  const v: Record<string, unknown> = {};
  if (kv.value.stringValue !== undefined) v.stringValue = kv.value.stringValue;
  if (kv.value.intValue !== undefined) v.intValue = Number(kv.value.intValue);
  if (kv.value.doubleValue !== undefined) v.doubleValue = kv.value.doubleValue;
  return { key: kv.key, value: v };
}

function nanoToLong(s: string): protobuf.Long {
  const n = BigInt(s);
  return new protobuf.util.Long(Number(n & 0xFFFFFFFFn), Number((n >> 32n) & 0xFFFFFFFFn), true);
}

function numToLong(s: string): protobuf.Long {
  const n = BigInt(s);
  return new protobuf.util.Long(Number(n & 0xFFFFFFFFn), Number((n >> 32n) & 0xFFFFFFFFn), true);
}

type AnyDP = Record<string, unknown>;

function toProtoPayload(req: OtlpExportRequest): Record<string, unknown> {
  return {
    resourceMetrics: req.resourceMetrics.map((rm) => ({
      resource: { attributes: (rm.resource.attributes as KV[]).map(kvToProto) },
      scopeMetrics: rm.scopeMetrics.map((sm) => ({
        scope: { name: sm.scope.name, version: sm.scope.version },
        metrics: sm.metrics.map((m) => metricToProto(m as never)),
      })),
    })),
  };
}

function metricToProto(m: {
  name: string; unit?: string; description?: string;
  gauge?: { dataPoints: AnyDP[] };
  sum?: { dataPoints: AnyDP[]; aggregationTemporality: number; isMonotonic: boolean };
  histogram?: { dataPoints: AnyDP[]; aggregationTemporality: number };
  exponentialHistogram?: { dataPoints: AnyDP[]; aggregationTemporality: number };
  summary?: { dataPoints: AnyDP[] };
}): Record<string, unknown> {
  const out: Record<string, unknown> = { name: m.name, unit: m.unit || "", description: m.description || "" };
  if (m.gauge) out.gauge = { dataPoints: m.gauge.dataPoints.map(numberDpToProto) };
  if (m.sum) out.sum = { dataPoints: m.sum.dataPoints.map(numberDpToProto), aggregationTemporality: m.sum.aggregationTemporality, isMonotonic: m.sum.isMonotonic };
  if (m.histogram) out.histogram = { dataPoints: m.histogram.dataPoints.map(histDpToProto), aggregationTemporality: m.histogram.aggregationTemporality };
  if (m.exponentialHistogram) out.exponentialHistogram = { dataPoints: m.exponentialHistogram.dataPoints.map(expHistDpToProto), aggregationTemporality: m.exponentialHistogram.aggregationTemporality };
  if (m.summary) out.summary = { dataPoints: m.summary.dataPoints.map(summaryDpToProto) };
  return out;
}

function numberDpToProto(dp: AnyDP): Record<string, unknown> {
  return {
    attributes: ((dp.attributes as KV[]) || []).map(kvToProto),
    startTimeUnixNano: nanoToLong(dp.startTimeUnixNano as string),
    timeUnixNano: nanoToLong(dp.timeUnixNano as string),
    ...(dp.asDouble !== undefined ? { asDouble: dp.asDouble } : {}),
    ...(dp.asInt !== undefined ? { asInt: numToLong(dp.asInt as string) } : {}),
  };
}

function histDpToProto(dp: AnyDP): Record<string, unknown> {
  return {
    attributes: ((dp.attributes as KV[]) || []).map(kvToProto),
    startTimeUnixNano: nanoToLong(dp.startTimeUnixNano as string),
    timeUnixNano: nanoToLong(dp.timeUnixNano as string),
    count: numToLong(dp.count as string),
    sum: dp.sum,
    bucketCounts: (dp.bucketCounts as string[]).map((s) => numToLong(s)),
    explicitBounds: dp.explicitBounds,
  };
}

function expHistDpToProto(dp: AnyDP): Record<string, unknown> {
  const positive = dp.positive as { offset: number; bucketCounts: string[] };
  const negative = dp.negative as { offset: number; bucketCounts: string[] };
  return {
    attributes: ((dp.attributes as KV[]) || []).map(kvToProto),
    startTimeUnixNano: nanoToLong(dp.startTimeUnixNano as string),
    timeUnixNano: nanoToLong(dp.timeUnixNano as string),
    count: numToLong(dp.count as string),
    sum: dp.sum,
    scale: dp.scale,
    zeroCount: numToLong(dp.zeroCount as string),
    positive: { offset: positive.offset, bucketCounts: positive.bucketCounts.map((s) => numToLong(s)) },
    negative: { offset: negative.offset, bucketCounts: negative.bucketCounts.map((s) => numToLong(s)) },
  };
}

function summaryDpToProto(dp: AnyDP): Record<string, unknown> {
  return {
    attributes: ((dp.attributes as KV[]) || []).map(kvToProto),
    startTimeUnixNano: nanoToLong(dp.startTimeUnixNano as string),
    timeUnixNano: nanoToLong(dp.timeUnixNano as string),
    count: numToLong(dp.count as string),
    sum: dp.sum,
    quantileValues: dp.quantileValues,
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Encode an OTLP export request to protobuf bytes.
 */
export function encodeProtobuf(req: OtlpExportRequest): Uint8Array {
  const RequestType = getRequestType();
  const payload = toProtoPayload(req);
  const errMsg = RequestType.verify(payload);
  if (errMsg) throw new Error(`Protobuf verify: ${errMsg}`);
  const msg = RequestType.create(payload);
  return RequestType.encode(msg).finish();
}

/**
 * Encode an OTLP export request to JSON bytes (for endpoints that accept JSON).
 */
export function encodeJson(req: OtlpExportRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(req));
}
