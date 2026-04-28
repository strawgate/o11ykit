// @ts-nocheck
// ── Query Model — Thin adapter over o11ytracesdb's real query engine ─
// Translates UI query opts → TraceQueryOpts, calls queryTraces(), and
// translates Trace[] back into the display format the UI expects.
// buildQueryPreview and aggregateResults are UI-level concerns kept here.

import { queryTraces, TraceStore } from "o11ytracesdb";
import { escapeHtml, hexFromBytes, spanAttr, spanServiceName } from "./utils.js";

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

// ── Span Predicate (for matchedSpans counting) ───────────────────────

/**
 * Build a span predicate function from query opts.
 * Used to count matchedSpans after the real engine returns results.
 * Returns null if no span-level filters are active (match all).
 */
function buildSpanPredicate(opts) {
  const checks = [];

  if (opts.service) {
    const svc = opts.service;
    checks.push((s) => spanServiceName(s) === svc);
  }

  if (opts.spanName) {
    let test;
    try {
      const re = new RegExp(opts.spanName, "i");
      test = (s) => re.test(s.name);
    } catch {
      const lower = opts.spanName.toLowerCase();
      test = (s) => s.name.toLowerCase().includes(lower);
    }
    checks.push(test);
  }

  if (opts.statusCode !== undefined && opts.statusCode !== null && opts.statusCode !== -1) {
    const code = opts.statusCode;
    checks.push((s) => s.statusCode === code);
  }

  if (opts.spanKind !== undefined && opts.spanKind !== null && opts.spanKind !== -1) {
    const kind = opts.spanKind;
    checks.push((s) => s.kind === kind);
  }

  if (opts.minDurationMs > 0) {
    const minNs = BigInt(Math.round(opts.minDurationMs * 1_000_000));
    checks.push((s) => (s.durationNanos || s.endTimeUnixNano - s.startTimeUnixNano) >= minNs);
  }

  if (opts.maxDurationMs > 0) {
    const maxNs = BigInt(Math.round(opts.maxDurationMs * 1_000_000));
    checks.push((s) => (s.durationNanos || s.endTimeUnixNano - s.startTimeUnixNano) <= maxNs);
  }

  if (opts.attrFilters && opts.attrFilters.length > 0) {
    for (const f of opts.attrFilters) {
      if (!f.key || !f.value) continue;
      const { key, op, value } = f;
      checks.push((s) => {
        const val = spanAttr(s, key);
        if (val === undefined) return op === "!=";
        const strVal = String(val);
        switch (op) {
          case "=":
            return strVal === value;
          case "!=":
            return strVal !== value;
          case "~":
            return strVal.includes(value);
          case ">":
            return Number(val) > Number(value);
          case "<":
            return Number(val) < Number(value);
          default:
            return strVal === value;
        }
      });
    }
  }

  if (checks.length === 0) return null;
  if (checks.length === 1) return checks[0];
  return (s) => {
    for (let i = 0; i < checks.length; i++) {
      if (!checks[i](s)) return false;
    }
    return true;
  };
}

// ── Main Query Engine ─────────────────────────────────────────────────

/**
 * Execute a query against a TraceStore (or raw spans array for backward compat).
 *
 * Uses the real o11ytracesdb queryTraces() engine for chunk-pruned,
 * bloom-filtered trace search. Attribute predicates are applied locally
 * to preserve demo-specific missing-attribute semantics.
 *
 * @param {TraceStore|Array} storeOrSpans - TraceStore instance or flat spans array
 * @param {QueryOpts} opts - Query options
 */
