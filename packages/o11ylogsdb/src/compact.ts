/**
 * compact — re-encode a chunk's body payload under a different
 * codec without touching the record-level shape.
 *
 * The chunk format separates "codec wrapping" (the bytes codec
 * named in `header.codecName`, applied to the policy's pre-codec
 * payload) from "policy-level encoding" (Drain templates, slot
 * types, sidecar NDJSON — all of which produce the pre-codec
 * payload). Compaction operates at the codec layer only:
 *
 *   1. Decode `chunk.payload` via codec X → raw pre-codec bytes.
 *   2. Encode those raw bytes via codec Y → new payload.
 *   3. Emit a new Chunk with the same header but `codecName = Y`
 *      and `payloadBytes = new.length`.
 *
 * No records are re-decoded; no Drain pass; no slot reclassification.
 * Cheap and lossless. The output chunk's record-level decode
 * (`readRecords`) returns identical records to the input chunk's.
 *
 * Use cases:
 *   - M5 background tier promotion: hot ingest at z3 → cold storage
 *     at z19. Saves storage at the cost of CPU.
 *   - Re-codec on a format upgrade (e.g. swap zstd for FSST in a
 *     future M0/M1 world).
 */

import type { Chunk } from "./chunk.js";
import type { CodecRegistry } from "./codec.js";

export interface CompactStats {
  inputBytes: number;
  outputBytes: number;
  decodeMillis: number;
  encodeMillis: number;
}

/**
 * Re-encode a chunk's payload under `newCodecName`. Returns a fresh
 * Chunk; the input chunk is not modified. Both codecs must be
 * registered in `registry`.
 *
 * No-op if `chunk.header.codecName === newCodecName` (returns the
 * same chunk reference, stats reflect zero work).
 */
export function compactChunk(
  chunk: Chunk,
  registry: CodecRegistry,
  newCodecName: string
): { chunk: Chunk; stats: CompactStats } {
  const oldCodecName = chunk.header.codecName;
  if (oldCodecName === newCodecName) {
    return {
      chunk,
      stats: {
        inputBytes: chunk.payload.length,
        outputBytes: chunk.payload.length,
        decodeMillis: 0,
        encodeMillis: 0,
      },
    };
  }
  const oldCodec = registry.get(oldCodecName);
  const newCodec = registry.get(newCodecName);
  const t0 = nowMillis();
  const raw = oldCodec.decode(chunk.payload);
  const t1 = nowMillis();
  const newPayload = newCodec.encode(raw);
  const t2 = nowMillis();
  const newChunk: Chunk = {
    header: {
      ...chunk.header,
      codecName: newCodecName,
      payloadBytes: newPayload.length,
    },
    payload: newPayload,
  };
  return {
    chunk: newChunk,
    stats: {
      inputBytes: chunk.payload.length,
      outputBytes: newPayload.length,
      decodeMillis: t1 - t0,
      encodeMillis: t2 - t1,
    },
  };
}

function nowMillis(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}
