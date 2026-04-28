// stardb — shared core (`*db`) for the o11ykit family of in-memory
// OpenTelemetry databases. Hosts the byte / string / integer codec
// interfaces and a small set of baseline implementations both
// `o11ylogsdb` and (in time) `o11ytsdb` and `o11ytracesdb` consume.

export { anyValueEquals, anyValueToJson, findAttribute, jsonToAnyValue } from "./any-value.js";
export { decodeAnyValue, encodeAnyValue, ValueTag } from "./any-value-binary.js";
export { BackpressureController } from "./backpressure.js";
export { ByteBuf, ByteReader } from "./binary.js";
export { lowerBound, upperBound } from "./binary-search.js";
export { bloomFromBase64, bloomMayContain, bloomToBase64, createBloomFilter } from "./bloom.js";
export type { ChunkWireOptions } from "./chunk-wire.js";
export { chunkWireSize, deserializeChunkWire, serializeChunkWire } from "./chunk-wire.js";
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
export type { InternId } from "./interner.js";
export { Interner } from "./interner.js";
export { StreamRegistry } from "./stream.js";
export type {
  AnyValue,
  InstrumentationScope,
  KeyValue,
  Resource,
  SeverityText,
  StreamId,
  StreamKey,
} from "./types.js";
export {
  buildDictWithIndex,
  bytesEqual,
  bytesToHex,
  bytesToUuid,
  fnv1aBytes,
  hexToBytes,
  nowMillis,
  timeRangeOverlaps,
  uint8IndexOf,
  uuidToBytes,
} from "./utils.js";
