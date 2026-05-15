/**
 * o11ytsdb — Browser-native time-series database for OpenTelemetry data.
 *
 * Public API surface.
 */

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
// Worker isolation + transfer protocol
export {
  toTsdbLatestValueModel,
  toTsdbLineSeriesModel,
  toTsdbWideTableModel,
} from "./adapters.js";
export type { DecodedChunk } from "./codec.js";
// Codec — XOR-delta (Gorilla) compression
export {
  BitReader,
  BitWriter,
  bitsToFloat,
  clz64,
  ctz64,
  decodeChunk,
  encodeChunk,
  floatToBits,
} from "./codec.js";
export { FlatStore } from "./flat-store.js";
// TODO(#178): Ingest exports removed — API mismatch with @otlpkit/otlpjson.
// Re-export once the ingest module is fixed.
// export type { IngestResult, OtlpMetricsDocument, ParsedOtlpResult, PendingSeriesSamples } from "./ingest.js";
// export { flushSamplesToStorage, ingestOtlpJson, ingestOtlpObject, parseOtlpToSamples } from "./ingest.js";
// Label index — shared label management for storage backends
export { LabelIndex } from "./label-index.js";
export { MemPostings } from "./postings.js";
// Query engine
export { resolveStep, ScanEngine } from "./query.js";
// Storage backends
export { ReferenceChunkedStore } from "./reference-chunked-store.js";
export { ReferenceColumnStore } from "./reference-column-store.js";
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
  SeriesAppend,
  SeriesId,
  SeriesResult,
  StorageBackend,
  TimeRange,
  TimestampCodec,
  TransformOp,
  ValuesCodec,
} from "./types.js";
// TODO(#179): WASM codec exports removed — binaries not in repo.
// Re-export once WASM binaries are available.
// export type { WasmCodecs } from "./wasm-codecs.js";
// export { initWasmCodecs } from "./wasm-codecs.js";
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
