/**
 * Core interfaces for the o11ytsdb experimentation framework.
 *
 * Every component is pluggable — swap storage backends, codecs, and
 * query strategies to benchmark different approaches end-to-end.
 */

// ── Domain types ─────────────────────────────────────────────────────

/** Labels identifying a time series (e.g. { __name__: "http_requests", method: "GET" }). */
export type Labels = ReadonlyMap<string, string>;

/** Opaque series identifier. */
export type SeriesId = number;

/** A decoded block of time-series data. */
export interface TimeRange {
  timestamps: BigInt64Array;
  values: Float64Array;
}

// ── Codec (encode/decode strategy) ───────────────────────────────────

/** Pluggable compression codec for chunks of time-series data. */
export interface Codec {
  readonly name: string;
  encode(timestamps: BigInt64Array, values: Float64Array): Uint8Array;
  decode(buf: Uint8Array): TimeRange;
}

/** Values-only codec — encodes just values, timestamps stored separately. */
export interface ValuesCodec {
  readonly name: string;
  encodeValues(values: Float64Array): Uint8Array;
  decodeValues(buf: Uint8Array): Float64Array;
  /** Optional: encode values and compute block stats in one pass (WASM fast-path). */
  encodeValuesWithStats?(values: Float64Array): { compressed: Uint8Array; stats: ChunkStats };
  /** Optional: batch-encode N arrays in a single WASM call, returning compressed blobs + stats. */
  encodeBatchValuesWithStats?(arrays: Float64Array[]): Array<{ compressed: Uint8Array; stats: ChunkStats }>;
  /** Optional: batch-decode N compressed blobs in a single WASM call. */
  decodeBatchValues?(blobs: Uint8Array[], chunkSize: number): Float64Array[];
}

/** Timestamp-only codec — delta-of-delta compression for shared timestamp columns. */
export interface TimestampCodec {
  readonly name: string;
  encodeTimestamps(timestamps: BigInt64Array): Uint8Array;
  decodeTimestamps(buf: Uint8Array): BigInt64Array;
}

/** Fused range-decode result: only samples within [startT, endT]. */
export interface RangeDecodeResult {
  timestamps: BigInt64Array;
  values: Float64Array;
}

/**
 * Optional fused range-decode codec — decodes timestamps + values and
 * returns only the samples within [startT, endT]. Enables partial decode
 * of fixed-width codecs (ALP) and moves binary search into WASM.
 */
export interface RangeDecodeCodec {
  rangeDecodeValues(
    compressedTimestamps: Uint8Array,
    compressedValues: Uint8Array,
    startT: bigint,
    endT: bigint,
  ): RangeDecodeResult;
}

/** Block-level statistics computed at freeze time. */
export interface ChunkStats {
  minV: number;
  maxV: number;
  sum: number;
  count: number;
  firstV: number;
  lastV: number;
  sumOfSquares: number;
  resetCount: number;
}

/** Codec that also computes block stats during encoding. */
export interface StatsCodec extends Codec {
  encodeWithStats(timestamps: BigInt64Array, values: Float64Array): {
    compressed: Uint8Array;
    stats: ChunkStats;
  };
}

// ── Storage backend ──────────────────────────────────────────────────

export interface StorageBackend {
  readonly name: string;

  // ── Ingest ──

  /** Resolve labels to a series ID. Creates the series if new. */
  getOrCreateSeries(labels: Labels): SeriesId;

  /** Append a single sample. */
  append(id: SeriesId, timestamp: bigint, value: number): void;

  /** Append a batch of samples for one series (bulk ingest). */
  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void;

  // ── Query ──

  /** Return all series IDs where the given label has the given value. */
  matchLabel(label: string, value: string): SeriesId[];

  /** Read decoded samples in [start, end] for a series. */
  read(id: SeriesId, start: bigint, end: bigint): TimeRange;

  /** Retrieve the label set for a series. */
  labels(id: SeriesId): Labels | undefined;

  // ── Stats ──

  readonly seriesCount: number;
  readonly sampleCount: number;

  /** Estimated memory usage in bytes (structural overhead + data). */
  memoryBytes(): number;
}

// ── Query engine ─────────────────────────────────────────────────────

export type AggFn = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'last' | 'rate';

export interface Matcher {
  label: string;
  value: string;
}

export interface QueryOpts {
  metric: string;
  matchers?: Matcher[];
  start: bigint;
  end: bigint;
  step?: bigint;
  agg?: AggFn;
  groupBy?: string[];
}

export interface SeriesResult {
  labels: Labels;
  timestamps: BigInt64Array;
  values: Float64Array;
}

export interface QueryResult {
  series: SeriesResult[];
  scannedSeries: number;
  scannedSamples: number;
}

export interface QueryEngine {
  readonly name: string;
  query(storage: StorageBackend, opts: QueryOpts): QueryResult;
}
