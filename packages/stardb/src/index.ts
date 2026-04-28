// stardb — shared core (`*db`) for the o11ykit family of in-memory
// OpenTelemetry databases. Hosts the byte / string / integer codec
// interfaces and a small set of baseline implementations both
// `o11ylogsdb` and (in time) `o11ytsdb` and `o11ytracesdb` consume.

export { ByteBuf, ByteReader } from "./binary.js";
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
export { StreamRegistry } from "./stream.js";
export type {
  AnyValue,
  InstrumentationScope,
  KeyValue,
  Resource,
  SeverityText,
  StreamId,
} from "./types.js";
export { bytesEqual, bytesToHex, fnv1aBytes, hexToBytes, nowMillis } from "./utils.js";