export function executeQuery(storeOrSpans, opts = {}) {
  const t0 = performance.now();

  // Support both TraceStore and raw array (backward compat for tests)
  let store;
  if (storeOrSpans instanceof TraceStore) {
    store = storeOrSpans;
  } else {
    store = new TraceStore({ chunkSize: 1024 });
    const byService = new Map();
    for (const span of storeOrSpans) {
      const svc = spanServiceName(span);
      if (!byService.has(svc)) byService.set(svc, []);
      byService.get(svc).push(span);
    }
    for (const [svc, spans] of byService) {
      store.append({ attributes: [{ key: "service.name", value: svc }] }, { name: "demo" }, spans);
    }
    store.flush();
  }

  const predicate = buildSpanPredicate(opts);
  const hasAttrFilters = opts.attrFilters?.some((f) => f.key && f.value);

  // Build TraceQueryOpts for the real engine (excluding attribute predicates)
  const queryOpts = {};

  if (opts.service) queryOpts.serviceName = opts.service;

  if (opts.spanName) {
    try {
      queryOpts.spanNameRegex = new RegExp(opts.spanName, "i");
    } catch {
      queryOpts.spanName = opts.spanName;
    }
  }

  if (opts.statusCode !== undefined && opts.statusCode !== null && opts.statusCode !== -1) {
    queryOpts.statusCode = opts.statusCode;
  }

  if (opts.spanKind !== undefined && opts.spanKind !== null && opts.spanKind !== -1) {
    queryOpts.kind = opts.spanKind;
  }

  if (opts.minDurationMs > 0) {
    queryOpts.minDurationNanos = BigInt(Math.round(opts.minDurationMs * 1_000_000));
  }

  if (opts.maxDurationMs > 0) {
    queryOpts.maxDurationNanos = BigInt(Math.round(opts.maxDurationMs * 1_000_000));
  }

  // Sort: map demo sort fields to real engine fields
  const sortBy = opts.sortBy || "duration";
  if (sortBy === "duration" || sortBy === "spanCount") {
    queryOpts.sortBy = sortBy;
  } else {
    queryOpts.sortBy = "duration";
  }
  queryOpts.sortOrder = opts.sortDir || "desc";

  // Over-fetch when local filters will discard rows; 10× keeps result sets
  // full in most cases without scanning the entire store.
  const LOCAL_FILTER_INFLATION = 10;
  const requestedLimit = opts.limit || 100;
  queryOpts.limit =
    hasAttrFilters || opts.structural?.type
      ? requestedLimit * LOCAL_FILTER_INFLATION
      : requestedLimit;

  // Trace-level intrinsics
  if (opts.traceIntrinsics) {
    const ti = opts.traceIntrinsics;
    if (ti.rootService || ti.rootSpanName || ti.minTraceDurationMs > 0) {
      queryOpts.traceFilter = {};
      if (ti.rootService) queryOpts.traceFilter.rootServiceName = ti.rootService;
      if (ti.rootSpanName) queryOpts.traceFilter.rootSpanName = ti.rootSpanName;
      if (ti.minTraceDurationMs > 0) {
        queryOpts.traceFilter.minDurationNanos = BigInt(
          Math.round(ti.minTraceDurationMs * 1_000_000)
        );
      }
    }
  }

  // Execute the real query engine
  const result = queryTraces(store, queryOpts);

  // Translate Trace[] → display format
  let traces = result.traces.map((trace) => {
    const rootSpan = trace.rootSpan;
    const root = rootSpan || trace.spans[0];
    let rootSvc = "unknown";
    if (trace.rootResource) {
      const attr = trace.rootResource.attributes.find((a) => a.key === "service.name");
      if (attr) rootSvc = attr.value;
    } else {
      rootSvc = spanServiceName(root);
    }

    const hasError = trace.spans.some((s) => s.statusCode === 2);
    return {
      traceId: hexFromBytes(trace.traceId),
      rootService: rootSvc,
      rootSpan: root?.name || "unknown",
      spanCount: trace.spans.length,
      duration: Number(trace.durationNanos),
      hasError,
      statusCode: hasError ? 2 : 1,
      spans: trace.spans,
    };
  });

  // Count matched spans using local predicate
  let matchedSpans = 0;
  for (const trace of traces) {
    for (const span of trace.spans) {
      if (!predicate || predicate(span)) matchedSpans++;
    }
  }

  // Apply local attribute filtering (preserves demo missing-attr semantics)
  if (hasAttrFilters) {
    traces = traces.filter((trace) =>
      trace.spans.some((s) => {
        for (const f of opts.attrFilters) {
          if (!f.key || !f.value) continue;
          const { key, op, value } = f;
          const val = spanAttr(s, key);
          if (val === undefined) {
            if (op !== "!=") return false;
            continue;
          }
          const strVal = String(val);
          switch (op) {
            case "=":
              if (strVal !== value) return false;
              break;
            case "!=":
              if (strVal === value) return false;
              break;
            case "~":
              if (!strVal.includes(value)) return false;
              break;
            case ">":
              if (!(Number(val) > Number(value))) return false;
              break;
            case "<":
              if (!(Number(val) < Number(value))) return false;
              break;
            default:
              if (strVal !== value) return false;
          }
        }
        return true;
      })
    );
  }

  // Apply structural predicates locally
  if (opts.structural?.type && opts.structural.type !== "none") {
    traces = applyStructuralFilter(traces, opts.structural);
  }

  // Sort by "errors" locally (not supported by real engine)
  if (sortBy === "errors") {
    const sortDir = opts.sortDir === "asc" ? 1 : -1;
    traces.sort((a, b) => ((a.hasError ? 1 : 0) - (b.hasError ? 1 : 0)) * sortDir);
  }

  // Apply final limit
  traces = traces.slice(0, requestedLimit);

  const elapsed = performance.now() - t0;
  const storeStats = store.stats();
  return {
    traces,
    matchedSpans,
    totalSpans: storeStats.sealedSpans + storeStats.hotSpans,
    traceCount: traces.length,
    elapsed,
    chunksPruned: result.chunksPruned,
    chunksScanned: result.chunksScanned,
  };
}

