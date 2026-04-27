/**
 * Chunk — the unit of immutable columnar storage in o11ytracesdb.
 *
 * Wire format (Chunk v1):
 *   [0..4)   magic "OTDB" (OpenTelemetry traces DataBase)
 *   [4..5)   schema version (1)
 *   [5..9)   header length (u32 LE)
 *   [9..9+H) header (UTF-8 JSON)
 *   [9+H..)  payload (columnar-encoded span data)
 *
 * The chunk header carries:
 * - Time-range zone map (minNano, maxNano) for range pruning
 * - Span count
 * - Codec name + codec meta
 * - Per-chunk dictionary of span names (for search pruning)
 * - Status zone map (hasError: boolean) for error filtering
 *
 * Resource and scope are NOT in the chunk payload — they are constants
 * per stream, stored in the StreamRegistry. This yields 0 bytes/span
 * for resource attributes.
 */

import { createBloomFilter, bloomToBase64 } from "./bloom.js";
import type { SpanRecord, StatusCode } from "./types.js";

// ─── Chunk Header ────────────────────────────────────────────────────

export interface ChunkHeader {
  /** Number of spans in this chunk. */
  nSpans: number;
  /** Minimum start_time_unix_nano across all spans. */
  minTimeNano: string; // bigint serialized as string for JSON
  /** Maximum end_time_unix_nano across all spans. */
  maxTimeNano: string;
  /** Whether any span in this chunk has StatusCode.ERROR. */
  hasError: boolean;
  /** Distinct span names in this chunk (for name-based pruning). */
  spanNames: string[];
  /** Codec used for the payload. */
  codecName: string;
  /** Codec-specific metadata (e.g. dictionary tables). */
  codecMeta?: unknown;
  /** Payload byte length. */
  payloadBytes: number;
  /** Base64-encoded bloom filter over trace IDs for fast pruning. */
  bloomFilter?: string;
}

// ─── Chunk ───────────────────────────────────────────────────────────

export interface Chunk {
  header: ChunkHeader;
  payload: Uint8Array;
}

// ─── Wire format constants ───────────────────────────────────────────

const MAGIC = new Uint8Array([0x4f, 0x54, 0x44, 0x42]); // "OTDB"
const SCHEMA_VERSION = 1;

// ─── Serialization ───────────────────────────────────────────────────

export function serializeChunk(chunk: Chunk): Uint8Array {
  const headerJson = JSON.stringify(chunk.header);
  const headerBytes = new TextEncoder().encode(headerJson);
  const totalLen = 4 + 1 + 4 + headerBytes.length + chunk.payload.length;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);

  out.set(MAGIC, 0);
  out[4] = SCHEMA_VERSION;
  view.setUint32(5, headerBytes.length, true);
  out.set(headerBytes, 9);
  out.set(chunk.payload, 9 + headerBytes.length);
  return out;
}

export function deserializeChunk(buf: Uint8Array): Chunk {
  if (buf.length < 9) throw new Error("o11ytracesdb: chunk too small");
  if (buf[0] !== 0x4f || buf[1] !== 0x54 || buf[2] !== 0x44 || buf[3] !== 0x42) {
    throw new Error("o11ytracesdb: invalid chunk magic (expected OTDB)");
  }
  if (buf[4] !== SCHEMA_VERSION) {
    throw new Error(`o11ytracesdb: unsupported schema version ${buf[4]}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = view.getUint32(5, true);
  const headerEnd = 9 + headerLen;
  if (buf.length < headerEnd) throw new Error("o11ytracesdb: truncated header");

  const headerJson = new TextDecoder().decode(buf.subarray(9, headerEnd));
  const header: ChunkHeader = JSON.parse(headerJson);
  const payload = buf.subarray(headerEnd);
  return { header, payload };
}

// ─── Chunk Builder ───────────────────────────────────────────────────

export interface ChunkPolicy {
  /** Codec name for the header. */
  codecName(): string;
  /** Encode spans into a binary columnar payload. */
  encodePayload(spans: readonly SpanRecord[]): { payload: Uint8Array; meta?: unknown };
  /** Decode a binary payload back into spans. */
  decodePayload(buf: Uint8Array, nSpans: number, meta: unknown): SpanRecord[];
  /** Decode only the ID columns (Section 2) for trace assembly. */
  decodeIdsOnly(buf: Uint8Array, nSpans: number): {
    traceIds: Uint8Array[];
    spanIds: Uint8Array[];
    parentSpanIds: (Uint8Array | undefined)[];
  };
}

export class ChunkBuilder {
  private spans: SpanRecord[] = [];
  private readonly maxSpans: number;
  private readonly policy: ChunkPolicy;

  constructor(policy: ChunkPolicy, maxSpans = 1024) {
    this.policy = policy;
    this.maxSpans = maxSpans;
  }

  get length(): number {
    return this.spans.length;
  }

  get isFull(): boolean {
    return this.spans.length >= this.maxSpans;
  }

  append(span: SpanRecord): void {
    this.spans.push(span);
  }

  /** Flush accumulated spans into an immutable Chunk. */
  flush(): Chunk | null {
    if (this.spans.length === 0) return null;
    const spans = this.spans;
    this.spans = [];

    // Compute zone maps
    let minTime = spans[0]!.startTimeUnixNano;
    let maxTime = spans[0]!.endTimeUnixNano;
    let hasError = false;
    const nameSet = new Set<string>();

    for (const s of spans) {
      if (s.startTimeUnixNano < minTime) minTime = s.startTimeUnixNano;
      if (s.endTimeUnixNano > maxTime) maxTime = s.endTimeUnixNano;
      if (s.statusCode === 2) hasError = true; // StatusCode.ERROR
      nameSet.add(s.name);
    }

    const { payload, meta } = this.policy.encodePayload(spans);

    // Compute bloom filter from trace IDs
    const traceIds = spans.map((s) => s.traceId);
    const bloom = createBloomFilter(traceIds);
    const bloomB64 = bloomToBase64(bloom);

    const header: ChunkHeader = {
      nSpans: spans.length,
      minTimeNano: minTime.toString(),
      maxTimeNano: maxTime.toString(),
      hasError,
      spanNames: [...nameSet],
      codecName: this.policy.codecName(),
      codecMeta: meta,
      payloadBytes: payload.length,
      ...(bloomB64.length > 0 ? { bloomFilter: bloomB64 } : {}),
    };

    return { header, payload };
  }
}
