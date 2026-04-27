// @ts-nocheck
// ── Query Model — Build query opts, TraceQL preview, filtering ──────
import { escapeHtml, spanAttr, spanServiceName } from "./utils.js";

/**
 * @typedef {Object} QueryOpts
 * @property {string} [service]
 * @property {string} [spanName]
 * @property {number} [statusCode]
 * @property {number} [minDurationMs]
 * @property {number} [maxDurationMs]
 * @property {number} [spanKind]
 * @property {Array<{key: string, op: string, value: string}>} [attrFilters]
 * @property {Object} [structural]
 * @property {Object} [traceIntrinsics]
 * @property {string} [sortBy]
 * @property {string} [sortDir]
 * @property {number} [limit]
 */

/**
 * Execute a query against span data (no backend — runs client-side).
 */
export function executeQuery(spans, opts = {}) {
  const t0 = performance.now();
  let filtered = spans;

  if (opts.service) {
    filtered = filtered.filter((s) => spanServiceName(s) === opts.service);
  }

  if (opts.spanName) {
    try {
      const re = new RegExp(opts.spanName, "i");
      filtered = filtered.filter((s) => re.test(s.name));
    } catch {
      filtered = filtered.filter((s) => s.name.toLowerCase().includes(opts.spanName.toLowerCase()));
    }
  }

  if (opts.statusCode !== undefined && opts.statusCode !== null && opts.statusCode !== -1) {
    filtered = filtered.filter((s) => s.statusCode === opts.statusCode);
  }

  if (opts.spanKind !== undefined && opts.spanKind !== null && opts.spanKind !== -1) {
    filtered = filtered.filter((s) => s.kind === opts.spanKind);
  }

  if (opts.minDurationMs > 0) {
    const minNs = BigInt(Math.round(opts.minDurationMs * 1_000_000));
    filtered = filtered.filter((s) => {
      const dur = s.durationNanos || s.endTimeUnixNano - s.startTimeUnixNano;
      return dur >= minNs;
    });
  }

  if (opts.maxDurationMs > 0) {
    const maxNs = BigInt(Math.round(opts.maxDurationMs * 1_000_000));
    filtered = filtered.filter((s) => {
      const dur = s.durationNanos || s.endTimeUnixNano - s.startTimeUnixNano;
      return dur <= maxNs;
    });
  }

  if (opts.attrFilters && opts.attrFilters.length > 0) {
    for (const f of opts.attrFilters) {
      if (!f.key || !f.value) continue;
      filtered = filtered.filter((s) => {
        const val = spanAttr(s, f.key);
        if (val === undefined) return f.op === "!=";
        const strVal = String(val);
        switch (f.op) {
          case "=":
            return strVal === f.value;
          case "!=":
            return strVal !== f.value;
          case "~":
            return strVal.includes(f.value);
          case ">":
            return Number(val) > Number(f.value);
          case "<":
            return Number(val) < Number(f.value);
          default:
            return strVal === f.value;
        }
      });
    }
  }

  if (opts.structural) {
    filtered = applyStructuralPredicates(filtered, spans, opts.structural);
  }

  if (opts.traceIntrinsics) {
    filtered = applyTraceIntrinsics(filtered, spans, opts.traceIntrinsics);
  }

  const traceMap = new Map();
  for (const span of filtered) {
    const tid = typeof span.traceId === "string" ? span.traceId : String(span.traceId);
    if (!traceMap.has(tid)) traceMap.set(tid, []);
    traceMap.get(tid).push(span);
  }

  let traces = [...traceMap.entries()].map(([traceId, traceSpans]) => {
    const rootSpan = traceSpans.find((s) => !s.parentSpanId) || traceSpans[0];
    const allTraceSpans = spans.filter((s) => {
      const tid = typeof s.traceId === "string" ? s.traceId : String(s.traceId);
      return tid === traceId;
    });
    const hasError = allTraceSpans.some((s) => s.statusCode === 2);
    const duration = rootSpan ? Number(rootSpan.endTimeUnixNano - rootSpan.startTimeUnixNano) : 0;

    return {
      traceId,
      rootService: spanServiceName(rootSpan),
      rootSpan: rootSpan.name,
      spanCount: allTraceSpans.length,
      matchedSpans: traceSpans.length,
      duration,
      hasError,
      statusCode: hasError ? 2 : 1,
      spans: allTraceSpans,
    };
  });

  const sortBy = opts.sortBy || "duration";
  const sortDir = opts.sortDir === "asc" ? 1 : -1;
  traces.sort((a, b) => {
    switch (sortBy) {
      case "duration":
        return (a.duration - b.duration) * sortDir;
      case "spanCount":
        return (a.spanCount - b.spanCount) * sortDir;
      case "errors":
        return ((a.hasError ? 1 : 0) - (b.hasError ? 1 : 0)) * sortDir;
      default:
        return (a.duration - b.duration) * sortDir;
    }
  });

  const limit = opts.limit || 100;
  traces = traces.slice(0, limit);

  const elapsed = performance.now() - t0;
  return {
    traces,
    matchedSpans: filtered.length,
    totalSpans: spans.length,
    traceCount: traces.length,
    elapsed,
  };
}

