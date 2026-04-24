/**
 * Scan-based query engine — simple but complete.
 *
 * Finds matching series via label index, reads time range from
 * storage, optionally aggregates across series. No fancy indexes
 * or query planning — baseline for comparison with optimized engines.
 */

import type {
  AggFn,
  Labels,
  Matcher,
  QueryEngine,
  QueryOpts,
  QueryResult,
  SeriesId,
  SeriesResult,
  StorageBackend,
  TimeRange,
} from "./types.js";

function readNumberAt(arr: ArrayLike<number>, index: number, label: string): number {
  const value = arr[index];
  if (value === undefined) {
    throw new RangeError(`missing ${label} at index ${index}`);
  }
  return value;
}

function readNumberAtUnchecked(arr: Float64Array, index: number): number {
  return arr[index] as number;
}

function readBigIntAt(arr: BigInt64Array, index: number, label: string): bigint {
  const value = arr[index];
  if (value === undefined) {
    throw new RangeError(`missing ${label} at index ${index}`);
  }
  return value;
}

function readItemAt<T>(arr: readonly T[], index: number, label: string): T {
  const value = arr[index];
  if (value === undefined) {
    throw new RangeError(`missing ${label} at index ${index}`);
  }
  return value;
}

function readChunkBounds(range: TimeRange, rangeIndex: number): [bigint, bigint] | null {
  const { chunkMinT, chunkMaxT } = range;
  if ((chunkMinT === undefined) !== (chunkMaxT === undefined)) {
    throw new RangeError(`incomplete chunk bounds at range ${rangeIndex}`);
  }
  if (chunkMinT === undefined || chunkMaxT === undefined) {
    return null;
  }
  return [chunkMinT, chunkMaxT];
}

const STATS_MIN = 0;
const STATS_MAX = 1;
const STATS_SUM = 2;
const STATS_COUNT = 3;
const STATS_FIRST = 4;
const STATS_LAST = 5;
const STATS_SUMSQ = 6;
const STATS_RESET = 7;
const PACKED_STATS_MIN = 0;
const PACKED_STATS_MAX = 1;
const PACKED_STATS_SUM = 2;
const PACKED_STATS_COUNT = 3;
const PACKED_STATS_LAST = 4;

function hasChunkStats(range: TimeRange): boolean {
  return range.stats !== undefined || range.statsPacked !== undefined;
}

function readPackedStat(range: TimeRange, offset: number, label: string): number | undefined {
  const packed = range.statsPacked;
  if (!packed) return undefined;
  const base = range.statsOffset ?? 0;
  switch (offset) {
    case STATS_MIN:
      return readNumberAt(packed, base + PACKED_STATS_MIN, label);
    case STATS_MAX:
      return readNumberAt(packed, base + PACKED_STATS_MAX, label);
    case STATS_SUM:
      return readNumberAt(packed, base + PACKED_STATS_SUM, label);
    case STATS_COUNT:
      return readNumberAt(packed, base + PACKED_STATS_COUNT, label);
    case STATS_LAST:
      return readNumberAt(packed, base + PACKED_STATS_LAST, label);
    default:
      return undefined;
  }
}

function readChunkStat(range: TimeRange, offset: number, label: string): number {
  const packed = readPackedStat(range, offset, label);
  if (packed !== undefined) return packed;
  const stats = range.stats;
  if (!stats) {
    throw new RangeError(`missing ${label}`);
  }
  switch (offset) {
    case STATS_MIN:
      return stats.minV;
    case STATS_MAX:
      return stats.maxV;
    case STATS_SUM:
      return stats.sum;
    case STATS_COUNT:
      return stats.count;
    case STATS_FIRST:
      return stats.firstV;
    case STATS_LAST:
      return stats.lastV;
    case STATS_SUMSQ:
      return stats.sumOfSquares;
    case STATS_RESET:
      return stats.resetCount;
    default:
      throw new RangeError(`unknown chunk stat offset ${offset}`);
  }
}

function chunkSampleCount(range: TimeRange): number {
  if (range.timestamps.length > 0) return range.timestamps.length;
  if (!hasChunkStats(range)) return 0;
  return readChunkStat(range, STATS_COUNT, "chunk sample count");
}
type SimpleStepAgg = Extract<AggFn, "sum" | "avg" | "min" | "max" | "count" | "last">;

/** Galloping lower bound on a sorted number array. */
function gallopLowerBound(arr: number[], target: number, from: number): number {
  if (from >= arr.length) return arr.length;
  if (readNumberAt(arr, from, "gallop value") >= target) return from;
  let step = 1;
  let lo = from + 1;
  let hi = lo;
  while (hi < arr.length && readNumberAt(arr, hi, "gallop value") < target) {
    lo = hi + 1;
    step <<= 1;
    hi = from + step;
  }
  if (hi >= arr.length) hi = arr.length - 1;
  let left = lo;
  let right = hi;
  while (left <= right) {
    const mid = (left + right) >>> 1;
    if (readNumberAt(arr, mid, "gallop value") < target) left = mid + 1;
    else right = mid - 1;
  }
  return left;
}

/** Intersect two sorted arrays using galloping search. */
function sortedIntersect(a: number[], b: number[]): number[] {
  if (a.length === 0 || b.length === 0) return [];
  const small = a.length <= b.length ? a : b;
  const big = a.length <= b.length ? b : a;
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < small.length; i++) {
    const v = readNumberAt(small, i, "intersection value");
    j = gallopLowerBound(big, v, j);
    if (j >= big.length) break;
    if (big[j] === v) out.push(v);
  }
  return out;
}

/** Remove elements of b from a (both sorted). */
function sortedDifference(a: number[], b: number[]): number[] {
  if (b.length === 0) return a;
  if (a.length === 0) return [];
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    const v = readNumberAt(a, i, "difference value");
    j = gallopLowerBound(b, v, j);
    if (j < b.length && b[j] === v) continue;
    out.push(v);
  }
  return out;
}

