/**
 * o11ytsdb — Browser-native time-series database for OpenTelemetry data.
 *
 * This is the public API surface. Each module is exported as it passes
 * its benchmark gate.
 */

// M1: XOR-delta codec
export {
  encodeChunk,
  decodeChunk,
  BitWriter,
  BitReader,
} from './codec.js';
export type { DecodedChunk } from './codec.js';

// Experimentation framework — pluggable core
export type {
  Labels, SeriesId, TimeRange, Codec, ValuesCodec, TimestampCodec, ChunkStats, StatsCodec,
  RangeDecodeCodec, RangeDecodeResult,
  StorageBackend, QueryEngine, QueryOpts, QueryResult,
  SeriesResult, AggFn, Matcher,
} from './types.js';
export { FlatStore } from './flat-store.js';
export { ChunkedStore } from './chunked-store.js';
export { ColumnStore } from './column-store.js';
export { computeStats } from './stats.js';
export { ScanEngine } from './query.js';
export { Interner, fnv1a } from './interner.js';
export type { InternId } from './interner.js';
export { MemPostings } from './postings.js';
export { ingestOtlpJson } from './ingest.js';
export type { IngestResult, OtlpMetricsDocument } from './ingest.js';

export { WorkerClient } from './worker-client.js';
export type {
  TransferStrategy,
  RequestEnvelope,
  ResponseEnvelope,
  WorkerRequest,
  WorkerResponse,
} from './worker-protocol.js';

// M4: Chunk store — will export ChunkStore once gate passes
// M6: Query executor — will export query builder once gate passes
// M7: Histogram — will export histogram types once gate passes
