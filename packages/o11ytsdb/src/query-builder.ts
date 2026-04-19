/**
 * Fluent query builder — compiles to a PlanNode tree.
 *
 * Usage:
 *   import { query } from './query-builder.js';
 *
 *   const plan = query()
 *     .metric('http_request_duration_seconds')
 *     .where('method', '=', 'GET')
 *     .where('status', '=~', '2..')
 *     .range(start, end)
 *     .rate()
 *     .step(60_000n)
 *     .sumBy('endpoint')
 *     .plan();
 *
 * Each method returns a new (immutable) builder. Call .plan() to compile
 * the description into a PlanNode tree, or .exec(storage) to compile and
 * execute in one step.
 */

import type { MatchOp, PlanAggFn, PlanMatcher, PlanNode, TransformFn } from "./plan.js";
import { executePlan } from "./plan-executor.js";
import type { QueryResult, StorageBackend } from "./types.js";

// ── Internal state ───────────────────────────────────────────────────

interface BuilderState {
  readonly metric: string | undefined;
  readonly matchers: readonly PlanMatcher[];
  readonly start: bigint | undefined;
  readonly end: bigint | undefined;
  readonly transforms: readonly TransformFn[];
  readonly step: bigint | undefined;
  readonly agg: PlanAggFn | undefined;
  readonly groupBy: readonly string[] | undefined;
}

const EMPTY_STATE: BuilderState = {
  metric: undefined,
  matchers: [],
  start: undefined,
  end: undefined,
  transforms: [],
  step: undefined,
  agg: undefined,
  groupBy: undefined,
};

// ── Builder ──────────────────────────────────────────────────────────

export class QueryBuilder {
  private readonly s: BuilderState;

  private constructor(state: BuilderState) {
    this.s = state;
  }

  /** Start a new query. */
  static create(): QueryBuilder {
    return new QueryBuilder(EMPTY_STATE);
  }

  // ── Selection ────────────────────────────────────────────────────

  /** Set the metric name (__name__ label). */
  metric(name: string): QueryBuilder {
    return new QueryBuilder({ ...this.s, metric: name });
  }

  /** Add a label matcher. */
  where(label: string, op: MatchOp, value: string): QueryBuilder {
    return new QueryBuilder({
      ...this.s,
      matchers: [...this.s.matchers, { label, op, value }],
    });
  }

  // ── Time range ───────────────────────────────────────────────────

  /** Set the query time range [start, end] (epoch ms as bigint). */
  range(start: bigint, end: bigint): QueryBuilder {
    return new QueryBuilder({ ...this.s, start, end });
  }

  // ── Transforms (per-series, before aggregation) ──────────────────

  /** Apply rate() — per-second derivative of a counter. */
  rate(): QueryBuilder {
    return new QueryBuilder({
      ...this.s,
      transforms: [...this.s.transforms, "rate"],
    });
  }

  /** Apply increase() — total increase over the range. */
  increase(): QueryBuilder {
    return new QueryBuilder({
      ...this.s,
      transforms: [...this.s.transforms, "increase"],
    });
  }

  /** Apply irate() — instant rate from last two samples. */
  irate(): QueryBuilder {
    return new QueryBuilder({
      ...this.s,
      transforms: [...this.s.transforms, "irate"],
    });
  }

  /** Apply abs() — absolute value of each sample. */
  abs(): QueryBuilder {
    return new QueryBuilder({
      ...this.s,
      transforms: [...this.s.transforms, "abs"],
    });
  }

  // ── Step alignment ───────────────────────────────────────────────

  /** Set step-alignment interval (epoch ms as bigint). */
  step(interval: bigint): QueryBuilder {
    return new QueryBuilder({ ...this.s, step: interval });
  }

  // ── Aggregations ─────────────────────────────────────────────────

  private aggregate(fn: PlanAggFn, groupBy?: readonly string[]): QueryBuilder {
    return new QueryBuilder({ ...this.s, agg: fn, groupBy });
  }

