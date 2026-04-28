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
  /** Pre-computed chunk statistics (when available, query engine may skip sample iteration). */
  stats?: ChunkStats;
  /** Optional packed stats backing for allocation-free frozen chunk stats. */
  statsPacked?: Float64Array;
  /** Start offset inside statsPacked for this chunk's 5 packed stat fields (min/max/sum/count/last). */
  statsOffset?: number;
  /** Minimum timestamp in the original chunk (for bucket-fit checks). */
  chunkMinT?: bigint;
  /** Maximum timestamp in the original chunk (for bucket-fit checks). */
  chunkMaxT?: bigint;
  /** Lazy decode callback for stats-only parts.
   *  When a stats-only part can't be folded (spans multiple buckets),
   *  the query engine calls this to retrieve the full sample data. */
  decode?: () => TimeRange;
  /** Zero-copy lazy decode — returns views into codec scratch memory.
   *  The returned arrays are only valid until the next decodeView/decode call.
   *  Prefer this over decode() in tight loops (e.g., stepAggregate). */
  decodeView?: () => TimeRange;
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
  /** Optional: decode only values in the half-open sample interval [startIndex, endIndex). */
  decodeValuesRange?(buf: Uint8Array, startIndex: number, endIndex: number): Float64Array;
  /** Optional: decode a value range into codec-owned scratch memory and return a view.
   *  The returned Float64Array is only valid until the next decode call on
   *  the same codec instance — callers must consume the data immediately. */
  decodeValuesRangeView?(buf: Uint8Array, startIndex: number, endIndex: number): Float64Array;
  /** Optional: decode values into codec-owned scratch memory and return a view.
   *  The returned Float64Array is only valid until the next decode call on
   *  the same codec instance — callers must consume the data immediately. */
  decodeValuesView?(buf: Uint8Array): Float64Array;
  /** Optional: batch-decode N blobs and return views into codec scratch memory.
   *  The returned views are only valid until the next decode call on the same
   *  codec instance. */
  decodeBatchValuesView?(blobs: Uint8Array[], chunkSize: number): Float64Array[];
  /** Optional: encode values and compute block stats in one pass (WASM fast-path). */
  encodeValuesWithStats?(values: Float64Array): { compressed: Uint8Array; stats: ChunkStats };
  /** Optional: batch-encode N arrays in a single WASM call, returning compressed blobs + stats. */
  encodeBatchValuesWithStats?(
    arrays: Float64Array[]
  ): Array<{ compressed: Uint8Array; stats: ChunkStats }>;
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
    endT: bigint
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

/** Values for one series in a shared-timestamp append. */
export interface SeriesAppend {
  id: SeriesId;
  values: Float64Array;
}

// ── Storage backend ──────────────────────────────────────────────────

export interface StorageBackend {
  readonly name: string;

  // ── Ingest ──

  /** Resolve labels to a series ID. Creates the series if new. */
  getOrCreateSeries(labels: Labels): SeriesId;

  /**
   * Append one shared timestamp vector for one or more series.
   *
   * Every series must provide exactly one value per timestamp. Single-series
   * and single-sample writes are represented as degenerate calls to this same
   * primitive.
   */
  append(timestamps: BigInt64Array, series: readonly SeriesAppend[]): void;

  // ── Query ──

  /** Return all series IDs where the given label has the given value. */
  matchLabel(label: string, value: string): SeriesId[];

  /** Return all series IDs where the given label matches the regex. */
  matchLabelRegex?(label: string, pattern: RegExp): SeriesId[];

  /** Read decoded samples in [start, end] for a series. */
  read(id: SeriesId, start: bigint, end: bigint): TimeRange;

  /** Read decoded samples as individual chunk parts (avoids concatenation). */
  readParts?(id: SeriesId, start: bigint, end: bigint): TimeRange[];

  /**
   * Visit individual chunk parts without materializing a TimeRange[] array.
   *
   * Implementations must yield parts in ascending timestamp order, and
   * repeated scans over the same `[start, end]` range must produce the same
   * sequence of parts. ScanEngine's streaming step-aggregation path relies on
   * this stability to drive a two-pass scan (bounds, then accumulate) over
   * the same series.
   */
  scanParts?(id: SeriesId, start: bigint, end: bigint, visit: (part: TimeRange) => void): void;

  /** Retrieve the label set for a series. */
  labels(id: SeriesId): Labels | undefined;

  // ── Stats ──

  readonly seriesCount: number;
  readonly sampleCount: number;

  /** Estimated memory usage in bytes (structural overhead + data). */
  memoryBytes(): number;
}

// ── Query engine ─────────────────────────────────────────────────────

export type AggFn =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "last"
  | "rate"
  | "increase"
  | "irate"
  | "delta"
  | "p50"
  | "p90"
  | "p95"
  | "p99";

export type MatchOp = "=" | "!=" | "=~" | "!~";

export interface Matcher {
  label: string;
  op: MatchOp;
  value: string;
}

export type TransformOp = "rate" | "increase" | "irate" | "delta";

export interface QueryOpts {
  metric: string;
  matchers?: Matcher[];
  start: bigint;
  end: bigint;
  step?: bigint;
  agg?: AggFn;
  transform?: TransformOp;
  groupBy?: string[];
  /** Maximum number of data points to return. When set, an effective step is
   *  computed so the result has at most this many points. */
  maxPoints?: number;
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

export interface MaterializedQueryResult extends QueryResult {
  mapSeries(mapper: (series: SeriesResult, index: number) => SeriesResult): MaterializedQueryResult;
  filterSeries(
    predicate: (series: SeriesResult, index: number) => boolean
  ): MaterializedQueryResult;
  mapPoints(
    mapper: (
      value: number,
      timestamp: bigint,
      series: SeriesResult,
      pointIndex: number,
      seriesIndex: number
    ) => number
  ): MaterializedQueryResult;
}

export interface ExecutedQuery {
  scannedSeries: number;
  scannedSamples: number;
  materialize(): MaterializedQueryResult;
}

export interface QueryEngine {
  readonly name: string;
  query(storage: StorageBackend, opts: QueryOpts): QueryResult;
}