/** Resolve a matcher against a storage backend, returning matched series IDs. */
function matcherIds(storage: StorageBackend, m: Matcher): SeriesId[] {
  if (m.op === "=" || m.op === "!=") {
    return storage.matchLabel(m.label, m.value);
  }
  // Regex match — compile pattern and use matchLabelRegex if available.
  // Note: patterns originate from the query builder (developer-authored), not
  // untrusted end-user input. The length guard is a defense-in-depth measure.
  if (m.value.length > 200) {
    throw new Error(`Regex pattern too long (${m.value.length} chars, max 200)`);
  }
  const pattern = new RegExp(`^(?:${m.value})$`);
  if (storage.matchLabelRegex) {
    return storage.matchLabelRegex(m.label, pattern);
  }
  // Fallback: not available on this backend
  throw new Error(
    `Storage backend '${storage.name}' does not support regex matchers (matchLabelRegex).`
  );
}

export class ScanEngine implements QueryEngine {
  readonly name = "scan";

  query(storage: StorageBackend, opts: QueryOpts): QueryResult {
    // Find matching series using sorted-array intersection (no Set allocation).
    let ids = storage.matchLabel("__name__", opts.metric);
    if (opts.matchers) {
      for (const m of opts.matchers) {
        const matched = matcherIds(storage, m);
        if (m.op === "=" || m.op === "=~") {
          ids = sortedIntersect(ids, matched);
        } else {
          // != or !~ → remove matched series
          ids = sortedDifference(ids, matched);
        }
      }
    }

    let scannedSamples = 0;

    // ── Compound transform + aggregation (e.g. rate().sumBy()) ──
    // Apply per-series transform first, then group + cross-series aggregate.
    if (opts.transform && opts.agg) {
      const groups = new Map<string, { labels: Labels; ranges: TimeRange[] }>();

      for (const id of ids) {
        let parts: TimeRange[];
        if (opts.step && storage.readParts) {
          parts = storage.readParts(id, opts.start, opts.end);
        } else {
          parts = [storage.read(id, opts.start, opts.end)];
        }
        for (const p of parts) scannedSamples += chunkSampleCount(p);

        // Apply per-series transform → step-aligned bucketed result.
        const transformed = aggregate(parts, opts.transform, opts.step);

        const labels = storage.labels(id) ?? new Map();
        const groupKey = opts.groupBy
          ? opts.groupBy.map((k) => labels.get(k) ?? "").join("\0")
          : "__all__";

        let group = groups.get(groupKey);
        if (!group) {
          const groupLabels = new Map<string, string>();
          groupLabels.set("__name__", opts.metric);
          if (opts.groupBy) {
            for (const k of opts.groupBy) {
              const v = labels.get(k);
              if (v !== undefined) groupLabels.set(k, v);
            }
          }
          group = { labels: groupLabels, ranges: [] };
          groups.set(groupKey, group);
        }
        group.ranges.push(transformed);
      }

      // Cross-series aggregation on the transformed results.
      const series: SeriesResult[] = [];
      for (const [, group] of groups) {
        const result = aggregate(group.ranges, opts.agg, opts.step);
        series.push({
          labels: group.labels,
          timestamps: result.timestamps,
          values: result.values,
        });
      }
      return { series, scannedSeries: ids.length, scannedSamples };
    }

    if (!opts.agg) {
      // No aggregation — return raw series (with optional per-series transform).
      const series: SeriesResult[] = [];
      for (const id of ids) {
        const data = storage.read(id, opts.start, opts.end);
        scannedSamples += data.timestamps.length;

        let result: TimeRange = data;
        if (opts.transform) {
          result = aggregate([data], opts.transform, opts.step);
        }

        series.push({
          labels: storage.labels(id) ?? new Map(),
          timestamps: result.timestamps,
          values: result.values,
        });
      }
      return { series, scannedSeries: ids.length, scannedSamples };
    }

    if (opts.step && storage.scanParts && !opts.transform && isSimpleStepAgg(opts.agg)) {
      return streamStepAggregateByGroup(storage, ids, {
        ...opts,
        step: opts.step,
        agg: opts.agg,
      });
    }

    // With aggregation — read all, group, aggregate.
    const groups = new Map<string, { labels: Labels; ranges: TimeRange[] }>();

    for (const id of ids) {
      // For step queries, use readParts to skip the concatRanges allocation.
      // stepAggregate only needs per-bucket folding, so individual chunk parts
      // work just as well as one big concatenated array.
      let parts: TimeRange[];
      if (opts.step && storage.readParts) {
        parts = storage.readParts(id, opts.start, opts.end);
      } else {
        parts = [storage.read(id, opts.start, opts.end)];
      }
      for (const p of parts) scannedSamples += chunkSampleCount(p);
      const labels = storage.labels(id) ?? new Map();
      const groupKey = opts.groupBy
        ? opts.groupBy.map((k) => labels.get(k) ?? "").join("\0")
        : "__all__";

      let group = groups.get(groupKey);
      if (!group) {
        const groupLabels = new Map<string, string>();
        groupLabels.set("__name__", opts.metric);
        if (opts.groupBy) {
          for (const k of opts.groupBy) {
            const v = labels.get(k);
            if (v !== undefined) groupLabels.set(k, v);
          }
        }
        group = { labels: groupLabels, ranges: [] };
        groups.set(groupKey, group);
      }
      for (const p of parts) group.ranges.push(p);
    }

    // Aggregate each group.
    const series: SeriesResult[] = [];
    for (const [, group] of groups) {
      const result = aggregate(group.ranges, opts.agg, opts.step);
      series.push({
        labels: group.labels,
        timestamps: result.timestamps,
        values: result.values,
      });
    }

    return { series, scannedSeries: ids.length, scannedSamples };
  }
}

function isSimpleStepAgg(fn: AggFn): fn is SimpleStepAgg {
  return (
    fn === "sum" || fn === "avg" || fn === "min" || fn === "max" || fn === "count" || fn === "last"
  );
}

function makeGroupLabels(
  metric: string,
  groupBy: readonly string[] | undefined,
  labels: Labels
): Labels {
  const groupLabels = new Map<string, string>();
  groupLabels.set("__name__", metric);
  if (groupBy) {
    for (const k of groupBy) {
      const v = labels.get(k);
      if (v !== undefined) groupLabels.set(k, v);
    }
  }
  return groupLabels;
}

