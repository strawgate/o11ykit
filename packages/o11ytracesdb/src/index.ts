/**
 * o11ytracesdb — Browser-native traces database for OpenTelemetry data.
 *
 * Columnar compression for distributed traces: dictionary encoding for
 * span names and attributes, delta-of-delta for timestamps, raw bytes for
 * trace/span IDs with BF8 bloom filter acceleration. Stores spans as rows,
 * assembles traces at query time.
 *
 * Part of the o11ykit suite:
 *   o11ytsdb (metrics) → o11ylogsdb (logs) → o11ytracesdb (traces)
 */

// Bloom filter — imported from stardb shared core
export { bloomFromBase64, bloomMayContain, bloomToBase64, createBloomFilter } from "stardb";
export type {
  AggregationGroup,
  AggregationPipelineResult,
  AggregationResult,
  AggregationSpec,
} from "./aggregate.js";
// Aggregation pipeline
export { aggregateSpans, aggregateTraces } from "./aggregate.js";
export type { Chunk, ChunkHeader, ChunkPolicy } from "./chunk.js";

// Chunk format
export { ChunkBuilder, deserializeChunk, serializeChunk } from "./chunk.js";
// Codec
export { ColumnarTracePolicy } from "./codec-columnar.js";
export type { REDMetrics, ServiceGraphEdge, TimeWindow } from "./correlate.js";
// Cross-signal correlation
export {
  computeServiceGraph,
  deriveREDMetrics,
  extractServiceNames,
  extractTraceIds,
  spanTimeWindow,
  traceTimeWindow,
} from "./correlate.js";
export type { TraceStoreOpts, TraceStoreStats } from "./engine.js";
// Engine
export { TraceStore } from "./engine.js";
// Query
export {
  assembleTrace,
  buildSpanTree,
  criticalPath,
  isAncestorOf,
  isDescendantOf,
  isSiblingOf,
  nestedSetDepth,
  queryTraces,
} from "./query.js";
// Query builder
export { TraceQuery } from "./query-builder.js";
// Stream registry
export { StreamRegistry } from "./stream.js";
// Types
export type {
  AnyValue,
  AttributeOp,
  AttributePredicate,
  InstrumentationScope,
  KeyValue,
  Resource,
  SortOrder,
  SpanEvent,
  SpanLink,
  SpanNode,
  SpanPredicate,
  SpanRecord,
  StreamId,
  StreamKey,
  StructuralPredicate,
  StructuralRelation,
  Trace,
  TraceIntrinsics,
  TraceQueryOpts,
  TraceQueryResult,
  TraceSortField,
} from "./types.js";
export { SpanKind, StatusCode } from "./types.js";
