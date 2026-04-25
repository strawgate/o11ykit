/**
 * o11ytsdb — Browser-native time-series database for OpenTelemetry data.
 *
 * Public API surface.
 */

// Worker isolation + transfer protocol
export {
  toTsdbLatestValueModel,
  toTsdbLineSeriesModel,
  toTsdbWideTableModel,
} from "./adapters.js";
export type {
  TsdbAdapterOptions,
  TsdbLatestValueModel,
  TsdbLatestValueRow,
  TsdbLineSeries,
  TsdbLineSeriesModel,
  TsdbPoint,
  TsdbTimestampUnit,
  TsdbWideTableModel,
  TsdbWideTableRow,
} from "./adapters.js";
export { BackpressureController } from "./backpressure.js";
export type { DecodedChunk } from "./codec.js";
// Codec — XOR-delta (Gorilla) compression
export {
  BitReader,
  BitWriter,
  decodeChunk,
  encodeChunk,
} from "./codec.js";
// Storage backends
export { FlatStore } from "./flat-store.js";
export type {
  IngestResult,
  OtlpMetricsDocument,
  ParsedOtlpResult,
  PendingSeriesSamples,
} from "./ingest.js";
// OTLP ingest pipeline
export {
  flushSamplesToStorage,
  ingestOtlpJson,
  ingestOtlpObject,
  parseOtlpToSamples,
} from "./ingest.js";
export type { InternId } from "./interner.js";
// String interner + inverted index
export { Interner } from "./interner.js";
// Label index — shared label management for storage backends
export { LabelIndex } from "./label-index.js";
export { MemPostings } from "./postings.js";
// Query engine
export { ScanEngine } from "./query.js";
export { RowGroupStore } from "./row-group-store.js";
export { computeStats } from "./stats.js";
export { TieredRowGroupStore } from "./tiered-row-group-store.js";
// Core types — pluggable interfaces for storage, codecs, and queries
export type {
  AggFn,
  ChunkStats,
  Codec,
  ExecutedQuery,
  Labels,
  Matcher,
  MatchOp,
  MaterializedQueryResult,
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
  TransformOp,
  ValuesCodec,
} from "./types.js";
export type { WasmCodecs } from "./wasm-codecs.js";
// WASM codec loader (ALP + XOR-delta + SIMD accelerators)
export { initWasmCodecs } from "./wasm-codecs.js";
export { WorkerClient } from "./worker-client.js";
export type {
  BatchIngestRequest,
  BatchIngestResponse,
  RequestEnvelope,
  ResponseEnvelope,
  TransferStrategy,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.js";