function applyStructuralPredicates(filtered, allSpans, structural) {
  if (!structural.type || structural.type === "none") return filtered;

  const parentMap = new Map();
  for (const s of allSpans) {
    const pid = s.parentSpanId;
    if (pid) {
      if (!parentMap.has(pid)) parentMap.set(pid, []);
      parentMap.get(pid).push(s);
    }
  }

  const spanById = new Map();
  for (const s of allSpans) {
    spanById.set(s.spanId, s);
  }

  return filtered.filter((span) => {
    switch (structural.type) {
      case "hasDescendant": {
        return hasDescendant(span, parentMap, structural);
      }
      case "hasAncestor": {
        return hasAncestor(span, spanById, structural);
      }
      case "hasSibling": {
        return hasSibling(span, parentMap, structural);
      }
      default:
        return true;
    }
  });
}

function hasDescendant(span, parentMap, pred) {
  const children = parentMap.get(span.spanId) || [];
  for (const child of children) {
    if (matchesPredicate(child, pred)) return true;
    if (hasDescendant(child, parentMap, pred)) return true;
  }
  return false;
}

function hasAncestor(span, spanById, pred) {
  let current = span;
  const visited = new Set();
  while (current.parentSpanId && !visited.has(current.parentSpanId)) {
    visited.add(current.parentSpanId);
    const parent = spanById.get(current.parentSpanId);
    if (!parent) break;
    if (matchesPredicate(parent, pred)) return true;
    current = parent;
  }
  return false;
}

function hasSibling(span, parentMap, pred) {
  if (!span.parentSpanId) return false;
  const siblings = parentMap.get(span.parentSpanId) || [];
  return siblings.some((s) => s.spanId !== span.spanId && matchesPredicate(s, pred));
}

function matchesPredicate(span, pred) {
  if (pred.service && spanServiceName(span) !== pred.service) return false;
  if (pred.spanName && !span.name.includes(pred.spanName)) return false;
  if (pred.status !== undefined && pred.status !== -1 && span.statusCode !== pred.status)
    return false;
  return true;
}

function applyTraceIntrinsics(filtered, allSpans, intrinsics) {
  const traceRoots = new Map();
  for (const s of allSpans) {
    if (!s.parentSpanId) {
      const tid = typeof s.traceId === "string" ? s.traceId : String(s.traceId);
      traceRoots.set(tid, s);
    }
  }

  return filtered.filter((span) => {
    const tid = typeof span.traceId === "string" ? span.traceId : String(span.traceId);
    const root = traceRoots.get(tid);
    if (!root) return true;

    if (intrinsics.rootService && spanServiceName(root) !== intrinsics.rootService) return false;
    if (intrinsics.rootSpanName && !root.name.includes(intrinsics.rootSpanName)) return false;
    if (intrinsics.minTraceDurationMs > 0) {
      const dur = Number(root.endTimeUnixNano - root.startTimeUnixNano);
      if (dur < intrinsics.minTraceDurationMs * 1_000_000) return false;
    }
    return true;
  });
}

/**
 * Build a TraceQL-like preview string from query opts.
 */
