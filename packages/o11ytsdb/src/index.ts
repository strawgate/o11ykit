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

// M2: String interner — will export Interner once gate passes
// M3: Inverted index — will export MemPostings once gate passes
// M4: Chunk store — will export ChunkStore once gate passes
// M5: Ingest pipeline — will export ingest() once gate passes
// M6: Query executor — will export query builder once gate passes
// M7: Histogram — will export histogram types once gate passes
// M8: Worker + DB — will export O11yTSDB once gate passes
