/**
 * Column store — shared timestamp columns with values-only compression.
 *
 * The key insight: co-scraped series share the same timestamps.
 * Instead of storing N copies of the same timestamp array (one per
 * series), we store one shared timestamp column per "group" and only
 * compress values per series.
 *
 * Memory model:
 *   - Timestamps: one BigInt64Array per group (shared across series)
 *   - Values: per-series XOR-compressed Uint8Array chunks
 *   - Stats: optional per-chunk block statistics for query skipping
 *
 * This is the most memory-efficient backend: timestamps are amortized
 * to near-zero cost as group size grows.
 */

import { concatRanges, lowerBound, upperBound } from "./binary-search.js";
import { LabelIndex } from "./label-index.js";
import { computeStats } from "./stats.js";
import type {
  ChunkStats,
  Labels,
  RangeDecodeCodec,
  SeriesId,
  StorageBackend,
  TimeRange,
  TimestampCodec,
  ValuesCodec,
} from "./types.js";

// ── Internal types ───────────────────────────────────────────────────

interface FrozenChunk {
  compressedValues: Uint8Array;
  /** Index into the group's frozen timestamp chunks. */
  tsChunkIndex: number;
  stats: ChunkStats;
}

interface HotValues {
  values: Float64Array;
  count: number;
}

interface ColumnSeries {
  groupId: number;
  hot: HotValues;
  frozen: FrozenChunk[];
}

interface TimestampChunk {
  /** Raw timestamps (when no timestamp codec) or decoded cache. */
  timestamps?: BigInt64Array;
  /** Compressed timestamps (when timestamp codec is set). */
  compressed?: Uint8Array;
  minT: bigint;
  maxT: bigint;
  count: number;
}

interface SeriesGroup {
  /** Hot timestamp buffer (shared across all series in this group). */
  hotTimestamps: BigInt64Array;
  hotCount: number;
  /** Frozen timestamp chunks. */
  frozenTimestamps: TimestampChunk[];
  /** All series IDs belonging to this group. */
  members: SeriesId[];
}

// ── ColumnStore ──────────────────────────────────────────────────────

export class ColumnStore implements StorageBackend {
  readonly name: string;

  private valuesCodec: ValuesCodec;
  private tsCodec: TimestampCodec | undefined;
  private rangeCodec: RangeDecodeCodec | undefined;
  private chunkSize: number;
  private allSeries: ColumnSeries[] = [];
  private groups: SeriesGroup[] = [];
  private labelIndex: LabelIndex;
  private _sampleCount = 0;
  private quantize: ((v: number) => number) | undefined;
  private quantizeBatch: ((values: Float64Array, precision: number) => void) | undefined;
  private precision: number | undefined;

  /**
   * @param valuesCodec - Codec for values-only compression.
   * @param chunkSize - Samples per chunk before freezing.
   * @param groupResolver - Maps a label set to a group ID (e.g. by job+instance).
   *                        Default: all series in one group (maximum timestamp sharing).
   * @param name - Optional display name.
   * @param tsCodec - Optional timestamp codec for delta-of-delta compression.
   * @param rangeCodec - Optional fused range-decode codec (ALP fast-path).
   * @param precision - Optional decimal precision for value quantization (e.g. 3 → round to 0.001).
   *                    When set, values are rounded on ingest to guarantee ALP-clean encoding.
   * @param quantizeBatch - Optional WASM SIMD batch quantize function.
   *                        When provided with precision, appendBatch uses SIMD instead of per-element Math.round.
   */
  constructor(
    valuesCodec: ValuesCodec,
    chunkSize = 640,
    private groupResolver: (labels: Labels) => number = () => 0,
    name?: string,
    tsCodec?: TimestampCodec,
    rangeCodec?: RangeDecodeCodec,
    labelIndex?: LabelIndex,
    precision?: number,
    quantizeBatch?: (values: Float64Array, precision: number) => void
  ) {
    if (!Number.isFinite(chunkSize) || !Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError(`chunkSize must be a finite integer >= 1, got ${chunkSize}`);
    }
    this.valuesCodec = valuesCodec;
    this.tsCodec = tsCodec;
    this.rangeCodec = rangeCodec;
    this.chunkSize = chunkSize;
    this.name = name ?? `column-${this.valuesCodec.name}-${chunkSize}`;
    this.labelIndex = labelIndex ?? new LabelIndex();
    this.precision = precision;
    this.quantizeBatch = quantizeBatch;
    if (precision != null) {
      const scale = 10 ** precision;
      if (quantizeBatch) {
        // Use WASM quantize for single values too, ensuring consistent rounding
        // (banker's rounding via f64x2_nearest) across append() and appendBatch().
        const scratch = new Float64Array(1);
        const qb = quantizeBatch;
        const p = precision;
        this.quantize = (v: number) => {
          scratch[0] = v;
          qb(scratch, p);
          return scratch[0]!;
        };
      } else {
        this.quantize = (v: number) => Math.round(v * scale) / scale;
      }
    }
  }

