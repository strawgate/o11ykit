/**
 * o11ytsdb — Browser-native time-series database for OpenTelemetry data.
 *
 * Public API surface.
 */

// Codec — XOR-delta (Gorilla) compression
export {
  encodeChunk,
  decodeChunk,
  BitWriter,
  BitReader,
} from './codec.js';
export type { DecodedChunk } from './codec.js';

// Core types — pluggable interfaces for storage, codecs, and queries
export type {
  Labels, SeriesId, TimeRange, Codec, ValuesCodec, TimestampCodec, ChunkStats,
  RangeDecodeCodec, RangeDecodeResult,
  StorageBackend, QueryEngine, QueryOpts, QueryResult,
  SeriesResult, AggFn, Matcher,
} from './types.js';

// Storage backends
export { FlatStore } from './flat-store.js';
export { ChunkedStore } from './chunked-store.js';
export { ColumnStore } from './column-store.js';
export { computeStats } from './stats.js';

// Query engine
export { ScanEngine } from './query.js';

// String interner + inverted index
export { Interner } from './interner.js';
export type { InternId } from './interner.js';
export { MemPostings } from './postings.js';

// Label index — shared label management for storage backends
export { LabelIndex } from './label-index.js';

// OTLP ingest pipeline
export { ingestOtlpJson, ingestOtlpObject, parseOtlpToSamples, flushSamplesToStorage } from './ingest.js';
export type { IngestResult, ParsedOtlpResult, PendingSeriesSamples, OtlpMetricsDocument } from './ingest.js';

// WASM codec loader (ALP + XOR-delta + SIMD accelerators)
export { initWasmCodecs } from './wasm-codecs.js';
export type { WasmCodecs } from './wasm-codecs.js';

// Worker isolation + transfer protocol
export { WorkerClient } from './worker-client.js';
export type {
  TransferStrategy,
  RequestEnvelope,
  ResponseEnvelope,
  WorkerRequest,
  WorkerResponse,
} from './worker-protocol.js';