function streamStepAggregateByGroup(
  storage: StorageBackend,
  ids: SeriesId[],
  opts: QueryOpts & { step: bigint; agg: SimpleStepAgg }
): QueryResult {
  const scanParts = storage.scanParts;
  if (!scanParts) {
    throw new Error("streamStepAggregateByGroup requires scanParts()");
  }

  const groups = new Map<string, { labels: Labels; state: ReturnType<typeof createStepState> }>();
  let scannedSamples = 0;

  // Single-pass scan: use the query time range (opts.start/opts.end) to size
  // step buckets up front, then accumulate in one pass over each series.
  for (const id of ids) {
    const labels = storage.labels(id) ?? new Map();
    const groupKey = opts.groupBy
      ? opts.groupBy.map((k) => labels.get(k) ?? "").join("\0")
      : "__all__";
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        labels: makeGroupLabels(opts.metric, opts.groupBy, labels),
        state: createStepState(opts.agg, opts.step, opts.start, opts.end),
      };
      groups.set(groupKey, group);
    }
    scanParts.call(storage, id, opts.start, opts.end, (part) => {
      scannedSamples += chunkSampleCount(part);
      group.state.addPart(part);
    });
  }

  const series: SeriesResult[] = [];
  for (const [, group] of groups) {
    const result = group.state.finish();
    series.push({
      labels: group.labels,
      timestamps: result.timestamps,
      values: result.values,
    });
  }
  return { series, scannedSeries: ids.length, scannedSamples };
}

function createStepState(fn: SimpleStepAgg, step: bigint, minT: bigint, maxT: bigint) {
  const bucketCountBig = (maxT - minT) / step + 1n;
  if (bucketCountBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `bucket count ${bucketCountBig} exceeds Number.MAX_SAFE_INTEGER; step=${step} range=${maxT - minT}`
    );
  }
  const bucketCount = Number(bucketCountBig);
  const timestamps = new BigInt64Array(bucketCount);
  const values = new Float64Array(bucketCount);
  const counts = new Float64Array(bucketCount);
  const lastTsTracker = fn === "last" ? new Float64Array(bucketCount).fill(-Infinity) : undefined;
  const minTN = Number(minT);
  const stepN = Number(step);

  for (let i = 0; i < bucketCount; i++) {
    timestamps[i] = minT + BigInt(i) * step;
  }
  values.fill(aggInit(fn));

  const accumulate = _makeAccumulator(fn, values, counts, minTN, stepN, lastTsTracker);

  return {
    addPart(part: TimeRange): void {
      if (hasChunkStats(part) && part.chunkMinT !== undefined && part.chunkMaxT !== undefined) {
        const chunkMinTN = Number(part.chunkMinT - minT) + minTN;
        const chunkMaxTN = Number(part.chunkMaxT - minT) + minTN;
        const bucketLo = ((chunkMinTN - minTN) / stepN) | 0;
        const bucketHi = ((chunkMaxTN - minTN) / stepN) | 0;
        if (bucketLo === bucketHi) {
          _foldStats(fn, part, values, counts, bucketLo, chunkMaxTN, lastTsTracker);
          return;
        }
        if (
          fn === "count" &&
          foldRegularCountByStats(
            chunkSampleCount(part),
            chunkMinTN,
            chunkMaxTN,
            values,
            counts,
            minTN,
            stepN
          )
        ) {
          return;
        }
        if (part.decode) {
          const decoded = part.decodeView ? part.decodeView() : part.decode();
          accumulate(decoded.timestamps, decoded.values, chunkMinTN, chunkMaxTN);
          return;
        }
      }

      if (part.timestamps.length > 0) {
        const materialized = materializeRange(part);
        accumulate(materialized.timestamps, materialized.values);
      }
    },
    finish(): TimeRange {
      aggFinalize(values, counts, fn);
      if (fn !== "sum" && fn !== "count") {
        for (let i = 0; i < bucketCount; i++) {
          if (counts[i] === 0) values[i] = NaN;
        }
      }
      return { timestamps, values };
    },
  };
}

// ── Aggregation ──────────────────────────────────────────────────────

/** Map percentile AggFn to its fractional value (0..1). */
function percentileFraction(fn: AggFn): number | undefined {
  switch (fn) {
    case "p50":
      return 0.5;
    case "p90":
      return 0.9;
    case "p95":
      return 0.95;
    case "p99":
      return 0.99;
    default:
      return undefined;
  }
}

/** Initial accumulator value for a given aggregation function. */
function aggInit(fn: AggFn): number {
  if (fn === "min") return Infinity;
  if (fn === "max") return -Infinity;
  return 0;
}

/** Fold a new value into an accumulator for the given agg function. */
function aggAccumulate(accum: number, v: number, fn: AggFn): number {
  switch (fn) {
    case "sum":
    case "avg":
      return accum + v;
    case "min":
      return v < accum ? v : accum;
    case "max":
      return v > accum ? v : accum;
    case "count":
      return accum + 1;
    case "last":
      return v;
    default:
      return accum;
  }
}

/** Finalize aggregated buckets (e.g. divide by count for avg). */
function aggFinalize(values: Float64Array, counts: Float64Array, fn: AggFn): void {
  if (fn === "avg") {
    for (let i = 0; i < values.length; i++) {
      const count = counts[i];
      if (count > 0) {
        values[i] = values[i] / count;
      }
    }
  }
}

function aggregate(ranges: TimeRange[], fn: AggFn, step?: bigint): TimeRange {
  if (ranges.length === 0) {
    return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  }

  if (!step && percentileFraction(fn) !== undefined) {
    throw new Error(
      `Percentile aggregation '${fn}' requires step(). Use .step() to set a bucket interval.`
    );
  }

  if (!step) {
    // No step alignment — point-by-point aggregation aligned to first series.
    return pointAggregate(ranges, fn);
  }

  // Step-aligned bucketing.
  return stepAggregate(ranges, fn, step);
}

