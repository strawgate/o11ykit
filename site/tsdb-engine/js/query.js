// ── Query Engine (thin wrapper over o11ytsdb ScanEngine) ─────────────

import { ScanEngine as _ScanEngine, resolveStep } from "o11ytsdb";

export { resolveStep };

// Wraps the real ScanEngine to add demo-specific metadata fields
// (requestedStep, effectiveStep, pointBudget) that the demo's worker
// system and query builder UI expect on query results.
export class ScanEngine extends _ScanEngine {
  query(storage, opts) {
    const effectiveStep = resolveStep(opts.step, opts.start, opts.end, opts.maxPoints);
    const result = super.query(storage, opts);
    return {
      ...result,
      requestedStep: opts.step ?? null,
      effectiveStep,
      pointBudget: opts.maxPoints ?? null,
    };
  }

  queryAveragePartials(storage, opts) {
    const effectiveStep = resolveStep(opts.step, opts.start, opts.end, opts.maxPoints);
    const partials = super.queryAveragePartials(storage, opts);
    const meta = {
      requestedStep: opts.step ?? null,
      effectiveStep,
      pointBudget: opts.maxPoints ?? null,
    };
    return {
      sum: { ...partials.sum, ...meta },
      count: { ...partials.count, ...meta },
    };
  }
}
