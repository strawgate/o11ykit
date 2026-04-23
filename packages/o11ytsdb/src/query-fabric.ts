import type { QueryOpts, QueryResult, SeriesResult } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

/**
 * Internal coordinator utilities for composing one or more query executors
 * behind the stable `query(opts) -> result` library API.
 *
 * This module is intentionally not re-exported from `src/index.ts`.
 *
 * Minimal query-capable worker/executor contract.
 *
 * WorkerClient already satisfies this structurally, and local executors can
 * implement it directly without any worker transport.
 */
export interface QueryExecutor {
  query(opts: QueryOpts): MaybePromise<QueryResult>;
}

export interface QueryWorkAssignment {
  worker: QueryExecutor;
  request: QueryOpts;
  /**
   * Higher-priority assignments win when overlapping partitions emit the same
   * timestamp for the same output series. This is useful for "hot overrides
   * frozen" routing.
   */
  priority?: number;
}

export interface QueryWorkResult extends QueryWorkAssignment {
  result: QueryResult;
}

export interface QueryResultReducer {
  reduce(opts: QueryOpts, partials: readonly QueryWorkResult[]): QueryResult;
}

export interface QueryPlan {
  assignments: readonly QueryWorkAssignment[];
  reducer?: QueryResultReducer;
}

export interface QueryRouter {
  plan(opts: QueryOpts): QueryPlan;
}

/**
 * Coordinator-facing execution entrypoint.
 *
 * The caller does not need to know whether the underlying topology is:
 * - one local store
 * - one worker
 * - hot owner + frozen query pool
 * - another future routing strategy
 */
export class QueryFabric {
  constructor(
    private readonly router: QueryRouter,
    private readonly defaultReducer: QueryResultReducer = new PassThroughReducer()
  ) {}

  async execute(opts: QueryOpts): Promise<QueryResult> {
    const plan = this.router.plan(opts);
    const reducer = plan.reducer ?? this.defaultReducer;
    const partials = await Promise.all(
      plan.assignments.map(
        async (assignment): Promise<QueryWorkResult> => ({
          ...assignment,
          result: await assignment.worker.query(assignment.request),
        })
      )
    );
    return reducer.reduce(opts, partials);
  }
}

export class PassThroughReducer implements QueryResultReducer {
  reduce(_opts: QueryOpts, partials: readonly QueryWorkResult[]): QueryResult {
    if (partials.length !== 1) {
      throw new Error(`PassThroughReducer expects exactly 1 partial, got ${partials.length}`);
    }
    const partial = partials[0];
    if (!partial) {
      throw new Error("PassThroughReducer expected a partial result");
    }
    return partial.result;
  }
}

export class SingleExecutorRouter implements QueryRouter {
  constructor(private readonly worker: QueryExecutor) {}

  plan(opts: QueryOpts): QueryPlan {
    return {
      assignments: [{ worker: this.worker, request: opts }],
    };
  }
}

export interface TimePartition {
  worker: QueryExecutor;
  start: bigint;
  end: bigint;
  /**
   * Optional extra lookbehind/lookahead. Useful when a partition executor can
   * read a small seam overlap for transforms while still conceptually owning a
   * narrower output range.
   */
  padStart?: bigint;
  padEnd?: bigint;
  /**
   * Higher priority wins on overlap for equal timestamps.
   */
  priority?: number;
}

/**
 * Routes a query to all overlapping time partitions.
 *
 * This is a good fit for "frozen history + hot tail" topologies where each
 * executor owns a time slice and the coordinator should not need to branch on
 * worker roles.
 */
export class TimePartitionRouter implements QueryRouter {
  private readonly partitions: readonly TimePartition[];
  private readonly reducer: QueryResultReducer;

  constructor(
    partitions: readonly TimePartition[],
    reducer: QueryResultReducer = new TimePartitionedReducer()
  ) {
    this.partitions = [...partitions].sort((a, b) => compareBigInt(a.start, b.start));
    this.reducer = reducer;
  }

  plan(opts: QueryOpts): QueryPlan {
    const assignments: QueryWorkAssignment[] = [];

    for (const partition of this.partitions) {
      if (partition.end < opts.start || partition.start > opts.end) {
        continue;
      }
      const padStart = partition.padStart ?? 0n;
      const padEnd = partition.padEnd ?? 0n;
      const requestStart = maxBigInt(opts.start, partition.start - padStart);
      const requestEnd = minBigInt(opts.end, partition.end + padEnd);
      if (requestStart > requestEnd) {
        continue;
      }
      assignments.push({
        worker: partition.worker,
        request: { ...opts, start: requestStart, end: requestEnd },
        ...(partition.priority !== undefined && { priority: partition.priority }),
      });
    }

    return { assignments, reducer: this.reducer };
  }
}

/**
 * Merges results from time-partitioned executors.
 *
 * This reducer assumes each partial represents the same logical query over a
 * different time slice of the dataset. It sums scanned samples across slices
 * and uses the maximum scanned series count to avoid double-counting the same
 * series across hot/frozen partitions.
 */
