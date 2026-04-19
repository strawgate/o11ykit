/**
 * Plan executor — walks a PlanNode tree and produces a QueryResult.
 *
 * V1 strategy: extract parameters from the plan, map to the existing
 * ScanEngine.query() interface. Advanced features (compound transforms,
 * regex matchers, binary ops) will be handled natively as the executor
 * matures.
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
import type { AggFn, Matcher, QueryOpts, QueryResult, StorageBackend } from "./types.js";

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
 * Convert PlanMatchers to the current Matcher type (equality only).
 * Throws for operators not yet supported by the engine.
 */
function toEngineMatchers(planMatchers: readonly PlanMatcher[]): Matcher[] {
  const out: Matcher[] = [];
  for (const m of planMatchers) {
    if (m.op !== "=") {
      throw new Error(
        `Matcher operator '${m.op}' is not yet supported (label=${m.label}, value=${m.value}). ` +
          `Only '=' is supported in the current executor.`
      );
    }
    out.push({ label: m.label, value: m.value });
  }
  return out;
}

// ── Aggregation mapping ──────────────────────────────────────────────

/**
 * Map plan transforms + aggregation to a single AggFn for the current
 * ScanEngine. The current engine treats 'rate' as an AggFn, so we can
 * handle the common case of rate() alone. Compound transform+agg
 * (e.g., rate().sumBy()) is not yet supported.
 */
function resolveAggFn(transforms: TransformFn[], agg: PlanAggFn | undefined): AggFn | undefined {
  if (transforms.length === 0) {
    return agg; // 'sum' | 'avg' | ... | undefined — all valid AggFn values
  }

  if (transforms.length === 1 && transforms[0] === "rate" && agg == null) {
    // rate() without a subsequent aggregation → maps to agg:'rate'
    return "rate";
  }

  if (transforms.length === 1 && transforms[0] === "rate" && agg != null) {
    throw new Error(
      `Compound rate() + ${agg}() is not yet supported. ` +
        `The executor will support per-series rate → aggregation in a future version.`
    );
  }

  throw new Error(
    `Transform '${transforms.join(" → ")}' is not yet supported by the executor. ` +
      `Supported: rate() (without subsequent aggregation).`
  );
}

// ── Public API ───────────────────────────────────────────────────────

const engine = new ScanEngine();

/**
 * Execute a query plan against a storage backend.
 *
 * V1: flattens the plan tree and delegates to ScanEngine.query().
 * Supports: = matchers, all 6 aggregations ± step ± groupBy, rate().
 * Not yet supported: !=, =~, !~ matchers; compound transforms;
 * binary ops; increase, irate, abs, etc.
 */
export function executePlan(plan: PlanNode, storage: StorageBackend): QueryResult {
  const flat = flattenPlan(plan);
  const matchers = toEngineMatchers(flat.matchers);
  const agg = resolveAggFn(flat.transforms, flat.agg);

  const opts: QueryOpts = {
    metric: flat.metric,
    start: flat.start,
    end: flat.end,
  };
  if (matchers.length > 0) opts.matchers = matchers;
  if (agg != null) opts.agg = agg;
  if (flat.step != null) opts.step = flat.step;
  if (flat.groupBy != null && flat.groupBy.length > 0) opts.groupBy = [...flat.groupBy];

  return engine.query(storage, opts);
}