export function buildQueryPreview(opts, _serviceNames = []) {
  const lines = [];
  lines.push('<span class="op">{</span>');

  const predicates = [];

  if (opts.service) {
    predicates.push(
      `  <span class="kw">resource.service.name</span> <span class="op">=</span> <span class="str">"${escapeHtml(opts.service)}"</span>`
    );
  }
  if (opts.spanName) {
    predicates.push(
      `  <span class="kw">name</span> <span class="op">=~</span> <span class="str">"${escapeHtml(opts.spanName)}"</span>`
    );
  }
  if (opts.statusCode !== undefined && opts.statusCode !== null && opts.statusCode !== -1) {
    const name = opts.statusCode === 2 ? "error" : opts.statusCode === 1 ? "ok" : "unset";
    predicates.push(
      `  <span class="kw">status</span> <span class="op">=</span> <span class="str">${name}</span>`
    );
  }
  if (opts.spanKind !== undefined && opts.spanKind !== null && opts.spanKind !== -1) {
    const kinds = ["unspecified", "internal", "server", "client"];
    predicates.push(
      `  <span class="kw">kind</span> <span class="op">=</span> <span class="str">${kinds[opts.spanKind] || opts.spanKind}</span>`
    );
  }
  if (opts.minDurationMs > 0) {
    predicates.push(
      `  <span class="kw">duration</span> <span class="op">&gt;</span> <span class="num">${opts.minDurationMs}ms</span>`
    );
  }
  if (opts.maxDurationMs > 0) {
    predicates.push(
      `  <span class="kw">duration</span> <span class="op">&lt;</span> <span class="num">${opts.maxDurationMs}ms</span>`
    );
  }

  if (opts.attrFilters) {
    for (const f of opts.attrFilters) {
      if (!f.key) continue;
      predicates.push(
        `  <span class="kw">.${escapeHtml(f.key)}</span> <span class="op">${escapeHtml(f.op || "=")}</span> <span class="str">"${escapeHtml(f.value || "")}"</span>`
      );
    }
  }

  if (predicates.length === 0) {
    predicates.push('  <span class="op">/* select all spans */</span>');
  }

  lines.push(predicates.join(' <span class="op">&&</span>\n'));
  lines.push('<span class="op">}</span>');

  if (opts.structural?.type && opts.structural.type !== "none") {
    const st = opts.structural;
    const inner = [];
    if (st.service)
      inner.push(
        `<span class="kw">resource.service.name</span> <span class="op">=</span> <span class="str">"${escapeHtml(st.service)}"</span>`
      );
    if (st.spanName)
      inner.push(
        `<span class="kw">name</span> <span class="op">=~</span> <span class="str">"${escapeHtml(st.spanName)}"</span>`
      );
    if (st.status !== undefined && st.status !== -1) {
      const name = st.status === 2 ? "error" : "ok";
      inner.push(
        `<span class="kw">status</span> <span class="op">=</span> <span class="str">${name}</span>`
      );
    }
    lines.push(
      `<span class="op">&gt;&gt;</span> <span class="kw">${st.type}</span> <span class="op">{</span> ${inner.join(' <span class="op">&&</span> ')} <span class="op">}</span>`
    );
  }

  if (opts.traceIntrinsics) {
    const ti = opts.traceIntrinsics;
    const parts = [];
    if (ti.rootService)
      parts.push(
        `<span class="kw">rootServiceName</span> <span class="op">=</span> <span class="str">"${escapeHtml(ti.rootService)}"</span>`
      );
    if (ti.rootSpanName)
      parts.push(
        `<span class="kw">rootName</span> <span class="op">=~</span> <span class="str">"${escapeHtml(ti.rootSpanName)}"</span>`
      );
    if (ti.minTraceDurationMs > 0)
      parts.push(
        `<span class="kw">traceDuration</span> <span class="op">&gt;</span> <span class="num">${ti.minTraceDurationMs}ms</span>`
      );
    if (parts.length > 0) {
      lines.push(`<span class="op">|</span> ${parts.join(' <span class="op">&&</span> ')}`);
    }
  }

  if (opts.sortBy) {
    lines.push(
      `<span class="op">|</span> <span class="kw">sort</span> <span class="str">${opts.sortBy}</span> <span class="kw">${opts.sortDir || "desc"}</span>`
    );
  }

  if (opts.limit) {
    lines.push(
      `<span class="op">|</span> <span class="kw">limit</span> <span class="num">${opts.limit}</span>`
    );
  }

  return lines.join("\n");
}

/**
 * Aggregate query results.
 */
export function aggregateResults(traces, opts = {}) {
  const fn = opts.fn || "count";
  const groupBy = opts.groupBy || null;
  const field = opts.field || "duration";

  if (!groupBy) {
    const value = computeAggValue(traces, fn, field);
    return { groups: [{ key: "all", value, count: traces.length }] };
  }

  const groups = new Map();
  for (const trace of traces) {
    const key = trace[groupBy] || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trace);
  }

  const result = [];
  for (const [key, groupTraces] of groups) {
    result.push({
      key,
      value: computeAggValue(groupTraces, fn, field),
      count: groupTraces.length,
    });
  }

  result.sort((a, b) => b.value - a.value);
  return { groups: result };
}

function computeAggValue(traces, fn, field) {
  const values = traces.map((t) => {
    if (field === "duration") return t.duration;
    if (field === "spanCount") return t.spanCount;
    return 0;
  });

  switch (fn) {
    case "count":
      return traces.length;
    case "avg":
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "min":
      return values.length > 0 ? Math.min(...values) : 0;
    case "max":
      return values.length > 0 ? Math.max(...values) : 0;
    case "p50": {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.5)] || 0;
    }
    case "p95": {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)] || 0;
    }
    case "p99": {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.99)] || 0;
    }
    default:
      return traces.length;
  }
}