  // ── Ingest ──

  getOrCreateSeries(labels: Labels): SeriesId {
    const { id, isNew } = this.labelIndex.getOrCreate(labels, this.allSeries.length);
    if (!isNew) return id;

    const groupId = this.groupResolver(labels);
    if (!Number.isInteger(groupId) || groupId < 0) {
      throw new RangeError(`groupResolver must return a non-negative integer, got ${groupId}`);
    }

    // Ensure group exists.
    while (this.groups.length <= groupId) {
      this.groups.push({
        hotTimestamps: new BigInt64Array(this.chunkSize),
        hotCount: 0,
        frozenTimestamps: [],
        members: [],
      });
    }

    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const group = this.groups[groupId]!;
    group.members.push(id);

    this.allSeries.push({
      groupId,
      hot: { values: new Float64Array(this.chunkSize), count: 0 },
      frozen: [],
    });
    return id;
  }

  append(id: SeriesId, timestamp: bigint, value: number): void {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const s = this.allSeries[id]!;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const group = this.groups[s.groupId]!;

    // Write timestamp to shared group buffer.
    // Only the first series to write at this position sets the timestamp.
    if (s.hot.count === group.hotCount) {
      group.hotTimestamps[group.hotCount] = timestamp;
    }

    s.hot.values[s.hot.count] = this.quantize ? this.quantize(value) : value;
    s.hot.count++;
    this._sampleCount++;

    // Check if this was the last member to fill the slot — advance group counter.
    if (s.hot.count > group.hotCount) {
      group.hotCount = s.hot.count;
    }

    if (s.hot.count === this.chunkSize) {
      this.maybeFreeze(group);
    }
  }