function materializeRange(range: TimeRange): TimeRange {
  if ((range.timestamps.length > 0 && range.values.length > 0) || !range.decode) {
    return range;
  }
  return range.decodeView ? range.decodeView() : range.decode();
}

function pointAggregate(ranges: TimeRange[], fn: AggFn): TimeRange {
  // Use the longest series as the timestamp base.
  let longest = materializeRange(readItemAt(ranges, 0, "range"));
  for (const r of ranges) {
    const materialized = materializeRange(r);
    if (materialized.timestamps.length > longest.timestamps.length) longest = materialized;
  }

  const timestamps = longest.timestamps;
  const values = new Float64Array(timestamps.length);

  if (fn === "rate" || fn === "increase" || fn === "irate" || fn === "delta") {
    if (ranges.length !== 1) {
      throw new Error(
        `${fn}() without a subsequent aggregation must be evaluated per series (got ${ranges.length} ranges)`
      );
    }
    const src = materializeRange(readItemAt(ranges, 0, "range"));
    if (fn === "irate") {
      for (let i = 1; i < src.timestamps.length; i++) {
        const currentValue = readNumberAt(src.values, i, "point value");
        const previousValue = readNumberAt(src.values, i - 1, "point value");
        const currentTimestamp = readBigIntAt(src.timestamps, i, "point timestamp");
        const previousTimestamp = readBigIntAt(src.timestamps, i - 1, "point timestamp");
        const delta = currentValue - previousValue;
        const dt = Number(currentTimestamp - previousTimestamp) / 1000;
        values[i] = dt > 0 ? (delta >= 0 ? delta : currentValue) / dt : 0;
      }
    } else if (fn === "delta") {
      // Raw difference — no counter-reset handling
      for (let i = 1; i < src.timestamps.length; i++) {
        const currentValue = readNumberAt(src.values, i, "point value");
        const previousValue = readNumberAt(src.values, i - 1, "point value");
        values[i] = currentValue - previousValue;
      }
    } else {
      for (let i = 1; i < src.timestamps.length; i++) {
        const currentValue = readNumberAt(src.values, i, "point value");
        const previousValue = readNumberAt(src.values, i - 1, "point value");
        if (fn === "increase") {
          const delta = currentValue - previousValue;
          values[i] = delta >= 0 ? delta : currentValue;
        } else {
          const currentTimestamp = readBigIntAt(src.timestamps, i, "point timestamp");
          const previousTimestamp = readBigIntAt(src.timestamps, i - 1, "point timestamp");
          const dt = Number(currentTimestamp - previousTimestamp) / 1000;
          const delta = currentValue - previousValue;
          values[i] = dt > 0 ? (delta >= 0 ? delta : currentValue) / dt : 0;
        }
      }
    }
    return { timestamps, values };
  }

  values.fill(aggInit(fn));
  const counts = new Float64Array(timestamps.length);

  for (const r of ranges) {
    const materialized = materializeRange(r);
    // Simple: assume aligned timestamps. Real engine would merge-sort.
    const len = Math.min(materialized.values.length, timestamps.length);
    for (let i = 0; i < len; i++) {
      values[i] = aggAccumulate(
        readNumberAt(values, i, "aggregate value"),
        readNumberAt(materialized.values, i, "range value"),
        fn
      );
      counts[i] = readNumberAt(counts, i, "aggregate count") + 1;
    }
  }

  aggFinalize(values, counts, fn);
  return { timestamps, values };
}

/**
 * Platform endianness flag for DataView reads.
 */
const _le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function stepAggregate(ranges: TimeRange[], fn: AggFn, step: bigint): TimeRange {
  // Find time bounds (account for both sample-bearing and stats-only parts).
  let minT = BigInt("9223372036854775807");
  let maxT = -minT;
  for (let ri = 0; ri < ranges.length; ri++) {
    const r = readItemAt(ranges, ri, "range");
    const chunkBounds = readChunkBounds(r, ri);
    if (r.timestamps.length > 0) {
      const firstTimestamp = readBigIntAt(r.timestamps, 0, "range timestamp");
      const lastTimestamp = readBigIntAt(r.timestamps, r.timestamps.length - 1, "range timestamp");
      if (firstTimestamp < minT) minT = firstTimestamp;
      if (lastTimestamp > maxT) maxT = lastTimestamp;
    } else if (hasChunkStats(r) && chunkBounds) {
      const [chunkMinT, chunkMaxT] = chunkBounds;
      if (chunkMinT < minT) minT = chunkMinT;
      if (chunkMaxT > maxT) maxT = chunkMaxT;
    }
  }

  if (minT > maxT) {
    return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  }

  const bucketCount = Number((maxT - minT) / step) + 1;
  const timestamps = new BigInt64Array(bucketCount);
  const values = new Float64Array(bucketCount);
  const counts = new Float64Array(bucketCount);

  for (let i = 0; i < bucketCount; i++) {
    timestamps[i] = minT + BigInt(i) * step;
  }

  const minTN = Number(minT);
  const stepN = Number(step);

  values.fill(aggInit(fn));

  // ── Fused stats-skip + decode + bucket accumulation ──
  //
  // Process each range inline: either fold pre-computed chunk stats when the
  // chunk fits in one bucket, or decode and immediately accumulate into
  // buckets.  This avoids collecting all decoded ranges into a temporary
  // array, reducing peak memory from O(total_chunks × chunk_size) to
  // O(chunk_size) and cutting GC pressure substantially.
  const pFrac = percentileFraction(fn);
  if (fn === "rate" || fn === "increase") {
    _stepAggregateRate(ranges, values, counts, bucketCount, minT, minTN, stepN, fn === "increase");
  } else if (fn === "irate") {
    _stepAggregateIrate(ranges, values, counts, bucketCount, minT, minTN, stepN);
  } else if (fn === "delta") {
    _stepAggregateRate(ranges, values, counts, bucketCount, minT, minTN, stepN, true, true);
  } else if (pFrac !== undefined) {
    _stepAggregatePercentile(ranges, values, counts, bucketCount, minT, minTN, stepN, pFrac);
  } else {
    // Track timestamps for "last" aggregation to ensure temporal correctness
    // when chunks from multiple series contribute to the same bucket.
    const lastTsTracker = fn === "last" ? new Float64Array(bucketCount).fill(-Infinity) : undefined;
    const accumulate = _makeAccumulator(fn, values, counts, minTN, stepN, lastTsTracker);
    for (let ri = 0; ri < ranges.length; ri++) {
      const r = readItemAt(ranges, ri, "range");
      if (hasChunkStats(r) && r.chunkMinT !== undefined && r.chunkMaxT !== undefined) {
        const chunkMinTN = Number(r.chunkMinT - minT) + minTN;
        const chunkMaxTN = Number(r.chunkMaxT - minT) + minTN;
        const bucketLo = ((chunkMinTN - minTN) / stepN) | 0;
        const bucketHi = ((chunkMaxTN - minTN) / stepN) | 0;
        if (bucketLo === bucketHi) {
          // Entire chunk maps to one bucket — fold stats directly.
          _foldStats(fn, r, values, counts, bucketLo, chunkMaxTN, lastTsTracker);
          continue;
        }
        if (
          fn === "count" &&
          foldRegularCountByStats(
            chunkSampleCount(r),
            chunkMinTN,
            chunkMaxTN,
            values,
            counts,
            minTN,
            stepN
          )
        ) {
          continue;
        }
        // Chunk spans multiple buckets — decode and accumulate inline.
        if (r.decode) {
          const decoded = r.decodeView ? r.decodeView() : r.decode();
          accumulate(decoded.timestamps, decoded.values, chunkMinTN, chunkMaxTN);
          continue;
        }
      }
      // Already-decoded range (hot chunk or pre-filtered).
      if (r.timestamps.length > 0) {
        accumulate(r.timestamps, r.values);
      }
    }
  }

  aggFinalize(values, counts, fn);

  // Replace init-value sentinels with NaN in empty buckets so consumers
  // see "no data" instead of Infinity / -Infinity / 0.
  if (fn !== "sum" && fn !== "count") {
    for (let i = 0; i < bucketCount; i++) {
      if (readNumberAt(counts, i, "bucket count") === 0) values[i] = NaN;
    }
  }

  return { timestamps, values };
}

