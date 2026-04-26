// o11ylogsdb — public API.
//
// Scaffolding: the engine wires up the chunk format, codec registry,
// stream registry, and a default body classifier. Real codec
// implementations land via M0–M2 (see ../PLAN.md).

export type { Chunk, ChunkHeader, ChunkPolicy } from "./chunk.js";
export {
  CHUNK_VERSION,
  ChunkBuilder,
  DefaultChunkPolicy,
  deserializeChunk,
  readRecords,
  serializeChunk,
} from "./chunk.js";
export type { BodyClassifier, TemplateExtractor } from "./classify.js";
export { defaultClassifier, TemplatedClassifier } from "./classify.js";
export type { Codec, IntCodec, StringCodec } from "./codec.js";
export { CodecRegistry } from "./codec.js";
export {
  defaultRegistry,
  GzipCodec,
  lengthPrefixStringCodec,
  rawCodec,
  rawInt64Codec,
  ZstdCodec,
} from "./codec-baseline.js";
export type {
  ColumnarDrainPolicyConfig,
  ColumnarPolicyConfig,
} from "./codec-columnar.js";
export { ColumnarDrainPolicy, ColumnarRawPolicy } from "./codec-columnar.js";
export type { DrainChunkPolicyConfig } from "./codec-drain.js";
export { DrainChunkPolicy } from "./codec-drain.js";
export type { TypedColumnarDrainPolicyConfig } from "./codec-typed.js";
export { TypedColumnarDrainPolicy } from "./codec-typed.js";
export type { CompactStats } from "./compact.js";
export { compactChunk } from "./compact.js";
export type { DrainConfig } from "./drain.js";
export {
  DRAIN_DEFAULT_CONFIG,
  Drain,
  mergeTemplate,
  PARAM_STR,
  similarity,
  tokenize,
} from "./drain.js";
export type { IngestStats, LogStoreConfig, StoreStats } from "./engine.js";
export { LogStore } from "./engine.js";
export type { QueryResult, QuerySpec, QueryStats } from "./query.js";
export { query, queryStream } from "./query.js";
export { StreamRegistry } from "./stream.js";
export type {
  AnyValue,
  BodyKind,
  InstrumentationScope,
  KeyValue,
  LogRecord,
  Resource,
  SeverityText,
  StreamId,
  StreamKey,
} from "./types.js";
export { VERSION } from "./version.js";