// ── Structural Predicates ─────────────────────────────────────────────

function applyStructuralFilter(traces, structural) {
  return traces.filter((trace) => checkStructural(trace.spans, structural));
}

function spanIdKey(id) {
  if (!id) return "";
  if (id instanceof Uint8Array) return hexFromBytes(id);
  return String(id);
}

function checkStructural(traceSpans, structural) {
  // Build parent→children within this trace using hex keys for Uint8Array IDs
  const childrenOf = new Map();
  const spanById = new Map();
  for (const s of traceSpans) {
    const sid = spanIdKey(s.spanId);
    spanById.set(sid, s);
    if (s.parentSpanId) {
      const pid = spanIdKey(s.parentSpanId);
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(s);
    }
  }

  for (const span of traceSpans) {
    const sid = spanIdKey(span.spanId);
    switch (structural.type) {
      case "hasDescendant":
        if (hasDescendant(sid, childrenOf, structural)) return true;
        break;
      case "hasAncestor":
        if (hasAncestor(span, spanById, structural)) return true;
        break;
      case "hasSibling":
        if (hasSibling(span, childrenOf, structural)) return true;
        break;
    }
  }
  return false;
}

function hasDescendant(spanKey, childrenOf, pred) {
  const children = childrenOf.get(spanKey);
  if (!children) return false;
  for (const child of children) {
    if (matchesPredicate(child, pred)) return true;
    if (hasDescendant(spanIdKey(child.spanId), childrenOf, pred)) return true;
  }
  return false;
}

function hasAncestor(span, spanById, pred) {
  let current = span;
  const visited = new Set();
  while (current.parentSpanId) {
    const pid = spanIdKey(current.parentSpanId);
    if (visited.has(pid)) break;
    visited.add(pid);
    const parent = spanById.get(pid);
    if (!parent) break;
    if (matchesPredicate(parent, pred)) return true;
    current = parent;
  }
  return false;
}

function hasSibling(span, childrenOf, pred) {
  if (!span.parentSpanId) return false;
  const pid = spanIdKey(span.parentSpanId);
  const siblings = childrenOf.get(pid);
  if (!siblings) return false;
  const sid = spanIdKey(span.spanId);
  return siblings.some((s) => spanIdKey(s.spanId) !== sid && matchesPredicate(s, pred));
}

function matchesPredicate(span, pred) {
  if (pred.service && spanServiceName(span) !== pred.service) return false;
  if (pred.spanName && !span.name.includes(pred.spanName)) return false;
  if (pred.status !== undefined && pred.status !== -1 && span.statusCode !== pred.status)
    return false;
  return true;
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