  /** Aggregate: sum. */
  sum(): QueryBuilder {
    return this.aggregate("sum");
  }
  /** Aggregate: avg. */
  avg(): QueryBuilder {
    return this.aggregate("avg");
  }
  /** Aggregate: min. */
  min(): QueryBuilder {
    return this.aggregate("min");
  }
  /** Aggregate: max. */
  max(): QueryBuilder {
    return this.aggregate("max");
  }
  /** Aggregate: count. */
  count(): QueryBuilder {
    return this.aggregate("count");
  }
  /** Aggregate: last. */
  last(): QueryBuilder {
    return this.aggregate("last");
  }

  /** Aggregate sum, grouped by label(s). */
  sumBy(...labels: string[]): QueryBuilder {
    return this.aggregate("sum", labels);
  }
  /** Aggregate avg, grouped by label(s). */
  avgBy(...labels: string[]): QueryBuilder {
    return this.aggregate("avg", labels);
  }
  /** Aggregate min, grouped by label(s). */
  minBy(...labels: string[]): QueryBuilder {
    return this.aggregate("min", labels);
  }
  /** Aggregate max, grouped by label(s). */
  maxBy(...labels: string[]): QueryBuilder {
    return this.aggregate("max", labels);
  }
  /** Aggregate count, grouped by label(s). */
  countBy(...labels: string[]): QueryBuilder {
    return this.aggregate("count", labels);
  }
  /** Aggregate last, grouped by label(s). */
  lastBy(...labels: string[]): QueryBuilder {
    return this.aggregate("last", labels);
  }

  /** Aggregate: p50 (median). */
  p50(): QueryBuilder {
    return this.aggregate("p50");
  }
  /** Aggregate: p90. */
  p90(): QueryBuilder {
    return this.aggregate("p90");
  }
  /** Aggregate: p95. */
  p95(): QueryBuilder {
    return this.aggregate("p95");
  }
  /** Aggregate: p99. */
  p99(): QueryBuilder {
    return this.aggregate("p99");
  }
  /** Aggregate p50 (median), grouped by label(s). */
  p50By(...labels: string[]): QueryBuilder {
    return this.aggregate("p50", labels);
  }
  /** Aggregate p90, grouped by label(s). */
  p90By(...labels: string[]): QueryBuilder {
    return this.aggregate("p90", labels);
  }
  /** Aggregate p95, grouped by label(s). */
  p95By(...labels: string[]): QueryBuilder {
    return this.aggregate("p95", labels);
  }
  /** Aggregate p99, grouped by label(s). */
  p99By(...labels: string[]): QueryBuilder {
    return this.aggregate("p99", labels);
  }

  // ── Compile ──────────────────────────────────────────────────────

  /**
   * Compile the builder state into a PlanNode tree.
   *
   * Tree is built bottom-up:
   *   Select → TimeRange → Transform* → Aggregate?
   *
   * @throws if metric or range is not set.
   */
  plan(): PlanNode {
    const { metric, matchers, start, end, transforms, step, agg, groupBy } = this.s;

    if (metric == null) throw new Error("query().metric() is required");
    if (start == null || end == null) throw new Error("query().range() is required");

    let node: PlanNode = { kind: "select", metric, matchers };
    node = { kind: "timeRange", input: node, start, end };

    for (const fn of transforms) {
      node = { kind: "transform", input: node, fn };
    }

    if (agg != null) {
      node = {
        kind: "aggregate",
        input: node,
        fn: agg,
        ...(step != null && { step }),
        ...(groupBy != null && { groupBy }),
      };
    }

    return node;
  }

  /**
   * Compile and execute the query against a storage backend.
   *
   * Shorthand for `executePlan(builder.plan(), storage)`.
   */
  exec(storage: StorageBackend): QueryResult {
    return executePlan(this.plan(), storage);
  }
}

/** Start building a new query. */
export function query(): QueryBuilder {
  return QueryBuilder.create();
}