/** Fold pre-computed chunk stats into a single bucket. */
function _foldStats(
  fn: AggFn,
  range: TimeRange,
  values: Float64Array,
  counts: Float64Array,
  bucket: number,
  chunkMaxTN?: number,
  lastTsTracker?: Float64Array
): void {
  const minV = readChunkStat(range, STATS_MIN, "chunk min");
  const maxV = readChunkStat(range, STATS_MAX, "chunk max");
  const sum = readChunkStat(range, STATS_SUM, "chunk sum");
  const count = readChunkStat(range, STATS_COUNT, "chunk count");
  const lastV = readChunkStat(range, STATS_LAST, "chunk last");
  switch (fn) {
    case "min":
      if (minV < values[bucket]) values[bucket] = minV;
      break;
    case "max":
      if (maxV > values[bucket]) values[bucket] = maxV;
      break;
    case "sum":
    case "avg":
      values[bucket] += sum;
      break;
    case "count":
      values[bucket] += count;
      break;
    case "last":
      // Use chunk maxT to ensure temporally-last value wins across series.
      if (lastTsTracker && chunkMaxTN !== undefined) {
        if (chunkMaxTN >= lastTsTracker[bucket]) {
          lastTsTracker[bucket] = chunkMaxTN;
          values[bucket] = lastV;
        }
      } else {
        values[bucket] = lastV;
      }
      break;
  }
  counts[bucket] += count;
}

type RegularChunkMeta = {
  interval: number;
  chunkMinTN: number;
};

function regularChunkMetaFromLength(
  len: number,
  chunkMinTN?: number,
  chunkMaxTN?: number
): RegularChunkMeta | null {
  if (len < 2 || chunkMinTN === undefined || chunkMaxTN === undefined) {
    return null;
  }
  const span = chunkMaxTN - chunkMinTN;
  if (span <= 0 || span % (len - 1) !== 0) {
    return null;
  }
  return {
    interval: span / (len - 1),
    chunkMinTN,
  };
}

function regularChunkMeta(
  ts: BigInt64Array,
  chunkMinTN?: number,
  chunkMaxTN?: number
): RegularChunkMeta | null {
  return regularChunkMetaFromLength(ts.length, chunkMinTN, chunkMaxTN);
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

function forEachRegularBucketSegment(
  len: number,
  chunkMinTN: number,
  interval: number,
  minTN: number,
  stepN: number,
  visit: (bucket: number, start: number, end: number, lastTN: number) => void
): void {
  let start = 0;
  while (start < len) {
    const sampleTN = chunkMinTN + start * interval;
    const bucket = ((sampleTN - minTN) / stepN) | 0;
    const bucketEndTN = minTN + (bucket + 1) * stepN;
    const nextStart = Math.min(
      len,
      Math.max(start + 1, ceilDiv(bucketEndTN - chunkMinTN, interval))
    );
    visit(bucket, start, nextStart, chunkMinTN + (nextStart - 1) * interval);
    start = nextStart;
  }
}

function foldRegularCountByStats(
  sampleCount: number,
  chunkMinTN: number,
  chunkMaxTN: number,
  values: Float64Array,
  counts: Float64Array,
  minTN: number,
  stepN: number
): boolean {
  if (sampleCount <= 0) return true;
  if (sampleCount === 1) {
    const bucket = ((chunkMinTN - minTN) / stepN) | 0;
    values[bucket] = readNumberAt(values, bucket, "bucket value") + 1;
    counts[bucket] = readNumberAt(counts, bucket, "bucket count") + 1;
    return true;
  }
  const regular = regularChunkMetaFromLength(sampleCount, chunkMinTN, chunkMaxTN);
  if (!regular) return false;
  forEachRegularBucketSegment(
    sampleCount,
    regular.chunkMinTN,
    regular.interval,
    minTN,
    stepN,
    (bucket, start, end) => {
      const count = end - start;
      values[bucket] = readNumberAt(values, bucket, "bucket value") + count;
      counts[bucket] = readNumberAt(counts, bucket, "bucket count") + count;
    }
  );
  return true;
}

function sumRange(values: Float64Array, start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i++) {
    total += readNumberAtUnchecked(values, i);
  }
  return total;
}

