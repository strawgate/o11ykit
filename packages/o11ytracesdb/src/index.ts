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

// Types
export type {
  AnyValue,
  InstrumentationScope,
  KeyValue,
  Resource,
  SpanEvent,
  SpanLink,
  SpanNode,
  SpanRecord,
  StreamId,
  StreamKey,
  Trace,
  TraceQueryOpts,
  TraceQueryResult,
} from "./types.js";
export { SpanKind, StatusCode } from "./types.js";

// Engine
export { TraceStore } from "./engine.js";
export type { TraceStoreOpts, TraceStoreStats } from "./engine.js";

// Chunk format
export { ChunkBuilder, deserializeChunk, serializeChunk } from "./chunk.js";
export type { Chunk, ChunkHeader, ChunkPolicy } from "./chunk.js";

// Codec
export { ColumnarTracePolicy } from "./codec-columnar.js";

// Bloom filter
export { createBloomFilter, bloomMayContain, bloomToBase64, bloomFromBase64 } from "./bloom.js";

// Query
export { assembleTrace, buildSpanTree, criticalPath, queryTraces, isAncestorOf, isDescendantOf, isSiblingOf, nestedSetDepth } from "./query.js";

// Stream registry
export { StreamRegistry } from "./stream.js";
