/**
 * OTLP protobuf encoder.
 *
 * Encodes OTLP JSON export requests to protobuf wire format.
 * We use protobufjs with a .proto schema for correctness.
 * Falls back to JSON encoding if protobuf build fails.
 */

import protobuf from "protobufjs";
import type { OtlpExportRequest } from "./generator.js";

// Build the OTLP protobuf schema dynamically since we don't want to
// vendor .proto files. This matches the opentelemetry-proto spec.
const PROTO_SCHEMA = `
syntax = "proto3";

package opentelemetry.proto.collector.metrics.v1;

message ExportMetricsServiceRequest {
  repeated opentelemetry.proto.metrics.v1.ResourceMetrics resource_metrics = 1;
}

message ExportMetricsServiceResponse {}

package opentelemetry.proto.metrics.v1;

message ResourceMetrics {
  opentelemetry.proto.resource.v1.Resource resource = 1;
  repeated ScopeMetrics scope_metrics = 2;
}

message ScopeMetrics {
  opentelemetry.proto.common.v1.InstrumentationScope scope = 1;
  repeated Metric metrics = 2;
}

message Metric {
  string name = 1;
  string description = 2;
  string unit = 3;
  oneof data {
    Gauge gauge = 5;
    Sum sum = 7;
    Histogram histogram = 9;
    ExponentialHistogram exponential_histogram = 10;
    Summary summary = 11;
  }
}

message Gauge {
  repeated NumberDataPoint data_points = 1;
}

message Sum {
  repeated NumberDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
  bool is_monotonic = 3;
}

message Histogram {
  repeated HistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}

message ExponentialHistogram {
  repeated ExponentialHistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}

message Summary {
  repeated SummaryDataPoint data_points = 1;
}

enum AggregationTemporality {
  AGGREGATION_TEMPORALITY_UNSPECIFIED = 0;
  AGGREGATION_TEMPORALITY_DELTA = 1;
  AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
}

message NumberDataPoint {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  oneof value {
    double as_double = 4;
    sfixed64 as_int = 6;
  }
}

message HistogramDataPoint {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 9;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated fixed64 bucket_counts = 6;
  repeated double explicit_bounds = 7;
}

message ExponentialHistogramDataPoint {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 1;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  sint32 scale = 6;
  fixed64 zero_count = 7;
  Buckets positive = 8;
  Buckets negative = 9;

  message Buckets {
    sint32 offset = 1;
    repeated uint64 bucket_counts = 2;
  }
}

message SummaryDataPoint {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated ValueAtQuantile quantile_values = 6;

  message ValueAtQuantile {
    double quantile = 1;
    double value = 2;
  }
}

package opentelemetry.proto.resource.v1;

message Resource {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 1;
}

package opentelemetry.proto.common.v1;

message InstrumentationScope {
  string name = 1;
  string version = 2;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
  }
}
`;

let _requestType: protobuf.Type | null = null;

async function getRequestType(): Promise<protobuf.Type> {
  if (_requestType) return _requestType;
  const root = protobuf.parse(PROTO_SCHEMA, { keepCase: false }).root;
  _requestType = root.lookupType(
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest"
  );
  return _requestType;
}

/**
 * Convert an OTLP JSON export request to the wire-format object that
 * protobufjs expects (camelCase keys, BigInt timestamps as numbers).
 */
function toProtoPayload(req: OtlpExportRequest): Record<string, unknown> {
  return {
    resourceMetrics: req.resourceMetrics.map((rm) => ({
      resource: {
        attributes: rm.resource.attributes.map(kvToProto),
      },
      scopeMetrics: rm.scopeMetrics.map((sm) => ({
        scope: { name: sm.scope.name, version: sm.scope.version },
        metrics: sm.metrics.map((m) => metricToProto(m as never)),
      })),
    })),
  };
}

function kvToProto(kv: { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number } }) {
  const v: Record<string, unknown> = {};
  if (kv.value.stringValue !== undefined) v.stringValue = kv.value.stringValue;
  if (kv.value.intValue !== undefined) v.intValue = Long(kv.value.intValue);
  if (kv.value.doubleValue !== undefined) v.doubleValue = kv.value.doubleValue;
  return { key: kv.key, value: v };
}

function Long(s: string): number {
  return Number(s);
}

function nanoToLong(s: string): bigint {
  return BigInt(s);
}

type AnyDP = Record<string, unknown>;

