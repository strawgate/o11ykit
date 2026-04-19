/**
 * QueryPlan IR — typed node tree that the builder compiles to and the
 * executor walks.
 *
 * The tree is a linear pipeline for V1:
 *   Aggregate? → Transform* → TimeRange → Select
 *
 * Binary operators (series + series) are deferred to a later milestone.
 */

// ── Matcher types ────────────────────────────────────────────────────

/** Matcher operators for label filtering. */
export type MatchOp = "=" | "!=" | "=~" | "!~";

/** A label matcher with operator. */
export interface PlanMatcher {
  readonly label: string;
  readonly op: MatchOp;
  readonly value: string;
}

// ── Function types ───────────────────────────────────────────────────

/** Per-series transform functions (applied before aggregation). */
export type TransformFn = "rate" | "increase" | "irate" | "abs" | "ceil" | "floor" | "sqrt";

/** Pure aggregation functions (collapse series, not per-series transforms). */
export type PlanAggFn = "sum" | "avg" | "min" | "max" | "count" | "last";

// ── Plan nodes ───────────────────────────────────────────────────────

/** Leaf node: select series by metric name + label matchers. */
export interface SelectNode {
  readonly kind: "select";
  readonly metric: string;
  readonly matchers: readonly PlanMatcher[];
}

/** Filter to a time window [start, end]. */
export interface TimeRangeNode {
  readonly kind: "timeRange";
  readonly input: PlanNode;
  readonly start: bigint;
  readonly end: bigint;
}

/** Apply a per-series transform (e.g., rate, increase). */
export interface TransformNode {
  readonly kind: "transform";
  readonly input: PlanNode;
  readonly fn: TransformFn;
}

/** Aggregate across series, optionally step-aligned with groupBy. */
export interface AggregateNode {
  readonly kind: "aggregate";
  readonly input: PlanNode;
  readonly fn: PlanAggFn;
  readonly step?: bigint;
  readonly groupBy?: readonly string[];
}

/** A node in the query plan tree. */
export type PlanNode = SelectNode | TimeRangeNode | TransformNode | AggregateNode;
