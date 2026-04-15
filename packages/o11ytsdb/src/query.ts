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
      const data = storage.read(id, opts.start, opts.end);
      scannedSamples += data.timestamps.length;
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
      group.ranges.push(data);
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

  // Initialize based on agg function.
  const init = fn === 'min' ? Infinity : fn === 'max' ? -Infinity : 0;
  values.fill(init);
  const counts = new Float64Array(timestamps.length);

  for (const r of ranges) {
    // Simple: assume aligned timestamps. Real engine would merge-sort.
    const len = Math.min(r.values.length, timestamps.length);
    for (let i = 0; i < len; i++) {
      const v = r.values[i]!;
      switch (fn) {
        case 'sum': case 'avg': values[i]! += v; break;
        case 'min': if (v < values[i]!) values[i]! = v; break;
        case 'max': if (v > values[i]!) values[i]! = v; break;
        case 'count': values[i]!++; break;
        case 'last': values[i]! = v; break;
      }
      counts[i]!++;
    }
  }

  if (fn === 'avg') {
    for (let i = 0; i < values.length; i++) {
      if (counts[i]! > 0) values[i]! /= counts[i]!;
    }
  }

  return { timestamps, values };
}

function stepAggregate(ranges: TimeRange[], fn: AggFn, step: bigint): TimeRange {
  // Find time bounds.
  let minT = BigInt('9223372036854775807');
  let maxT = -minT;
  for (const r of ranges) {
    if (r.timestamps.length === 0) continue;
    if (r.timestamps[0]! < minT) minT = r.timestamps[0]!;
    if (r.timestamps[r.timestamps.length - 1]! > maxT)
      maxT = r.timestamps[r.timestamps.length - 1]!;
  }

  const bucketCount = Number((maxT - minT) / step) + 1;
  const timestamps = new BigInt64Array(bucketCount);
  const values = new Float64Array(bucketCount);
  const counts = new Float64Array(bucketCount);

  for (let i = 0; i < bucketCount; i++) {
    timestamps[i] = minT + BigInt(i) * step;
  }

  const init = fn === 'min' ? Infinity : fn === 'max' ? -Infinity : 0;
  values.fill(init);

  for (const r of ranges) {
    for (let i = 0; i < r.timestamps.length; i++) {
      const bucket = Number((r.timestamps[i]! - minT) / step);
      if (bucket < 0 || bucket >= bucketCount) continue;
      const v = r.values[i]!;
      switch (fn) {
        case 'sum': case 'avg': values[bucket]! += v; break;
        case 'min': if (v < values[bucket]!) values[bucket]! = v; break;
        case 'max': if (v > values[bucket]!) values[bucket]! = v; break;
        case 'count': values[bucket]!++; break;
        case 'last': values[bucket]! = v; break;
      }
      counts[bucket]!++;
    }
  }

  if (fn === 'avg') {
    for (let i = 0; i < values.length; i++) {
      if (counts[i]! > 0) values[i]! /= counts[i]!;
    }
  }

  return { timestamps, values };
}