  appendBatch(id: SeriesId, timestamps: BigInt64Array, values: Float64Array): void {
    if (timestamps.length !== values.length) {
      throw new RangeError(
        `appendBatch: timestamps.length (${timestamps.length}) !== values.length (${values.length})`
      );
    }
    if (timestamps.length === 0) return;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const s = this.allSeries[id]!;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const group = this.groups[s.groupId]!;
    let offset = 0;
    const len = timestamps.length;

    while (offset < len) {
      // How much space remains in the hot buffer for this series.
      let space = s.hot.values.length - s.hot.count;

      // If hot buffer is full, try freezing first, then expand if still full.
      if (space === 0) {
        const countBefore = s.hot.count;
        this.maybeFreeze(group);
        if (s.hot.count < countBefore) {
          // Freeze consumed some data — recalculate space.
          space = s.hot.values.length - s.hot.count;
        } else {
          // Group can't freeze yet (other members haven't filled). Expand buffer.
          const newSize = s.hot.values.length + this.chunkSize;
          const newVals = new Float64Array(newSize);
          newVals.set(s.hot.values);
          s.hot.values = newVals;
          if (group.hotTimestamps.length < newSize) {
            const newTs = new BigInt64Array(newSize);
            newTs.set(group.hotTimestamps);
            group.hotTimestamps = newTs;
          }
          space = newSize - s.hot.count;
        }
      }

      const batch = Math.min(space, len - offset);

      // Write timestamps to shared buffer.
      const tsSlice = timestamps.subarray(offset, offset + batch);
      if (s.hot.count <= group.hotCount) {
        group.hotTimestamps.set(tsSlice, s.hot.count);
      }

      if (this.quantize) {
        if (this.quantizeBatch && this.precision != null) {
          // WASM SIMD batch quantize — ~17× faster than per-element Math.round.
          // Copy into hot buffer first, then quantize in-place to avoid extra allocation.
          s.hot.values.set(values.subarray(offset, offset + batch), s.hot.count);
          const target = s.hot.values.subarray(s.hot.count, s.hot.count + batch);
          this.quantizeBatch(target, this.precision);
        } else {
          const q = this.quantize;
          for (let i = 0; i < batch; i++) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            s.hot.values[s.hot.count + i] = q(values[offset + i]!);
          }
        }
      } else {
        s.hot.values.set(values.subarray(offset, offset + batch), s.hot.count);
      }
      s.hot.count += batch;
      this._sampleCount += batch;
      offset += batch;

      if (s.hot.count > group.hotCount) {
        group.hotCount = s.hot.count;
      }

      if (s.hot.count >= this.chunkSize) {
        this.maybeFreeze(group);
      }
    }
  }

  // ── Query ──

  matchLabel(label: string, value: string): SeriesId[] {
    return this.labelIndex.matchLabel(label, value);
  }

  matchLabelRegex(label: string, pattern: RegExp): SeriesId[] {
    return this.labelIndex.matchLabelRegex(label, pattern);
  }

  read(id: SeriesId, start: bigint, end: bigint): TimeRange {
    const parts = this.readParts(id, start, end);
    // Resolve stats-only parts so concatRanges gets full sample data.
    for (let i = 0; i < parts.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      const p = parts[i]!;
      if (p.timestamps.length === 0 && p.decode) {
        parts[i] = p.decode();
      }
    }
    return concatRanges(parts);
  }

  readParts(id: SeriesId, start: bigint, end: bigint): TimeRange[] {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const s = this.allSeries[id]!;
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const group = this.groups[s.groupId]!;
    const parts: TimeRange[] = [];

    // ── Path A: Fused range-decode (best — ts decode + binary search + partial values decode in one WASM call) ──
    if (this.rangeCodec && this.tsCodec) {
      for (const chunk of s.frozen) {
        // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
        const tsChunk = group.frozenTimestamps[chunk.tsChunkIndex]!;
        if (tsChunk.maxT < start || tsChunk.minT > end) continue;

        // Stats-skip: when the entire chunk is within the query range,
        // emit a stats-only part so the query engine can fold pre-computed
        // aggregates instead of decoding + iterating every sample.
        // Includes a lazy decode() callback for cases where the chunk
        // spans multiple aggregation buckets and needs sample iteration.
        if (tsChunk.minT >= start && tsChunk.maxT <= end) {
          const rc = this.rangeCodec;
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          const tc = tsChunk.compressed!;
          const cv = chunk.compressedValues;
          parts.push({
            timestamps: new BigInt64Array(0),
            values: new Float64Array(0),
            stats: chunk.stats,
            chunkMinT: tsChunk.minT,
            chunkMaxT: tsChunk.maxT,
            decode: () => rc.rangeDecodeValues(tc, cv, tsChunk.minT, tsChunk.maxT),
          });
          continue;
        }

        const result = this.rangeCodec.rangeDecodeValues(
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          tsChunk.compressed!,
          chunk.compressedValues,
          start,
          end
        );
        if (result.timestamps.length > 0) {
          parts.push(result);

          // Cache decoded timestamps if not already cached.
          if (!tsChunk.timestamps) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            tsChunk.timestamps = this.tsCodec.decodeTimestamps(tsChunk.compressed!);
          }
        }
      }
    } else {
      // ── Path B: Individual decode (batch decode amortized by caller if needed) ──
      for (const chunk of s.frozen) {
        // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
        const tsChunk = group.frozenTimestamps[chunk.tsChunkIndex]!;
        if (tsChunk.maxT < start || tsChunk.minT > end) continue;

        // Stats-skip: entire chunk within query range.
        if (tsChunk.minT >= start && tsChunk.maxT <= end) {
          const vc = this.valuesCodec;
          const cv = chunk.compressedValues;
          const tsc = this.tsCodec;
          const tcc = tsChunk.compressed;
          const part: TimeRange = {
            timestamps: new BigInt64Array(0),
            values: new Float64Array(0),
            stats: chunk.stats,
            chunkMinT: tsChunk.minT,
            chunkMaxT: tsChunk.maxT,
            decode: () => {
              if (!tsChunk.timestamps && tsc) {
                // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
                tsChunk.timestamps = tsc.decodeTimestamps(tcc!);
              }
              // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
              const ts = tsChunk.timestamps!;
              const vs = vc.decodeValues(cv);
              return { timestamps: ts, values: vs };
            },
          };
          if (typeof vc.decodeValuesView === "function") {
            const decView = vc.decodeValuesView.bind(vc);
            part.decodeView = () => {
              if (!tsChunk.timestamps && tsc) {
                tsChunk.timestamps = tsc.decodeTimestamps(tcc!);
              }
              return { timestamps: tsChunk.timestamps!, values: decView(cv) };
            };
          }
          parts.push(part);
          continue;
        }

        // Decompress timestamps if needed.
        const timestamps =
          tsChunk.timestamps ??
          // biome-ignore lint/style/noNonNullAssertion lint/suspicious/noAssignInExpressions: bounds-checked by construction
          (tsChunk.timestamps = this.tsCodec!.decodeTimestamps(tsChunk.compressed!));

        const values = this.valuesCodec.decodeValues(chunk.compressedValues);
        const lo = lowerBound(timestamps, start, 0, tsChunk.count);
        const hi = upperBound(timestamps, end, lo, tsChunk.count);
        if (hi > lo) {
          parts.push({
            timestamps: timestamps.slice(lo, hi),
            values: values.slice(lo, hi),
          });
        }
      }
    }

    // Scan hot chunk.
    if (s.hot.count > 0) {
      const lo = lowerBound(group.hotTimestamps, start, 0, s.hot.count);
      const hi = upperBound(group.hotTimestamps, end, lo, s.hot.count);
      if (hi > lo) {
        parts.push({
          timestamps: group.hotTimestamps.slice(lo, hi),
          values: s.hot.values.slice(lo, hi),
        });
      }
    }

    return parts;
  }

  labels(id: SeriesId): Labels | undefined {
    return this.labelIndex.labels(id);
  }

  // ── Stats ──

  get seriesCount(): number {
    return this.allSeries.length;
  }
  get sampleCount(): number {
    return this._sampleCount;
  }

  memoryBytes(): number {
    let bytes = 0;

    // Group overhead: shared timestamp buffers.
    for (const g of this.groups) {
      // Hot shared timestamps — only count active samples, not capacity.
      bytes += g.hotCount * 8;
      // Frozen shared timestamp chunks.
      for (const tc of g.frozenTimestamps) {
        if (tc.compressed) {
          bytes += tc.compressed.byteLength;
        } else if (tc.timestamps) {
          bytes += tc.timestamps.byteLength;
        }
      }
    }

    // Per-series: hot values + frozen compressed values + stats.
    for (const s of this.allSeries) {
      bytes += s.hot.count * 8;
      for (const c of s.frozen) {
        bytes += c.compressedValues.byteLength;
        bytes += 72;
      }
    }
    bytes += this.labelIndex.memoryBytes();
    return bytes;
  }

  // ── Internal ──

  private maybeFreeze(group: SeriesGroup): void {
    // Find the minimum sample count across all group members.
    let minCount = Infinity;
    for (const memberId of group.members) {
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      const c = this.allSeries[memberId]!.hot.count;
      if (c < minCount) minCount = c;
    }

    // Freeze as many full chunks as all members can support.
    const chunksToFreeze = Math.floor(minCount / this.chunkSize);
    if (chunksToFreeze === 0) return;

    const hasBatch = typeof this.valuesCodec.encodeBatchValuesWithStats === "function";
    const hasWasmStats = typeof this.valuesCodec.encodeValuesWithStats === "function";

    for (let c = 0; c < chunksToFreeze; c++) {
      const chunkStart = c * this.chunkSize;

      // Freeze shared timestamps for this chunk.
      const ts = group.hotTimestamps.slice(chunkStart, chunkStart + this.chunkSize);
      const tsChunkIndex = group.frozenTimestamps.length;

      if (this.tsCodec) {
        const compressed = this.tsCodec.encodeTimestamps(ts);
        group.frozenTimestamps.push({
          compressed,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          minT: ts[0]!,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          maxT: ts[this.chunkSize - 1]!,
          count: this.chunkSize,
        });
      } else {
        group.frozenTimestamps.push({
          timestamps: ts,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          minT: ts[0]!,
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          maxT: ts[this.chunkSize - 1]!,
          count: this.chunkSize,
        });
      }

      // ── Batch freeze: encode members in capped batches to bound scratch memory ──
      if (hasBatch) {
        const BATCH_CAP = 32; // Cap to avoid WASM scratch overflow (~32 × 128 × 28 ≈ 112KB per batch)
        for (let bStart = 0; bStart < group.members.length; bStart += BATCH_CAP) {
          const bEnd = Math.min(bStart + BATCH_CAP, group.members.length);
          const arrays: Float64Array[] = [];
          for (let m = bStart; m < bEnd; m++) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            const s = this.allSeries[group.members[m]!]!;
            arrays.push(s.hot.values.subarray(chunkStart, chunkStart + this.chunkSize));
          }
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          const results = this.valuesCodec.encodeBatchValuesWithStats!(arrays);
          for (let m = 0; m < results.length; m++) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            const s = this.allSeries[group.members[bStart + m]!]!;
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            const { compressed, stats } = results[m]!;
            s.frozen.push({ compressedValues: compressed, tsChunkIndex, stats });
          }
        }
      } else {
        // Fallback: encode each member individually.
        for (const memberId of group.members) {
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
          const s = this.allSeries[memberId]!;
          const vals = s.hot.values.subarray(chunkStart, chunkStart + this.chunkSize);

          let compressedValues: Uint8Array;
          let stats: ChunkStats;
          if (hasWasmStats) {
            // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
            const result = this.valuesCodec.encodeValuesWithStats!(vals);
            compressedValues = result.compressed;
            stats = result.stats;
          } else {
            compressedValues = this.valuesCodec.encodeValues(vals);
            stats = computeStats(vals);
          }

          s.frozen.push({ compressedValues, tsChunkIndex, stats });
        }
      }
    }

    // Shift remaining hot data back to the start (reuse buffers when possible).
    const frozenSamples = chunksToFreeze * this.chunkSize;
    for (const memberId of group.members) {
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      const s = this.allSeries[memberId]!;
      const remaining = s.hot.count - frozenSamples;
      if (remaining > 0) {
        // Copy remaining data to the front of the existing buffer.
        s.hot.values.copyWithin(0, frozenSamples, s.hot.count);
        s.hot.count = remaining;
      } else {
        s.hot.count = 0;
      }
    }

    // Shift shared timestamps (reuse buffer).
    const tsRemaining = group.hotCount - frozenSamples;
    if (tsRemaining > 0) {
      group.hotTimestamps.copyWithin(0, frozenSamples, group.hotCount);
      group.hotCount = tsRemaining;
    } else {
      group.hotCount = 0;
    }
  }
}
