/**
 * o11ytsdb — Browser-native time-series database for OpenTelemetry data.
 *
 * Public API surface.
 */

export { ChunkedStore } from "./chunked-store.js";
export type { DecodedChunk } from "./codec.js";
// Codec — XOR-delta (Gorilla) compression
export {
  BitReader,
  BitWriter,
  decodeChunk,
  encodeChunk,
} from "./codec.js";
export { ColumnStore } from "./column-store.js";
// Storage backends
export { FlatStore } from "./flat-store.js";
export type {
  IngestResult,
  OtlpMetricsDocument,
  ParsedOtlpResult,
  PendingSeriesSamples,
} from "./ingest.js";
// OTLP ingest pipeline
export { flushSamplesToStorage, ingestOtlpJson, ingestOtlpObject, parseOtlpToSamples } from "./ingest.js";
export type { InternId } from "./interner.js";

// String interner + inverted index
export { Interner } from "./interner.js";
// Label index — shared label management for storage backends
export { LabelIndex } from "./label-index.js";
export { MemPostings } from "./postings.js";
// Query engine
export { ScanEngine } from "./query.js";
export { computeStats } from "./stats.js";
// Core types — pluggable interfaces for storage, codecs, and queries
export type {
  AggFn,
  ChunkStats,
  Codec,
  Labels,
  Matcher,
  QueryEngine,
  QueryOpts,
  QueryResult,
  RangeDecodeCodec,
  RangeDecodeResult,
  SeriesId,
  SeriesResult,
  StorageBackend,
  TimeRange,
  TimestampCodec,
  ValuesCodec,
} from "./types.js";

// WASM codec loader (ALP + XOR-delta + SIMD accelerators)
export { initWasmCodecs } from './wasm-codecs.js';
export type { WasmCodecs } from './wasm-codecs.js';

// Worker isolation + transfer protocol
export { WorkerClient } from "./worker-client.js";
export type {
  RequestEnvelope,
  ResponseEnvelope,
  TransferStrategy,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.js";
