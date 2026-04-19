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
  QueryEngine,
  QueryOpts,
  QueryResult,
  SeriesResult,
  StorageBackend,
  TimeRange,
} from "./types.js";

/** Galloping lower bound on a sorted number array. */
function gallopLowerBound(arr: number[], target: number, from: number): number {
  if (from >= arr.length) return arr.length;
  if (arr[from]! >= target) return from;
  let step = 1;
  let lo = from + 1;
  let hi = lo;
  while (hi < arr.length && arr[hi]! < target) {
    lo = hi + 1;
    step <<= 1;
    hi = from + step;
  }
  if (hi >= arr.length) hi = arr.length - 1;
  let left = lo;
  let right = hi;
  while (left <= right) {
    const mid = (left + right) >>> 1;
    if (arr[mid]! < target) left = mid + 1;
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
    const v = small[i]!;
    j = gallopLowerBound(big, v, j);
    if (j >= big.length) break;
    if (big[j] === v) out.push(v);
  }
  return out;
}

export class ScanEngine implements QueryEngine {
  readonly name = "scan";

  query(storage: StorageBackend, opts: QueryOpts): QueryResult {
    // Find matching series using sorted-array intersection (no Set allocation).
    let ids = storage.matchLabel("__name__", opts.metric);
    if (opts.matchers) {
      for (const m of opts.matchers) {
        ids = sortedIntersect(ids, storage.matchLabel(m.label, m.value));
      }
    }

    let scannedSamples = 0;

    if (!opts.agg) {
      // No aggregation — return raw series.
      const series: SeriesResult[] = [];
      for (const id of ids) {
        const data = storage.read(id, opts.start, opts.end);
        scannedSamples += data.timestamps.length;
        series.push({
          labels: storage.labels(id) ?? new Map(),
          timestamps: data.timestamps,
          values: data.values,
        });
      }
      return { series, scannedSeries: ids.length, scannedSamples };
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
      for (const p of parts) scannedSamples += p.timestamps.length || p.stats?.count || 0;
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

// ── Aggregation ──────────────────────────────────────────────────────

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
      if (counts[i]! > 0) values[i]! /= counts[i]!;
    }
  }
}

function aggregate(ranges: TimeRange[], fn: AggFn, step?: bigint): TimeRange {
  if (ranges.length === 0) {
    return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  }

  if (!step) {
    // No step alignment — point-by-point aggregation aligned to first series.
    return pointAggregate(ranges, fn);
  }

  // Step-aligned bucketing.
  return stepAggregate(ranges, fn, step);
}

