/**
 * LogStore — the public engine. Composes:
 *
 *   - CodecRegistry  (pluggable codec implementations, M0/M1)
 *   - BodyClassifier (templated/freetext/kvlist/bytes, plug-in)
 *   - ChunkPolicy    (per-chunk codec choice, plug-in)
 *   - StreamRegistry (per-(resource, scope) chunk lists)
 *
 * Default config gives a working but slow pipeline (NDJSON + zstd-19,
 * no template extraction). Real codec implementations land via M0–M2:
 *
 *   - M0: ALP / Delta-ALP / FastLanes BP for numeric columns
 *   - M1: FSST + binary fuse + Roaring-lite
 *   - M2: in-house Drain template extractor (validated in Experiment F)
 *
 * Experiments configure the engine by passing a custom registry +
 * classifier + policy and re-running the bench.
 */

import type { ChunkPolicy } from "./chunk.js";
import { ChunkBuilder, DefaultChunkPolicy, readRecords, serializeChunk } from "./chunk.js";
import type { BodyClassifier } from "./classify.js";
import { defaultClassifier } from "./classify.js";
import type { CodecRegistry } from "./codec.js";
import { defaultRegistry } from "./codec-baseline.js";
import { StreamRegistry } from "./stream.js";
import type { InstrumentationScope, LogRecord, Resource, StreamId } from "./types.js";

export interface LogStoreConfig {
  /** Defaults to `defaultRegistry()` (raw / gzip / zstd / length-prefix / raw-i64). */
  registry?: CodecRegistry;
  /** Defaults to `defaultClassifier`. */
  classifier?: BodyClassifier;
  /** Defaults to `new DefaultChunkPolicy("zstd-19")`. */
  policy?: ChunkPolicy;
  /**
   * Optional per-stream policy factory. When set, each new stream
   * (uniquely identified by its (resource, scope) tuple) gets its own
   * `ChunkPolicy` instance returned by this factory and reuses it for
   * every chunk produced for that stream. Takes precedence over
   * `policy` when provided. This models the "per-stream Drain" shape
   * recommended by PLAN.md, where each stream's template parser has
   * isolated state.
   */
  policyFactory?: (
    streamId: StreamId,
    resource: Resource,
    scope: InstrumentationScope
  ) => ChunkPolicy;
  /** Hard row count per chunk. Default 1024. */
  rowsPerChunk?: number;
}

export interface IngestStats {
  recordsAppended: number;
  chunksClosed: number;
}

export interface StoreStats {
  streams: number;
  chunks: number;
  totalLogs: number;
  totalChunkBytes: number;
  bytesPerLog: number;
}

/**
 * In-memory log store. Append OTLP-shaped records; chunks freeze
 * automatically at the row-count cap. Query API arrives in M7; for
 * now this exposes round-trip primitives for the bench harness.
 */
export class LogStore {
  readonly registry: CodecRegistry;
  readonly classifier: BodyClassifier;
  readonly policy: ChunkPolicy;
  readonly policyFactory?: (
    streamId: StreamId,
    resource: Resource,
    scope: InstrumentationScope
  ) => ChunkPolicy;
  readonly rowsPerChunk: number;
  readonly streams: StreamRegistry = new StreamRegistry();

  /** In-flight chunk builders keyed by stream id. */
  private inflight: Map<StreamId, ChunkBuilder> = new Map();
  /**
   * Per-stream policy instances, populated lazily when `policyFactory`
   * is provided. Persists across chunks of the same stream so any
   * stateful policy (e.g. Drain) accumulates per-stream state.
   */
  private policyByStream: Map<StreamId, ChunkPolicy> = new Map();
  private chunksClosed: number = 0;

  constructor(config: LogStoreConfig = {}) {
    this.registry = config.registry ?? defaultRegistry();
    this.classifier = config.classifier ?? defaultClassifier;
    this.policy = config.policy ?? new DefaultChunkPolicy("zstd-19");
    if (config.policyFactory) this.policyFactory = config.policyFactory;
    this.rowsPerChunk = config.rowsPerChunk ?? 1024;
  }

  /** Returns the policy that should serialize/deserialize chunks for `id`. */
  policyFor(id: StreamId): ChunkPolicy {
    if (!this.policyFactory) return this.policy;
    let p = this.policyByStream.get(id);
    if (!p) {
      const resource = this.streams.resourceOf(id);
      const scope = this.streams.scopeOf(id);
      p = this.policyFactory(id, resource, scope);
      this.policyByStream.set(id, p);
    }
    return p;
  }

  /** Append a record to its (resource, scope) stream; close chunk if full. */
  append(resource: Resource, scope: InstrumentationScope, record: LogRecord): IngestStats {
    const id = this.streams.intern(resource, scope);
    let builder = this.inflight.get(id);
    if (!builder) {
      builder = new ChunkBuilder(resource, scope, this.policyFor(id), this.registry);
      this.inflight.set(id, builder);
    }
    // Body classifier output is currently only consumed by future codec
    // policies; we still call it so plugged-in classifiers can record state.
    void this.classifier.classify(record);
    builder.append(record);
    if (builder.size() >= this.rowsPerChunk) {
      this.streams.appendChunk(id, builder.freeze());
      this.inflight.delete(id);
      this.chunksClosed++;
    }
    return { recordsAppended: 1, chunksClosed: this.chunksClosed };
  }

  /** Close all in-flight chunks. Call before stats / serialization. */
  flush(): void {
    for (const [id, builder] of this.inflight) {
      if (builder.size() > 0) {
        this.streams.appendChunk(id, builder.freeze());
        this.chunksClosed++;
      }
    }
    this.inflight.clear();
  }

  stats(): StoreStats {
    let chunks = 0;
    let totalLogs = 0;
    let totalBytes = 0;
    for (const id of this.streams.ids()) {
      const chunkList = this.streams.chunksOf(id);
      chunks += chunkList.length;
      for (const c of chunkList) {
        totalLogs += c.header.nLogs;
        totalBytes += serializeChunk(c).length;
      }
    }
    return {
      streams: this.streams.size(),
      chunks,
      totalLogs,
      totalChunkBytes: totalBytes,
      bytesPerLog: totalLogs > 0 ? totalBytes / totalLogs : 0,
    };
  }

  /**
   * Round-trip every chunk back to LogRecord[]. Yields stream by
   * stream so callers can stream results without materializing all
   * records at once.
   */
  *iterRecords(): Generator<{ streamId: StreamId; records: LogRecord[] }> {
    for (const id of this.streams.ids()) {
      const policy = this.policyFor(id);
      for (const chunk of this.streams.chunksOf(id)) {
        yield { streamId: id, records: readRecords(chunk, this.registry, policy) };
      }
    }
  }
}
