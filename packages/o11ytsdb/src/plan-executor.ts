/**
 * Plan executor — walks a PlanNode tree and produces a QueryResult.
 *
 * V1 strategy: extract parameters from the plan, map to the existing
 * ScanEngine.query() interface. Advanced features (compound transforms,
 * binary ops) will be handled natively as the executor matures.
 */

import type {
  AggregateNode,
  PlanAggFn,
  PlanMatcher,
  PlanNode,
  SelectNode,
  TimeRangeNode,
  TransformFn,
  TransformNode,
} from "./plan.js";
import { ScanEngine } from "./query.js";
import type {
  AggFn,
  Matcher,
  QueryOpts,
  QueryResult,
  StorageBackend,
  TransformOp,
} from "./types.js";

// ── Extracted plan parameters ────────────────────────────────────────

interface FlatPlan {
  metric: string;
  matchers: readonly PlanMatcher[];
  start: bigint;
  end: bigint;
  transforms: TransformFn[];
  agg: PlanAggFn | undefined;
  step: bigint | undefined;
  groupBy: readonly string[] | undefined;
}

// ── Plan flattening ──────────────────────────────────────────────────

/**
 * Walk the plan tree (outer → inner) and extract a flat parameter set.
 * Validates structural constraints (exactly one select, one timeRange).
 */
function flattenPlan(root: PlanNode): FlatPlan {
  let select: SelectNode | undefined;
  let timeRange: TimeRangeNode | undefined;
  const transforms: TransformFn[] = [];
  let agg: PlanAggFn | undefined;
  let step: bigint | undefined;
  let groupBy: readonly string[] | undefined;

  let current: PlanNode = root;
  for (;;) {
    switch (current.kind) {
      case "aggregate": {
        const a: AggregateNode = current;
        agg = a.fn;
        step = a.step;
        groupBy = a.groupBy;
        current = a.input;
        break;
      }
      case "transform": {
        const t: TransformNode = current;
        transforms.unshift(t.fn); // inner-first order
        current = t.input;
        break;
      }
      case "timeRange": {
        const tr: TimeRangeNode = current;
        timeRange = tr;
        current = tr.input;
        break;
      }
      case "select": {
        select = current;
        break;
      }
    }
    if (current.kind === "select") {
      select = current;
      break;
    }
  }

  if (!select) throw new Error("Plan has no SelectNode");
  if (!timeRange) throw new Error("Plan has no TimeRangeNode");

  return {
    metric: select.metric,
    matchers: select.matchers,
    start: timeRange.start,
    end: timeRange.end,
    transforms,
    agg,
    step,
    groupBy,
  };
}

// ── Matcher mapping ──────────────────────────────────────────────────

/**
 * Convert PlanMatchers to the current Matcher type.
 * All four operators (=, !=, =~, !~) are now supported.
 */
function toEngineMatchers(planMatchers: readonly PlanMatcher[]): Matcher[] {
  return planMatchers.map((m) => ({ label: m.label, op: m.op, value: m.value }));
}

// ── Aggregation mapping ──────────────────────────────────────────────

/**
 * Map plan transforms + aggregation to QueryOpts fields.
 * Returns the aggregation function and optional per-series transform.
 */
function resolveAggFn(
  transforms: TransformFn[],
  agg: PlanAggFn | undefined
): { agg: AggFn | undefined; transform: TransformOp | undefined } {
  if (transforms.length === 0) {
    return { agg, transform: undefined };
  }

  if (
    transforms.length === 1 &&
    (transforms[0] === "rate" ||
      transforms[0] === "increase" ||
      transforms[0] === "irate" ||
      transforms[0] === "delta")
  ) {
    const transform = transforms[0] as TransformOp;
    if (agg == null || (agg as string) === transform) {
      // Standalone transform (agg may be synthesized by query builder for step propagation).
      return { agg: undefined, transform };
    }
    // Compound: transform per-series, then cross-series aggregation
    return { agg, transform };
  }

  throw new Error(
    `Transform '${transforms.join(" → ")}' is not yet supported by the executor. ` +
      `Supported: rate(), increase(), irate(), delta() (with optional subsequent aggregation).`
  );
}

// ── Public API ───────────────────────────────────────────────────────

const engine = new ScanEngine();

/**
 * Execute a query plan against a storage backend.
 *
 * V1: flattens the plan tree and delegates to ScanEngine.query().
 * Supports: =, !=, =~, !~ matchers, all aggregations ± step ± groupBy,
 * rate(), increase(), irate(), delta(), and compound transforms.
 * Not yet supported: binary ops; abs.
 */
export function executePlan(plan: PlanNode, storage: StorageBackend): QueryResult {
  const flat = flattenPlan(plan);
  const matchers = toEngineMatchers(flat.matchers);
  const resolved = resolveAggFn(flat.transforms, flat.agg);

  const opts: QueryOpts = {
    metric: flat.metric,
    start: flat.start,
    end: flat.end,
  };
  if (matchers.length > 0) opts.matchers = matchers;
  if (resolved.agg != null) opts.agg = resolved.agg;
  if (resolved.transform != null) opts.transform = resolved.transform;
  if (flat.step != null) opts.step = flat.step;
  if (flat.groupBy != null && flat.groupBy.length > 0) opts.groupBy = [...flat.groupBy];

  return engine.query(storage, opts);
}