function minRange(values: Float64Array, start: number, end: number): number {
  let min = readNumberAtUnchecked(values, start);
  for (let i = start + 1; i < end; i++) {
    const value = readNumberAtUnchecked(values, i);
    if (value < min) min = value;
  }
  return min;
}

function maxRange(values: Float64Array, start: number, end: number): number {
  let max = readNumberAtUnchecked(values, start);
  for (let i = start + 1; i < end; i++) {
    const value = readNumberAtUnchecked(values, i);
    if (value > max) max = value;
  }
  return max;
}

/**
 * Return a closure that accumulates a decoded range into buckets.
 * The switch on `fn` happens once at construction time (not per-sample).
 */
function _makeAccumulator(
  fn: AggFn,
  values: Float64Array,
  counts: Float64Array,
  minTN: number,
  stepN: number,
  lastTsTracker?: Float64Array
): (ts: BigInt64Array, vs: Float64Array, chunkMinTN?: number, chunkMaxTN?: number) => void {
  // Read a single i64 timestamp from BigInt64Array via DataView.
  const readTs = (dv: DataView, i: number): number => {
    const off = i << 3;
    return dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le);
  };

  // For regular-interval chunks (the common case: fixed scrape interval),
  // compute bucket indices arithmetically from sample index instead of
  // reading every timestamp via DataView. Uses chunk metadata (minT, maxT)
  // to derive the interval reliably: interval = (maxT - minT) / (count - 1).
  // Falls back to per-sample DataView reads when metadata is unavailable or
  // the derived interval doesn't divide evenly (irregular timestamps).
  const accumulate = (
    ts: BigInt64Array,
    vs: Float64Array,
    fold: (bucket: number, v: number) => void,
    chunkMinTN?: number,
    chunkMaxTN?: number
  ): void => {
    const len = ts.length;
    if (len === 0) return;
    if (len >= 2 && chunkMinTN !== undefined && chunkMaxTN !== undefined) {
      const span = chunkMaxTN - chunkMinTN;
      if (span > 0 && span % (len - 1) === 0) {
        const interval = span / (len - 1);
        const base = chunkMinTN - minTN;
        for (let i = 0; i < len; i++) {
          fold(((base + i * interval) / stepN) | 0, readNumberAtUnchecked(vs, i));
        }
        return;
      }
    }
    const dv = new DataView(ts.buffer, ts.byteOffset, ts.byteLength);
    for (let i = 0; i < len; i++) {
      fold(((readTs(dv, i) - minTN) / stepN) | 0, readNumberAtUnchecked(vs, i));
    }
  };

  // Timestamp-aware accumulate for "last" — tracks per-sample timestamps.
  const accumulateWithTs = (
    ts: BigInt64Array,
    vs: Float64Array,
    fold: (bucket: number, v: number, t: number) => void,
    chunkMinTN?: number,
    chunkMaxTN?: number
  ): void => {
    const len = ts.length;
    if (len === 0) return;
    if (len >= 2 && chunkMinTN !== undefined && chunkMaxTN !== undefined) {
      const span = chunkMaxTN - chunkMinTN;
      if (span > 0 && span % (len - 1) === 0) {
        const interval = span / (len - 1);
        const base = chunkMinTN - minTN;
        for (let i = 0; i < len; i++) {
          const t = chunkMinTN + i * interval;
          fold(((base + i * interval) / stepN) | 0, readNumberAtUnchecked(vs, i), t);
        }
        return;
      }
    }
    const dv = new DataView(ts.buffer, ts.byteOffset, ts.byteLength);
    for (let i = 0; i < len; i++) {
      const t = readTs(dv, i);
      fold(((t - minTN) / stepN) | 0, readNumberAtUnchecked(vs, i), t);
    }
  };

  switch (fn) {
    case "min":
      return (ts, vs, cMin, cMax) => {
        const regular = regularChunkMeta(ts, cMin, cMax);
        if (regular) {
          forEachRegularBucketSegment(
            ts.length,
            regular.chunkMinTN,
            regular.interval,
            minTN,
            stepN,
            (bucket, start, end) => {
              const min = minRange(vs, start, end);
              if (min < values[bucket]) values[bucket] = min;
              counts[bucket] += end - start;
            }
          );
          return;
        }
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            if (v < values[bucket]) values[bucket] = v;
            counts[bucket] += 1;
          },
          cMin,
          cMax
        );
      };
    case "max":
      return (ts, vs, cMin, cMax) => {
        const regular = regularChunkMeta(ts, cMin, cMax);
        if (regular) {
          forEachRegularBucketSegment(
            ts.length,
            regular.chunkMinTN,
            regular.interval,
            minTN,
            stepN,
            (bucket, start, end) => {
              const max = maxRange(vs, start, end);
              if (max > values[bucket]) values[bucket] = max;
              counts[bucket] += end - start;
            }
          );
          return;
        }
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            if (v > values[bucket]) values[bucket] = v;
            counts[bucket] += 1;
          },
          cMin,
          cMax
        );
      };
    case "sum":
    case "avg":
      return (ts, vs, cMin, cMax) => {
        const regular = regularChunkMeta(ts, cMin, cMax);
        if (regular) {
          forEachRegularBucketSegment(
            ts.length,
            regular.chunkMinTN,
            regular.interval,
            minTN,
            stepN,
            (bucket, start, end) => {
              values[bucket] += sumRange(vs, start, end);
              counts[bucket] += end - start;
            }
          );
          return;
        }
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            values[bucket] += v;
            counts[bucket] += 1;
          },
          cMin,
          cMax
        );
      };
    case "count":
      return (ts, _vs, cMin, cMax) => {
        const regular = regularChunkMeta(ts, cMin, cMax);
        if (regular) {
          forEachRegularBucketSegment(
            ts.length,
            regular.chunkMinTN,
            regular.interval,
            minTN,
            stepN,
            (bucket, start, end) => {
              const count = end - start;
              values[bucket] += count;
              counts[bucket] += count;
            }
          );
          return;
        }
        accumulate(
          ts,
          _vs,
          (bucket, _v) => {
            values[bucket] += 1;
            counts[bucket] += 1;
          },
          cMin,
          cMax
        );
      };
    case "last":
      if (lastTsTracker) {
        return (ts, vs, cMin, cMax) => {
          const regular = regularChunkMeta(ts, cMin, cMax);
          if (regular) {
            forEachRegularBucketSegment(
              ts.length,
              regular.chunkMinTN,
              regular.interval,
              minTN,
              stepN,
              (bucket, start, end, lastTN) => {
                if (lastTN >= lastTsTracker[bucket]) {
                  lastTsTracker[bucket] = lastTN;
                  values[bucket] = readNumberAtUnchecked(vs, end - 1);
                }
                counts[bucket] += end - start;
              }
            );
            return;
          }
          accumulateWithTs(
            ts,
            vs,
            (bucket, v, t) => {
              if (t >= lastTsTracker[bucket]) {
                lastTsTracker[bucket] = t;
                values[bucket] = v;
              }
              counts[bucket] += 1;
            },
            cMin,
            cMax
          );
        };
      }
      return (ts, vs, cMin, cMax) => {
        const regular = regularChunkMeta(ts, cMin, cMax);
        if (regular) {
          forEachRegularBucketSegment(
            ts.length,
            regular.chunkMinTN,
            regular.interval,
            minTN,
            stepN,
            (bucket, start, end) => {
              values[bucket] = readNumberAtUnchecked(vs, end - 1);
              counts[bucket] += end - start;
            }
          );
          return;
        }
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            values[bucket] = v;
            counts[bucket] += 1;
          },
          cMin,
          cMax
        );
      };
    default:
      return (ts, vs, cMin, cMax) =>
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            values[bucket] = aggAccumulate(readNumberAt(values, bucket, "bucket value"), v, fn);
            counts[bucket] = readNumberAt(counts, bucket, "bucket count") + 1;
          },
          cMin,
          cMax
        );
  }
}