function pointAggregate(ranges: TimeRange[], fn: AggFn): TimeRange {
  // Use the longest series as the timestamp base.
  let longest = ranges[0]!;
  for (const r of ranges) {
    if (r.timestamps.length > longest.timestamps.length) longest = r;
  }

  const timestamps = longest.timestamps;
  const values = new Float64Array(timestamps.length);

  if (fn === "rate") {
    // Rate only makes sense per-series; use first.
    const src = ranges[0]!;
    for (let i = 1; i < src.timestamps.length; i++) {
      const dt = Number(src.timestamps[i]! - src.timestamps[i - 1]!) / 1000; // ms → sec
      values[i] = dt > 0 ? (src.values[i]! - src.values[i - 1]!) / dt : 0;
    }
    return { timestamps, values };
  }

  values.fill(aggInit(fn));
  const counts = new Float64Array(timestamps.length);

  for (const r of ranges) {
    // Simple: assume aligned timestamps. Real engine would merge-sort.
    const len = Math.min(r.values.length, timestamps.length);
    for (let i = 0; i < len; i++) {
      values[i] = aggAccumulate(values[i]!, r.values[i]!, fn);
      counts[i]!++;
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
  for (const r of ranges) {
    if (r.timestamps.length > 0) {
      if (r.timestamps[0]! < minT) minT = r.timestamps[0]!;
      if (r.timestamps[r.timestamps.length - 1]! > maxT)
        maxT = r.timestamps[r.timestamps.length - 1]!;
    } else if (r.stats && r.chunkMinT !== undefined && r.chunkMaxT !== undefined) {
      if (r.chunkMinT < minT) minT = r.chunkMinT;
      if (r.chunkMaxT > maxT) maxT = r.chunkMaxT;
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
  if (fn === "rate") {
    _stepAggregateRate(ranges, values, counts, bucketCount, minT, minTN, stepN);
  } else {
    // Track timestamps for "last" aggregation to ensure temporal correctness
    // when chunks from multiple series contribute to the same bucket.
    const lastTsTracker = fn === "last" ? new Float64Array(bucketCount).fill(-Infinity) : undefined;
    const accumulate = _makeAccumulator(fn, values, counts, minTN, stepN, lastTsTracker);
    for (let ri = 0; ri < ranges.length; ri++) {
      const r = ranges[ri]!;
      if (r.stats && r.chunkMinT !== undefined && r.chunkMaxT !== undefined) {
        const chunkMinTN = Number(r.chunkMinT - minT) + minTN;
        const chunkMaxTN = Number(r.chunkMaxT - minT) + minTN;
        const bucketLo = ((chunkMinTN - minTN) / stepN) | 0;
        const bucketHi = ((chunkMaxTN - minTN) / stepN) | 0;
        if (bucketLo === bucketHi) {
          // Entire chunk maps to one bucket — fold stats directly.
          _foldStats(fn, r.stats, values, counts, bucketLo, chunkMaxTN, lastTsTracker);
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
      if (counts[i]! === 0) values[i] = NaN;
    }
  }

  return { timestamps, values };
}

/** Fold pre-computed chunk stats into a single bucket. */
function _foldStats(
  fn: AggFn,
  st: NonNullable<TimeRange["stats"]>,
  values: Float64Array,
  counts: Float64Array,
  bucket: number,
  chunkMaxTN?: number,
  lastTsTracker?: Float64Array
): void {
  switch (fn) {
    case "min":
      if (st.minV < values[bucket]!) values[bucket] = st.minV;
      break;
    case "max":
      if (st.maxV > values[bucket]!) values[bucket] = st.maxV;
      break;
    case "sum":
    case "avg":
      values[bucket]! += st.sum;
      break;
    case "count":
      values[bucket]! += st.count;
      break;
    case "last":
      // Use chunk maxT to ensure temporally-last value wins across series.
      if (lastTsTracker && chunkMaxTN !== undefined) {
        if (chunkMaxTN >= lastTsTracker[bucket]!) {
          lastTsTracker[bucket] = chunkMaxTN;
          values[bucket] = st.lastV;
        }
      } else {
        values[bucket] = st.lastV;
      }
      break;
  }
  counts[bucket]! += st.count;
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
          fold(((base + i * interval) / stepN) | 0, vs[i]!);
        }
        return;
      }
    }
    const dv = new DataView(ts.buffer, ts.byteOffset, ts.byteLength);
    for (let i = 0; i < len; i++) {
      fold(((readTs(dv, i) - minTN) / stepN) | 0, vs[i]!);
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
          fold(((base + i * interval) / stepN) | 0, vs[i]!, t);
        }
        return;
      }
    }
    const dv = new DataView(ts.buffer, ts.byteOffset, ts.byteLength);
    for (let i = 0; i < len; i++) {
      const t = readTs(dv, i);
      fold(((t - minTN) / stepN) | 0, vs[i]!, t);
    }
  };

  switch (fn) {
    case "min":
      return (ts, vs, cMin, cMax) =>
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            if (v < values[bucket]!) values[bucket] = v;
            counts[bucket]!++;
          },
          cMin,
          cMax
        );
    case "max":
      return (ts, vs, cMin, cMax) =>
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            if (v > values[bucket]!) values[bucket] = v;
            counts[bucket]!++;
          },
          cMin,
          cMax
        );
    case "sum":
    case "avg":
      return (ts, vs, cMin, cMax) =>
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            values[bucket]! += v;
            counts[bucket]!++;
          },
          cMin,
          cMax
        );
    case "count":
      return (ts, _vs, cMin, cMax) =>
        accumulate(
          ts,
          _vs,
          (bucket, _v) => {
            values[bucket]!++;
            counts[bucket]!++;
          },
          cMin,
          cMax
        );
    case "last":
      if (lastTsTracker) {
        return (ts, vs, cMin, cMax) =>
          accumulateWithTs(
            ts,
            vs,
            (bucket, v, t) => {
              if (t >= lastTsTracker[bucket]!) {
                lastTsTracker[bucket] = t;
                values[bucket] = v;
              }
              counts[bucket]!++;
            },
            cMin,
            cMax
          );
      }
      return (ts, vs, cMin, cMax) =>
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            values[bucket] = v;
            counts[bucket]!++;
          },
          cMin,
          cMax
        );
    default:
      return (ts, vs, cMin, cMax) =>
        accumulate(
          ts,
          vs,
          (bucket, v) => {
            values[bucket] = aggAccumulate(values[bucket]!, v, fn);
            counts[bucket]!++;
          },
          cMin,
          cMax
        );
  }
}