export class TimePartitionedReducer implements QueryResultReducer {
  reduce(opts: QueryOpts, partials: readonly QueryWorkResult[]): QueryResult {
    if (partials.length === 0) {
      return { series: [], scannedSeries: 0, scannedSamples: 0 };
    }

    const grouped = new Map<string, MergedSeriesState>();
    let scannedSeries = 0;
    let scannedSamples = 0;

    const ordered = [...partials].sort(compareWorkResult);

    for (const partial of ordered) {
      scannedSeries = Math.max(scannedSeries, partial.result.scannedSeries);
      scannedSamples += partial.result.scannedSamples;

      for (const series of partial.result.series) {
        const key = seriesKey(series);
        const existing = grouped.get(key);
        if (existing) {
          existing.segments.push({ series, priority: partial.priority ?? 0 });
          continue;
        }
        grouped.set(key, {
          labels: series.labels,
          segments: [{ series, priority: partial.priority ?? 0 }],
        });
      }
    }

    const series = [...grouped.values()].map((entry) => mergeSeriesSegments(entry.segments, opts));
    return { series, scannedSeries, scannedSamples };
  }
}

interface MergedSeriesState {
  labels: SeriesResult["labels"];
  segments: Array<{ series: SeriesResult; priority: number }>;
}

function mergeSeriesSegments(
  segments: ReadonlyArray<{ series: SeriesResult; priority: number }>,
  opts: QueryOpts
): SeriesResult {
  const ordered = [...segments].sort((a, b) => compareSeriesSegment(a, b));
  const timestamps: bigint[] = [];
  const values: number[] = [];
  const pointPriorities: number[] = [];

  for (const segment of ordered) {
    const pointCount = segment.series.timestamps.length;
    if (segment.series.values.length !== pointCount) {
      throw new RangeError(
        `mismatched point arrays while merging series: values=${segment.series.values.length}, timestamps=${pointCount}`
      );
    }

    for (let i = 0; i < pointCount; i++) {
      const timestamp = segment.series.timestamps[i];
      const value = segment.series.values[i];
      if (timestamp === undefined || value === undefined) {
        throw new RangeError(`missing merged point at index ${i}`);
      }
      if (timestamp < opts.start || timestamp > opts.end) {
        continue;
      }

      const lastIndex = timestamps.length - 1;
      if (lastIndex < 0) {
        timestamps.push(timestamp);
        values.push(value);
        pointPriorities.push(segment.priority);
        continue;
      }

      const lastTimestamp = timestamps[lastIndex];
      if (lastTimestamp === undefined) {
        throw new RangeError(`missing merged timestamp at index ${lastIndex}`);
      }
      if (timestamp > lastTimestamp) {
        timestamps.push(timestamp);
        values.push(value);
        pointPriorities.push(segment.priority);
        continue;
      }

      const existingIndex = lowerBoundBigInt(timestamps, timestamp);
      if (existingIndex < timestamps.length && timestamps[existingIndex] === timestamp) {
        const existingPriority = pointPriorities[existingIndex];
        if (existingPriority === undefined) {
          throw new RangeError(`missing merged point priority at index ${existingIndex}`);
        }
        if (segment.priority >= existingPriority) {
          values[existingIndex] = value;
          pointPriorities[existingIndex] = segment.priority;
        }
        continue;
      }

      timestamps.splice(existingIndex, 0, timestamp);
      values.splice(existingIndex, 0, value);
      pointPriorities.splice(existingIndex, 0, segment.priority);
    }
  }

  const first = ordered[0];
  if (!first) {
    throw new RangeError("cannot merge empty series segments");
  }

  return {
    labels: first.series.labels,
    timestamps: BigInt64Array.from(timestamps),
    values: Float64Array.from(values),
  };
}

function compareWorkResult(a: QueryWorkResult, b: QueryWorkResult): number {
  const byStart = compareBigInt(a.request.start, b.request.start);
  if (byStart !== 0) return byStart;
  return (a.priority ?? 0) - (b.priority ?? 0);
}

function compareSeriesSegment(
  a: { series: SeriesResult; priority: number },
  b: { series: SeriesResult; priority: number }
): number {
  const aStart = a.series.timestamps[0];
  const bStart = b.series.timestamps[0];
  if (aStart === undefined && bStart === undefined) {
    return a.priority - b.priority;
  }
  if (aStart === undefined) return 1;
  if (bStart === undefined) return -1;
  const byStart = compareBigInt(aStart, bStart);
  if (byStart !== 0) return byStart;
  return a.priority - b.priority;
}

function seriesKey(series: SeriesResult): string {
  const entries = [...series.labels.entries()].sort((a, b) =>
    a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])
  );
  return entries.map(([k, v]) => `${k}=${v}`).join("\0");
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function lowerBoundBigInt(values: readonly bigint[], target: bigint): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    const value = values[mid];
    if (value === undefined) {
      throw new RangeError(`missing sorted timestamp at index ${mid}`);
    }
    if (value < target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}