/**
 * Rate/increase/delta aggregation — needs per-bucket first/last tracking.
 * Handles stats-only parts by decoding them inline.
 * When isIncrease is true, returns delta (last - first) without dividing by time.
 * When rawDelta is true, skips counter-reset handling (for delta()).
 */
function _stepAggregateRate(
  ranges: TimeRange[],
  values: Float64Array,
  counts: Float64Array,
  bucketCount: number,
  minT: bigint,
  minTN: number,
  stepN: number,
  isIncrease = false,
  rawDelta = false
): void {
  const firstTs = new Float64Array(bucketCount).fill(Infinity);
  const firstVal = new Float64Array(bucketCount);
  const lastTs = new Float64Array(bucketCount).fill(-Infinity);
  const lastVal = new Float64Array(bucketCount);

  for (let ri = 0; ri < ranges.length; ri++) {
    const r = readItemAt(ranges, ri, "range");
    // Rate needs per-sample timestamps — always decode stats-only parts.
    const decoded = materializeRange(r);
    const src = decoded.timestamps;
    const len = src.length;
    if (len === 0) continue;
    const vs = decoded.values;

    // Use chunk metadata to derive interval when available.
    const chunkBounds = readChunkBounds(r, ri);
    if (len >= 2 && chunkBounds) {
      const [chunkMinT, chunkMaxT] = chunkBounds;
      const chunkMinTN = Number(chunkMinT - minT) + minTN;
      const chunkMaxTN = Number(chunkMaxT - minT) + minTN;
      const span = chunkMaxTN - chunkMinTN;
      if (span > 0 && span % (len - 1) === 0) {
        const interval = span / (len - 1);
        const base = chunkMinTN - minTN;
        for (let i = 0; i < len; i++) {
          const t = chunkMinTN + i * interval;
          const bucket = ((base + i * interval) / stepN) | 0;
          counts[bucket] = readNumberAt(counts, bucket, "bucket count") + 1;
          if (t < readNumberAt(firstTs, bucket, "first timestamp")) {
            firstTs[bucket] = t;
            firstVal[bucket] = readNumberAtUnchecked(vs, i);
          }
          if (t >= readNumberAt(lastTs, bucket, "last timestamp")) {
            lastTs[bucket] = t;
            lastVal[bucket] = readNumberAtUnchecked(vs, i);
          }
        }
        continue;
      }
    }
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const readTs = (j: number): number => {
      const off = j << 3;
      return dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le);
    };
    for (let i = 0; i < len; i++) {
      const t = readTs(i);
      const bucket = ((t - minTN) / stepN) | 0;
      counts[bucket] = readNumberAt(counts, bucket, "bucket count") + 1;
      if (t < readNumberAt(firstTs, bucket, "first timestamp")) {
        firstTs[bucket] = t;
        firstVal[bucket] = readNumberAtUnchecked(vs, i);
      }
      if (t >= readNumberAt(lastTs, bucket, "last timestamp")) {
        lastTs[bucket] = t;
        lastVal[bucket] = readNumberAtUnchecked(vs, i);
      }
    }
  }
  for (let i = 0; i < bucketCount; i++) {
    if (isIncrease) {
      const delta =
        readNumberAt(lastVal, i, "last value") - readNumberAt(firstVal, i, "first value");
      if (rawDelta) {
        values[i] = delta; // delta(): no counter-reset handling
      } else {
        values[i] = delta >= 0 ? delta : readNumberAt(lastVal, i, "last value"); // counter reset: use last value
      }
    } else {
      const delta =
        readNumberAt(lastVal, i, "last value") - readNumberAt(firstVal, i, "first value");
      const dt =
        (readNumberAt(lastTs, i, "last timestamp") - readNumberAt(firstTs, i, "first timestamp")) /
        1000;
      values[i] = dt > 0 ? (delta >= 0 ? delta : readNumberAt(lastVal, i, "last value")) / dt : 0;
    }
  }
}

