/**
 * TraceStore — the top-level public API for o11ytracesdb.
 *
 * Composes StreamRegistry + ChunkPolicy + ChunkBuilder to provide
 * a simple append/query interface.
 */

import type { Chunk, ChunkPolicy } from "./chunk.js";
import { ChunkBuilder } from "./chunk.js";
import { ColumnarTracePolicy } from "./codec-columnar.js";
import { StreamRegistry } from "./stream.js";
import type {
  InstrumentationScope,
  Resource,
  SpanRecord,
  StreamId,
} from "./types.js";

export interface TraceStoreOpts {
  /** Maximum spans per chunk before auto-flush. Default: 1024. */
  chunkSize?: number;
  /** Custom chunk policy. Default: ColumnarTracePolicy. */
  policy?: ChunkPolicy;
}

export interface TraceStoreStats {
  /** Total number of streams (unique resource+scope pairs). */
  streams: number;
  /** Total number of sealed chunks across all streams. */
  chunks: number;
  /** Total number of spans in sealed chunks. */
  sealedSpans: number;
  /** Total number of spans in hot (unflushed) builders. */
  hotSpans: number;
  /** Total payload bytes across all sealed chunks. */
  payloadBytes: number;
}

export class TraceStore {
  private registry = new StreamRegistry();
  private builders = new Map<StreamId, ChunkBuilder>();
  private readonly chunkSize: number;
  private readonly policy: ChunkPolicy;

  constructor(opts: TraceStoreOpts = {}) {
    this.chunkSize = opts.chunkSize ?? 1024;
    this.policy = opts.policy ?? new ColumnarTracePolicy();
  }

  /** Get the configured chunk policy (used by query engine). */
  getPolicy(): ChunkPolicy {
    return this.policy;
  }

  /**
   * Decode a chunk's payload using the store's configured policy.
   * This is the canonical way to decode chunks — avoids hardcoding a codec.
   */
  decodeChunk(chunk: Chunk): SpanRecord[] {
    return this.policy.decodePayload(chunk.payload, chunk.header.nSpans, chunk.header.codecMeta);
  }

  /**
   * Append spans from a single (resource, scope) batch.
   * This is the primary ingest path — mirrors OTLP batch structure.
   */
  append(resource: Resource, scope: InstrumentationScope, spans: readonly SpanRecord[]): void {
    const streamId = this.registry.intern(resource, scope);
    let builder = this.builders.get(streamId);
    if (!builder) {
      builder = new ChunkBuilder(this.policy, this.chunkSize);
      this.builders.set(streamId, builder);
    }

    for (const span of spans) {
      builder.append(span);
      if (builder.isFull) {
        this.sealBuilder(streamId, builder);
        builder = new ChunkBuilder(this.policy, this.chunkSize);
        this.builders.set(streamId, builder);
      }
    }
  }

  /** Force-flush all hot builders into sealed chunks. */
  flush(): void {
    for (const [streamId, builder] of this.builders) {
      if (builder.length > 0) {
        this.sealBuilder(streamId, builder);
      }
    }
    this.builders.clear();
  }

  private sealBuilder(streamId: StreamId, builder: ChunkBuilder): void {
    const chunk = builder.flush();
    if (chunk) {
      this.registry.appendChunk(streamId, chunk);
    }
  }

  /** Get the stream registry for query access. */
  getRegistry(): StreamRegistry {
    return this.registry;
  }

  /** Iterate all (streamId, chunk) pairs — used by the query engine. */
  *iterChunks(): Generator<{ streamId: StreamId; resource: Resource; scope: InstrumentationScope; chunk: Chunk }> {
    for (const streamId of this.registry.ids()) {
      const resource = this.registry.resourceOf(streamId);
      const scope = this.registry.scopeOf(streamId);
      for (const chunk of this.registry.chunksOf(streamId)) {
        yield { streamId, resource, scope, chunk };
      }
    }
  }

  /** Aggregate stats about the store. */
  stats(): TraceStoreStats {
    let chunks = 0;
    let sealedSpans = 0;
    let payloadBytes = 0;
    let hotSpans = 0;

    for (const streamId of this.registry.ids()) {
      for (const chunk of this.registry.chunksOf(streamId)) {
        chunks++;
        sealedSpans += chunk.header.nSpans;
        payloadBytes += chunk.header.payloadBytes;
      }
    }

    for (const builder of this.builders.values()) {
      hotSpans += builder.length;
    }

    return {
      streams: this.registry.size(),
      chunks,
      sealedSpans,
      hotSpans,
      payloadBytes,
    };
  }
}
