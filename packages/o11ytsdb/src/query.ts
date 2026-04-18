/**
 * Scan-based query engine — simple but complete.
 *
 * Finds matching series via label index, reads time range from
 * storage, optionally aggregates across series. No fancy indexes
 * or query planning — baseline for comparison with optimized engines.
 */

import type {
  AggFn, Labels, QueryEngine, QueryOpts, QueryResult,
  SeriesResult, StorageBackend, TimeRange,
} from './types.js';

export class ScanEngine implements QueryEngine {
  readonly name = 'scan';

  query(storage: StorageBackend, opts: QueryOpts): QueryResult {
    // Find matching series.
    let ids = storage.matchLabel('__name__', opts.metric);
    if (opts.matchers) {
      for (const m of opts.matchers) {
        const mIds = new Set(storage.matchLabel(m.label, m.value));
        ids = ids.filter(id => mIds.has(id));
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
        ? opts.groupBy.map(k => labels.get(k) ?? '').join('\0')
        : '__all__';

      let group = groups.get(groupKey);
      if (!group) {
        const groupLabels = new Map<string, string>();
        groupLabels.set('__name__', opts.metric);
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
  if (fn === 'min') return Infinity;
  if (fn === 'max') return -Infinity;
  return 0;
}

/** Fold a new value into an accumulator for the given agg function. */
function aggAccumulate(accum: number, v: number, fn: AggFn): number {
  switch (fn) {
    case 'sum': case 'avg': return accum + v;
    case 'min': return v < accum ? v : accum;
    case 'max': return v > accum ? v : accum;
    case 'count': return accum + 1;
    case 'last': return v;
    default: return accum;
  }
}

/** Finalize aggregated buckets (e.g. divide by count for avg). */
function aggFinalize(values: Float64Array, counts: Float64Array, fn: AggFn): void {
  if (fn === 'avg') {
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

  if (fn === 'rate') {
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
  let minT = BigInt('9223372036854775807');
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

  // ── Stats-skip: fold pre-computed chunk stats when the chunk fits in one bucket ──
  // Remaining ranges that need sample-level iteration.
  let sampleRanges: TimeRange[];
  if (fn !== 'rate') {
    sampleRanges = [];
    for (let ri = 0; ri < ranges.length; ri++) {
      const r = ranges[ri]!;
      if (r.stats && r.chunkMinT !== undefined && r.chunkMaxT !== undefined) {
        const bucketLo = Number(r.chunkMinT - minT) / stepN | 0;
        const bucketHi = Number(r.chunkMaxT - minT) / stepN | 0;
        if (bucketLo === bucketHi) {
          // Entire chunk maps to one bucket — fold stats directly.
          const st = r.stats;
          switch (fn) {
            case 'min':
              if (st.minV < values[bucketLo]!) values[bucketLo] = st.minV;
              break;
            case 'max':
              if (st.maxV > values[bucketLo]!) values[bucketLo] = st.maxV;
              break;
            case 'sum': case 'avg':
              values[bucketLo]! += st.sum;
              break;
            case 'count':
              values[bucketLo]! += st.count;
              break;
            case 'last':
              values[bucketLo] = st.lastV;
              break;
          }
          counts[bucketLo]! += st.count;
          continue;
        }
        // Chunk spans multiple buckets — lazy-decode to get actual samples.
        if (r.decode) {
          sampleRanges.push(r.decode());
          continue;
        }
      }
      sampleRanges.push(r);
    }
  } else {
    // Rate needs per-sample timestamps — always decode stats-only parts.
    sampleRanges = ranges.map(r =>
      r.timestamps.length === 0 && r.decode ? r.decode() : r,
    );
  }

  // Fused DataView + bucket assignment: read BigInt64 timestamps directly
  // via DataView in the accumulation loop, avoiding a separate Float64Array
  // allocation per range.  Each range creates one lightweight DataView
  // instead of a full Float64Array copy.
  switch (fn) {
    case 'min':
      for (let ri = 0; ri < sampleRanges.length; ri++) {
        const src = sampleRanges[ri]!.timestamps;
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const vs = sampleRanges[ri]!.values;
        for (let i = 0, len = src.length; i < len; i++) {
          const off = i << 3;
          const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
          if (vs[i]! < values[bucket]!) values[bucket] = vs[i]!;
          counts[bucket]!++;
        }
      }
      break;
    case 'max':
      for (let ri = 0; ri < sampleRanges.length; ri++) {
        const src = sampleRanges[ri]!.timestamps;
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const vs = sampleRanges[ri]!.values;
        for (let i = 0, len = src.length; i < len; i++) {
          const off = i << 3;
          const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
          if (vs[i]! > values[bucket]!) values[bucket] = vs[i]!;
          counts[bucket]!++;
        }
      }
      break;
    case 'sum': case 'avg':
      for (let ri = 0; ri < sampleRanges.length; ri++) {
        const src = sampleRanges[ri]!.timestamps;
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const vs = sampleRanges[ri]!.values;
        for (let i = 0, len = src.length; i < len; i++) {
          const off = i << 3;
          const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
          values[bucket]! += vs[i]!;
          counts[bucket]!++;
        }
      }
      break;
    case 'count':
      for (let ri = 0; ri < sampleRanges.length; ri++) {
        const src = sampleRanges[ri]!.timestamps;
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        for (let i = 0, len = src.length; i < len; i++) {
          const off = i << 3;
          const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
          values[bucket]!++;
          counts[bucket]!++;
        }
      }
      break;
    case 'last':
      for (let ri = 0; ri < sampleRanges.length; ri++) {
        const src = sampleRanges[ri]!.timestamps;
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const vs = sampleRanges[ri]!.values;
        for (let i = 0, len = src.length; i < len; i++) {
          const off = i << 3;
          const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
          values[bucket] = vs[i]!;
          counts[bucket]!++;
        }
      }
      break;
    case 'rate': {
      const firstTs = new Float64Array(bucketCount).fill(Infinity);
      const firstVal = new Float64Array(bucketCount);
      const lastTs = new Float64Array(bucketCount).fill(-Infinity);
      const lastVal = new Float64Array(bucketCount);
      for (let ri = 0; ri < sampleRanges.length; ri++) {
        const src = sampleRanges[ri]!.timestamps;
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const vs = sampleRanges[ri]!.values;
        for (let i = 0, len = src.length; i < len; i++) {
          const off = i << 3;
          const t = dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le);
          const bucket = (t - minTN) / stepN | 0;
          counts[bucket]!++;
          if (t < firstTs[bucket]!) { firstTs[bucket] = t; firstVal[bucket] = vs[i]!; }
          if (t >= lastTs[bucket]!) { lastTs[bucket] = t; lastVal[bucket] = vs[i]!; }
        }
      }
      for (let i = 0; i < bucketCount; i++) {
        const dt = (lastTs[i]! - firstTs[i]!) / 1000;
        values[i] = dt > 0 ? (lastVal[i]! - firstVal[i]!) / dt : 0;
      }
      break;
    }
    default:
      for (let ri = 0; ri < sampleRanges.length; ri++) {
        const src = sampleRanges[ri]!.timestamps;
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const vs = sampleRanges[ri]!.values;
        for (let i = 0; i < src.length; i++) {
          const off = i << 3;
          const bucket = (dv.getInt32(off + 4, _le) * 4294967296 + dv.getUint32(off, _le) - minTN) / stepN | 0;
          values[bucket] = aggAccumulate(values[bucket]!, vs[i]!, fn);
          counts[bucket]!++;
        }
      }
  }

  aggFinalize(values, counts, fn);

  // Replace init-value sentinels with NaN in empty buckets so consumers
  // see "no data" instead of Infinity / -Infinity / 0.
  if (fn !== 'sum' && fn !== 'count') {
    for (let i = 0; i < bucketCount; i++) {
      if (counts[i]! === 0) values[i] = NaN;
    }
  }

  return { timestamps, values };
}