/**
 * Instant rate (irate) — per-bucket rate from only the last two samples.
 * Tracks the two most-recent samples per bucket instead of first/last.
 */
function _stepAggregateIrate(
  ranges: TimeRange[],
  values: Float64Array,
  counts: Float64Array,
  bucketCount: number,
  minT: bigint,
  minTN: number,
  stepN: number
): void {
  // Track the two latest samples per bucket
  const lastTs = new Float64Array(bucketCount).fill(-Infinity);
  const lastVal = new Float64Array(bucketCount);
  const secondTs = new Float64Array(bucketCount).fill(-Infinity);
  const secondVal = new Float64Array(bucketCount);

  const insertSample = (bucket: number, t: number, v: number): void => {
    if (t > readNumberAt(lastTs, bucket, "last timestamp")) {
      secondTs[bucket] = readNumberAt(lastTs, bucket, "last timestamp");
      secondVal[bucket] = readNumberAt(lastVal, bucket, "last value");
      lastTs[bucket] = t;
      lastVal[bucket] = v;
    } else if (t === readNumberAt(lastTs, bucket, "last timestamp")) {
      lastVal[bucket] = v;
    } else if (t > readNumberAt(secondTs, bucket, "second timestamp")) {
      secondTs[bucket] = t;
      secondVal[bucket] = v;
    }
    counts[bucket] = readNumberAt(counts, bucket, "bucket count") + 1;
  };

  for (let ri = 0; ri < ranges.length; ri++) {
    const r = readItemAt(ranges, ri, "range");
    const decoded = materializeRange(r);
    const src = decoded.timestamps;
    const len = src.length;
    if (len === 0) continue;
    const vs = decoded.values;

    const chunkBounds = readChunkBounds(r, ri);
    if (len >= 2 && chunkBounds) {
      const [chunkMinT, chunkMaxT] = chunkBounds;
      const chunkMinTN = Number(chunkMinT - minT) + minTN;
      const chunkMaxTN = Number(chunkMaxT - minT) + minTN;
      const span = chunkMaxTN - chunkMinTN;
      if (span > 0 && span % (len - 1) === 0) {
        const interval = span / (len - 1);
        const base = chunkMinTN - minTN;
        for (let i = 0; i < len; i++) {
          const t = chunkMinTN + i * interval;
          const bucket = ((base + i * interval) / stepN) | 0;
          insertSample(bucket, t, readNumberAtUnchecked(vs, i));
        }
        continue;
      }
    }
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const readTs = (j: number): number => {
      const off = j << 3;
      return dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le);
    };
    for (let i = 0; i < len; i++) {
      const t = readTs(i);
      const bucket = ((t - minTN) / stepN) | 0;
      insertSample(bucket, t, readNumberAtUnchecked(vs, i));
    }
  }
  for (let i = 0; i < bucketCount; i++) {
    if (readNumberAt(secondTs, i, "second timestamp") === -Infinity) {
      values[i] = 0; // Only one or zero samples — can't compute rate
    } else {
      const delta =
        readNumberAt(lastVal, i, "last value") - readNumberAt(secondVal, i, "second value");
      const dt =
        (readNumberAt(lastTs, i, "last timestamp") -
          readNumberAt(secondTs, i, "second timestamp")) /
        1000;
      values[i] = dt > 0 ? (delta >= 0 ? delta : readNumberAt(lastVal, i, "last value")) / dt : 0;
    }
  }
}

/**
 * Percentile aggregation — collects all values per bucket, sorts, picks percentile index.
 * Uses the "nearest rank" method: index = ceil(p * n) - 1.
 */
function _stepAggregatePercentile(
  ranges: TimeRange[],
  values: Float64Array,
  counts: Float64Array,
  bucketCount: number,
  minT: bigint,
  minTN: number,
  stepN: number,
  fraction: number
): void {
  const buckets: number[][] = new Array(bucketCount);
  for (let i = 0; i < bucketCount; i++) buckets[i] = [];

  const readTs = (dv: DataView, i: number): number => {
    const off = i << 3;
    return dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le);
  };

  for (let ri = 0; ri < ranges.length; ri++) {
    const r = readItemAt(ranges, ri, "range");
    // Always decode stats-only parts — we need individual values.
    const decoded = materializeRange(r);
    const src = decoded.timestamps;
    const len = src.length;
    if (len === 0) continue;
    const vs = decoded.values;

    // Use chunk metadata for arithmetic bucket indexing when available.
    const chunkBounds = readChunkBounds(r, ri);
    if (len >= 2 && chunkBounds) {
      const [chunkMinT, chunkMaxT] = chunkBounds;
      const chunkMinTN = Number(chunkMinT - minT) + minTN;
      const chunkMaxTN = Number(chunkMaxT - minT) + minTN;
      const span = chunkMaxTN - chunkMinTN;
      if (span > 0 && span % (len - 1) === 0) {
        const interval = span / (len - 1);
        const base = chunkMinTN - minTN;
        for (let i = 0; i < len; i++) {
          readItemAt(buckets, ((base + i * interval) / stepN) | 0, "percentile bucket").push(
            readNumberAtUnchecked(vs, i)
          );
        }
        continue;
      }
    }
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    for (let i = 0; i < len; i++) {
      readItemAt(buckets, ((readTs(dv, i) - minTN) / stepN) | 0, "percentile bucket").push(
        readNumberAtUnchecked(vs, i)
      );
    }
  }

  // Sort each bucket and pick the percentile value.
  for (let i = 0; i < bucketCount; i++) {
    const b = readItemAt(buckets, i, "percentile bucket");
    counts[i] = b.length;
    if (b.length === 0) {
      values[i] = NaN;
      continue;
    }
    b.sort((a, c) => a - c);
    const idx = Math.min(Math.ceil(fraction * b.length) - 1, b.length - 1);
    values[i] = readNumberAt(b, idx, "percentile value");
  }
}