function metricToProto(m: {
  name: string;
  unit?: string;
  description?: string;
  gauge?: { dataPoints: AnyDP[] };
  sum?: { dataPoints: AnyDP[]; aggregationTemporality: number; isMonotonic: boolean };
  histogram?: { dataPoints: AnyDP[]; aggregationTemporality: number };
  exponentialHistogram?: { dataPoints: AnyDP[]; aggregationTemporality: number };
  summary?: { dataPoints: AnyDP[] };
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: m.name,
    unit: m.unit || "",
    description: m.description || "",
  };

  if (m.gauge) {
    out.gauge = { dataPoints: m.gauge.dataPoints.map(numberDpToProto) };
  }
  if (m.sum) {
    out.sum = {
      dataPoints: m.sum.dataPoints.map(numberDpToProto),
      aggregationTemporality: m.sum.aggregationTemporality,
      isMonotonic: m.sum.isMonotonic,
    };
  }
  if (m.histogram) {
    out.histogram = {
      dataPoints: m.histogram.dataPoints.map(histDpToProto),
      aggregationTemporality: m.histogram.aggregationTemporality,
    };
  }
  if (m.exponentialHistogram) {
    out.exponentialHistogram = {
      dataPoints: m.exponentialHistogram.dataPoints.map(expHistDpToProto),
      aggregationTemporality: m.exponentialHistogram.aggregationTemporality,
    };
  }
  if (m.summary) {
    out.summary = { dataPoints: m.summary.dataPoints.map(summaryDpToProto) };
  }

  return out;
}

function numberDpToProto(dp: Record<string, unknown>): Record<string, unknown> {
  const attrs = (dp.attributes as { key: string; value: { stringValue?: string } }[]) || [];
  return {
    attributes: attrs.map(kvToProto),
    startTimeUnixNano: nanoToLong(dp.startTimeUnixNano as string),
    timeUnixNano: nanoToLong(dp.timeUnixNano as string),
    ...(dp.asDouble !== undefined ? { asDouble: dp.asDouble } : {}),
    ...(dp.asInt !== undefined ? { asInt: Long(dp.asInt as string) } : {}),
  };
}

function histDpToProto(dp: Record<string, unknown>): Record<string, unknown> {
  const attrs = (dp.attributes as { key: string; value: { stringValue?: string } }[]) || [];
  return {
    attributes: attrs.map(kvToProto),
    startTimeUnixNano: nanoToLong(dp.startTimeUnixNano as string),
    timeUnixNano: nanoToLong(dp.timeUnixNano as string),
    count: Long(dp.count as string),
    sum: dp.sum,
    bucketCounts: (dp.bucketCounts as string[]).map(Long),
    explicitBounds: dp.explicitBounds,
  };
}

function expHistDpToProto(dp: Record<string, unknown>): Record<string, unknown> {
  const attrs = (dp.attributes as { key: string; value: { stringValue?: string } }[]) || [];
  const positive = dp.positive as { offset: number; bucketCounts: string[] };
  const negative = dp.negative as { offset: number; bucketCounts: string[] };
  return {
    attributes: attrs.map(kvToProto),
    startTimeUnixNano: nanoToLong(dp.startTimeUnixNano as string),
    timeUnixNano: nanoToLong(dp.timeUnixNano as string),
    count: Long(dp.count as string),
    sum: dp.sum,
    scale: dp.scale,
    zeroCount: Long(dp.zeroCount as string),
    positive: {
      offset: positive.offset,
      bucketCounts: positive.bucketCounts.map(Long),
    },
    negative: {
      offset: negative.offset,
      bucketCounts: negative.bucketCounts.map(Long),
    },
  };
}

function summaryDpToProto(dp: Record<string, unknown>): Record<string, unknown> {
  const attrs = (dp.attributes as { key: string; value: { stringValue?: string } }[]) || [];
  return {
    attributes: attrs.map(kvToProto),
    startTimeUnixNano: nanoToLong(dp.startTimeUnixNano as string),
    timeUnixNano: nanoToLong(dp.timeUnixNano as string),
    count: Long(dp.count as string),
    sum: dp.sum,
    quantileValues: (dp.quantileValues as { quantile: number; value: number }[]),
  };
}

/**
 * Encode an OTLP export request to protobuf bytes.
 */
export async function encodeProtobuf(req: OtlpExportRequest): Promise<Uint8Array> {
  const RequestType = await getRequestType();
  const payload = toProtoPayload(req);
  const msg = RequestType.create(payload);
  return RequestType.encode(msg).finish();
}

/**
 * Encode an OTLP export request to JSON bytes (for endpoints that accept JSON).
 */
export function encodeJson(req: OtlpExportRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(req));
}