/**
 * Rate aggregation — needs per-bucket first/last tracking.
 * Handles stats-only parts by decoding them inline.
 */
function _stepAggregateRate(
  ranges: TimeRange[],
  values: Float64Array,
  counts: Float64Array,
  bucketCount: number,
  minT: bigint,
  minTN: number,
  stepN: number
): void {
  const firstTs = new Float64Array(bucketCount).fill(Infinity);
  const firstVal = new Float64Array(bucketCount);
  const lastTs = new Float64Array(bucketCount).fill(-Infinity);
  const lastVal = new Float64Array(bucketCount);

  for (let ri = 0; ri < ranges.length; ri++) {
    const r = ranges[ri]!;
    // Rate needs per-sample timestamps — always decode stats-only parts.
    const decoded =
      r.timestamps.length === 0 && r.decode ? (r.decodeView ? r.decodeView() : r.decode()) : r;
    const src = decoded.timestamps;
    const len = src.length;
    if (len === 0) continue;
    const vs = decoded.values;

    // Use chunk metadata to derive interval when available.
    const hasChunkMeta = r.chunkMinT !== undefined && r.chunkMaxT !== undefined;
    if (len >= 2 && hasChunkMeta) {
      const chunkMinTN = Number(r.chunkMinT! - minT) + minTN;
      const chunkMaxTN = Number(r.chunkMaxT! - minT) + minTN;
      const span = chunkMaxTN - chunkMinTN;
      if (span > 0 && span % (len - 1) === 0) {
        const interval = span / (len - 1);
        const base = chunkMinTN - minTN;
        for (let i = 0; i < len; i++) {
          const t = chunkMinTN + i * interval;
          const bucket = ((base + i * interval) / stepN) | 0;
          counts[bucket]!++;
          if (t < firstTs[bucket]!) {
            firstTs[bucket] = t;
            firstVal[bucket] = vs[i]!;
          }
          if (t >= lastTs[bucket]!) {
            lastTs[bucket] = t;
            lastVal[bucket] = vs[i]!;
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
      counts[bucket]!++;
      if (t < firstTs[bucket]!) {
        firstTs[bucket] = t;
        firstVal[bucket] = vs[i]!;
      }
      if (t >= lastTs[bucket]!) {
        lastTs[bucket] = t;
        lastVal[bucket] = vs[i]!;
      }
    }
  }
  for (let i = 0; i < bucketCount; i++) {
    const dt = (lastTs[i]! - firstTs[i]!) / 1000;
    values[i] = dt > 0 ? (lastVal[i]! - firstVal[i]!) / dt : 0;
  }
}
