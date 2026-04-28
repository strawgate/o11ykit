/**
 * Query engine for o11ytracesdb.
 *
 * Supports two primary access patterns:
 * 1. Trace assembly by ID — collect all spans for a trace, build tree
 * 2. Trace search — find traces matching attribute/time/duration predicates
 *
 * Uses chunk-level pruning via:
 * - Time-range zone maps (skip chunks outside query window)
 * - Span name dictionary (skip chunks without matching operation)
 * - Error flag (skip chunks without errors when filtering for errors)
 */

import {
  anyValueEquals,
  bytesEqual,
  bytesToHex,
  findAttribute,
  hexToBytes,
  timeRangeOverlaps,
} from "stardb";
import { bloomFromBase64, bloomMayContain } from "./bloom.js";
import type { Chunk } from "./chunk.js";
import { computeNestedSets } from "./chunk.js";
import type { TraceStore } from "./engine.js";
import type {
  AnyValue,
  AttributePredicate,
  KeyValue,
  Resource,
  SpanNode,
  SpanPredicate,
  SpanRecord,
  StructuralPredicate,
  Trace,
  TraceIntrinsics,
  TraceQueryOpts,
  TraceQueryResult,
} from "./types.js";

/** Side-channel regex cache so AttributePredicate stays a clean public type. */
const regexCache = new WeakMap<AttributePredicate, RegExp>();

/** Basic ReDoS guard: reject patterns with nested quantifiers or catastrophic backtracking constructs. */
function isSafePattern(pattern: string): boolean {
  if (pattern.length > 1000) return false;
  // Reject nested quantifiers: (x+)+ (x*)* (x+)* etc.
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) return false;
  // Reject excessive alternations that could cause exponential backtracking
  if (/(\|[^|]{0,20}){10,}/.test(pattern)) return false;
  return true;
}

// ─── Query execution ─────────────────────────────────────────────────

/**
 * Query traces from the store. Supports filtering by time range, trace ID,
 * service name, span name, duration, status, kind, and attributes.
 *
 * When filter predicates match individual spans, the engine performs a
 * second pass to collect ALL spans for matching trace IDs — ensuring
 * complete traces for tree assembly and visualization.
 *
 * **Fast path**: When querying by trace_id only, bypasses hex string allocation
 * and Map grouping — uses direct byte comparison for ~10× speedup.
 */
export function queryTraces(store: TraceStore, opts: TraceQueryOpts): TraceQueryResult {
  const t0 = performance.now();

  // Fast path: trace_id-only query — avoid all hex/Map overhead
  if (opts.traceId !== undefined && isTraceIdOnlyQuery(opts)) {
    const result = queryByTraceIdFast(store, opts.traceId);
    const queryTimeMs = performance.now() - t0;
    return { ...result, totalTraces: result.traces.length, queryTimeMs };
  }

  const result = queryTracesGeneral(store, opts);
  const queryTimeMs = performance.now() - t0;
  return { ...result, queryTimeMs };
}

/**
 * Check if this is a pure trace_id lookup (no other filters).
 * Enables the fast path that skips hex string allocation.
 */
function isTraceIdOnlyQuery(opts: TraceQueryOpts): boolean {
  return (
    opts.startTimeNano === undefined &&
    opts.endTimeNano === undefined &&
    opts.spanName === undefined &&
    opts.serviceName === undefined &&
    opts.kind === undefined &&
    opts.statusCode === undefined &&
    opts.minDurationNanos === undefined &&
    opts.maxDurationNanos === undefined &&
    opts.attributes === undefined &&
    opts.spanNameRegex === undefined &&
    opts.attributePredicates === undefined &&
    opts.traceFilter === undefined &&
    opts.structuralPredicates === undefined &&
    opts.sortBy === undefined &&
    opts.sortOrder === undefined &&
    opts.offset === undefined &&
    (opts.limit === undefined || opts.limit > 0)
  );
}

/**
 * Fast trace_id lookup: bloom-prune chunks, then collect matching spans
 * using direct byte comparison. No hex strings, no Map grouping.
 * Typically 5-10× faster than the general path for point lookups.
 */
function queryByTraceIdFast(store: TraceStore, traceId: Uint8Array): TraceQueryResult {
  let chunksScanned = 0;
  let chunksPruned = 0;
  let spansExamined = 0;
  const matchingSpans: SpanRecord[] = [];
  let rootResource: Resource | undefined;

  for (const { resource, chunk } of store.iterChunks()) {
    // Bloom filter pruning — most chunks won't contain this trace
    const h = chunk.header;
    if (h.bloomFilter !== undefined) {
      const filter = bloomFromBase64(h.bloomFilter);
      if (!bloomMayContain(filter, traceId)) {
        chunksPruned++;
        continue;
      }
    }

    chunksScanned++;
    const spans = store.decodeChunk(chunk);

    // Direct byte comparison — no hex allocation
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!span) continue;
      spansExamined++;
      if (bytesEqual(span.traceId, traceId)) {
        matchingSpans.push(span);
        // Record resource for root spans
        if (span.parentSpanId === undefined) {
          rootResource = resource;
        }
      }
    }
  }

  if (matchingSpans.length === 0) {
    return {
      traces: [],
      chunksScanned,
      chunksPruned,
      spansExamined,
      totalTraces: 0,
      queryTimeMs: 0,
    };
  }

  // Assemble the single trace
  matchingSpans.sort(compareBigint);
  const rootSpan = matchingSpans.find((s) => s.parentSpanId === undefined);
  const first = matchingSpans[0];
  if (!first) throw new Error("unreachable: matchingSpans is non-empty");
  let maxEnd = first.endTimeUnixNano;
  for (let i = 1; i < matchingSpans.length; i++) {
    const s = matchingSpans[i];
    if (!s) continue;
    if (s.endTimeUnixNano > maxEnd) maxEnd = s.endTimeUnixNano;
  }

  const trace: Trace = {
    traceId: first.traceId,
    ...(rootSpan !== undefined ? { rootSpan } : {}),
    ...(rootResource !== undefined ? { rootResource } : {}),
    spans: matchingSpans,
    durationNanos: maxEnd - first.startTimeUnixNano,
  };

  return {
    traces: [trace],
    chunksScanned,
    chunksPruned,
    spansExamined,
    totalTraces: 1,
    queryTimeMs: 0,
  };
}

/**
 * General query path — handles multi-predicate queries.
 * Groups spans by trace using hex strings + Map.
 */
function queryTracesGeneral(store: TraceStore, opts: TraceQueryOpts): TraceQueryResult {
  let chunksScanned = 0;
  let chunksPruned = 0;
  let spansExamined = 0;

  // Phase 1: Find matching trace IDs (with chunk pruning for speed)
  const matchingTraceIds = new Set<string>();

  for (const { resource, chunk } of store.iterChunks()) {
    if (canPruneChunk(chunk, opts, resource)) {
      chunksPruned++;
      continue;
    }

    chunksScanned++;
    const spans = store.decodeChunk(chunk);

    for (const span of spans) {
      spansExamined++;
      if (matchesSpan(span, opts, resource)) {
        matchingTraceIds.add(bytesToHex(span.traceId));
      }
    }
  }

  // Phase 2: Collect ALL spans for matched traces (no pruning — ensures
  // complete traces even when a trace spans multiple chunks and some
  // were pruned in phase 1).
  const allSpansByTrace = new Map<string, SpanRecord[]>();
  const rootResourceByTrace = new Map<string, Resource>();

  if (matchingTraceIds.size > 0) {
    // Pre-convert matching trace IDs to bytes for bloom filter checks
    const matchingTraceIdBytes: Uint8Array[] = [];
    for (const hex of matchingTraceIds) {
      matchingTraceIdBytes.push(hexToBytes(hex));
    }

    for (const { resource, chunk } of store.iterChunks()) {
      // Bloom filter optimization: skip chunks that definitely don't
      // contain any of the matching trace IDs
      const h = chunk.header;
      if (h.bloomFilter !== undefined) {
        const filter = bloomFromBase64(h.bloomFilter);
        let mayContainAny = false;
        for (const idBytes of matchingTraceIdBytes) {
          if (bloomMayContain(filter, idBytes)) {
            mayContainAny = true;
            break;
          }
        }
        if (!mayContainAny) continue;
      }

      const spans = store.decodeChunk(chunk);
      for (const span of spans) {
        const traceHex = bytesToHex(span.traceId);
        if (!matchingTraceIds.has(traceHex)) continue;

        let group = allSpansByTrace.get(traceHex);
        if (!group) {
          group = [];
          allSpansByTrace.set(traceHex, group);
        }
        group.push(span);

        // Record the resource for root spans (service.name lives here)
        if (span.parentSpanId === undefined) {
          rootResourceByTrace.set(traceHex, resource);
        }
      }
    }
  }

  // Phase 3: Assemble complete traces
  let traces: Trace[] = [];
  for (const traceHex of matchingTraceIds) {
    const spans = allSpansByTrace.get(traceHex);
    if (!spans || spans.length === 0) continue;
    spans.sort(compareBigint);
    const rootSpan = spans.find((s) => s.parentSpanId === undefined);
    const rootResource = rootResourceByTrace.get(traceHex);
    const first = spans[0];
    if (!first) continue;
    const minStart = first.startTimeUnixNano;
    let maxEnd = first.endTimeUnixNano;
    for (let i = 1; i < spans.length; i++) {
      const s = spans[i];
      if (!s) continue;
      if (s.endTimeUnixNano > maxEnd) maxEnd = s.endTimeUnixNano;
    }
    traces.push({
      traceId: first.traceId,
      ...(rootSpan !== undefined ? { rootSpan } : {}),
      ...(rootResource !== undefined ? { rootResource } : {}),
      spans,
      durationNanos: maxEnd - minStart,
    });
  }

  // Fix cross-chunk nested set coordinates before evaluating structural predicates
  for (const trace of traces) {
    computeNestedSets(trace.spans);
  }

  // Phase 3: Apply trace-level filters
  if (opts.traceFilter !== undefined) {
    const filter = opts.traceFilter;
    traces = traces.filter((t) => matchesTraceIntrinsics(t, filter));
  }

  // Phase 4: Apply structural predicates
  if (opts.structuralPredicates !== undefined && opts.structuralPredicates.length > 0) {
    const preds = opts.structuralPredicates;
    traces = traces.filter((t) => preds.every((pred) => matchesStructuralPredicate(t.spans, pred)));
  }

  // Sort traces
  const sortField = opts.sortBy ?? "startTime";
  const sortDir = opts.sortOrder ?? "desc";
  traces.sort((a, b) => {
    let cmp: number;
    if (sortField === "duration") {
      cmp = a.durationNanos > b.durationNanos ? 1 : a.durationNanos < b.durationNanos ? -1 : 0;
    } else if (sortField === "spanCount") {
      cmp = a.spans.length - b.spans.length;
    } else {
      // startTime
      const aStart = a.spans[0]?.startTimeUnixNano ?? 0n;
      const bStart = b.spans[0]?.startTimeUnixNano ?? 0n;
      cmp = aStart > bStart ? 1 : aStart < bStart ? -1 : 0;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const totalTraces = traces.length;

  // Apply offset
  if (opts.offset !== undefined && opts.offset > 0) {
    traces = traces.slice(opts.offset);
  }

  // Apply limit
  if (opts.limit !== undefined && traces.length > opts.limit) {
    traces = traces.slice(0, opts.limit);
  }

  return { traces, chunksScanned, chunksPruned, spansExamined, totalTraces, queryTimeMs: 0 };
}

// ─── Trace assembly (by ID) ──────────────────────────────────────────

/**
 * Assemble a single trace by ID — fetches all spans across all chunks
 * that contain this trace_id.
 */
export function assembleTrace(store: TraceStore, traceId: Uint8Array): Trace | null {
  const result = queryTraces(store, { traceId });
  return result.traces[0] ?? null;
}

// ─── Tree construction ───────────────────────────────────────────────

/**
 * Build a span tree from a flat list of spans (single trace).
 * Returns root nodes. Handles multiple roots (orphaned spans).
 * Self-time computation correctly merges overlapping children.
 */
export function buildSpanTree(spans: readonly SpanRecord[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>();
  const roots: SpanNode[] = [];

  // Create nodes
  for (const span of spans) {
    const id = bytesToHex(span.spanId);
    nodes.set(id, { span, children: [], selfTimeNanos: 0n, depth: 0 });
  }

  // Link parent → child
  for (const span of spans) {
    const id = bytesToHex(span.spanId);
    const node = nodes.get(id);
    if (!node) continue;
    if (span.parentSpanId !== undefined) {
      const parentId = bytesToHex(span.parentSpanId);
      const parentNode = nodes.get(parentId);
      if (parentNode) {
        parentNode.children.push(node);
      } else {
        roots.push(node); // orphan — treat as root
      }
    } else {
      roots.push(node);
    }
  }

  // Compute depths and self-times (with merged interval subtraction)
  function setDepths(node: SpanNode, depth: number): void {
    node.depth = depth;
    // Sort children by start time (safe bigint comparison)
    node.children.sort((a, b) =>
      a.span.startTimeUnixNano < b.span.startTimeUnixNano
        ? -1
        : a.span.startTimeUnixNano > b.span.startTimeUnixNano
          ? 1
          : 0
    );

    // Compute self-time by merging overlapping child intervals
    // then subtracting total covered time from parent duration
    const intervals: Array<{ start: bigint; end: bigint }> = [];
    for (const child of node.children) {
      // Clip child interval to parent bounds
      const start =
        child.span.startTimeUnixNano > node.span.startTimeUnixNano
          ? child.span.startTimeUnixNano
          : node.span.startTimeUnixNano;
      const end =
        child.span.endTimeUnixNano < node.span.endTimeUnixNano
          ? child.span.endTimeUnixNano
          : node.span.endTimeUnixNano;
      if (end > start) intervals.push({ start, end });
      setDepths(child, depth + 1);
    }

    // Merge overlapping intervals
    let childCoverage = 0n;
    if (intervals.length > 0) {
      intervals.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      const firstIv = intervals[0];
      if (firstIv) {
        let mergedStart = firstIv.start;
        let mergedEnd = firstIv.end;
        for (let i = 1; i < intervals.length; i++) {
          const iv = intervals[i];
          if (!iv) continue;
          if (iv.start <= mergedEnd) {
            // Overlapping — extend
            if (iv.end > mergedEnd) mergedEnd = iv.end;
          } else {
            // Gap — flush previous interval
            childCoverage += mergedEnd - mergedStart;
            mergedStart = iv.start;
            mergedEnd = iv.end;
          }
        }
        childCoverage += mergedEnd - mergedStart;
      }
    }

    node.selfTimeNanos = node.span.durationNanos - childCoverage;
    if (node.selfTimeNanos < 0n) node.selfTimeNanos = 0n;
  }

  for (const root of roots) setDepths(root, 0);
  return roots;
}

// ─── Critical path computation ───────────────────────────────────────

/**
 * Compute the critical path of a trace — the sequence of spans from
 * root to leaf that determines the total trace duration.
 *
 * Algorithm: at each node, follow the child that ends latest
 * (contributes most to blocking the parent's completion).
 */
export function criticalPath(roots: SpanNode[]): SpanNode[] {
  if (roots.length === 0) return [];

  // Pick the root with the longest duration
  const root = roots.reduce((best, r) =>
    r.span.durationNanos > best.span.durationNanos ? r : best
  );

  const path: SpanNode[] = [root];
  let current = root;

  while (current.children.length > 0) {
    let latest = current.children[0];
    if (!latest) break;
    for (let i = 1; i < current.children.length; i++) {
      const child = current.children[i];
      if (!child) continue;
      if (child.span.endTimeUnixNano > latest.span.endTimeUnixNano) {
        latest = child;
      }
    }
    path.push(latest);
    current = latest;
  }

  return path;
}

// ─── Chunk pruning ───────────────────────────────────────────────────

function canPruneChunk(
  chunk: Chunk,
  opts: TraceQueryOpts,
  resource: { attributes: KeyValue[] }
): boolean {
  const h = chunk.header;

  // Bloom filter pruning — skip chunks that definitely don't contain the target trace ID
  if (opts.traceId !== undefined && h.bloomFilter !== undefined) {
    const filter = bloomFromBase64(h.bloomFilter);
    if (!bloomMayContain(filter, opts.traceId)) return true;
  }

  // Time range pruning
  if (
    !timeRangeOverlaps(
      BigInt(h.minTimeNano),
      BigInt(h.maxTimeNano),
      opts.startTimeNano,
      opts.endTimeNano
    )
  )
    return true;

  // Error filter pruning
  if (opts.statusCode === 2 && !h.hasError) return true;

  // Span name pruning
  if (opts.spanName !== undefined && !h.spanNames.includes(opts.spanName)) return true;

  // Service name pruning
  if (opts.serviceName !== undefined) {
    const svc = findAttribute(resource.attributes, "service.name");
    if (svc !== undefined && svc !== opts.serviceName) return true;
  }

  return false;
}

// ─── Span matching ───────────────────────────────────────────────────

function matchesSpan(
  span: SpanRecord,
  opts: TraceQueryOpts,
  resource: { attributes: KeyValue[] }
): boolean {
  if (opts.startTimeNano !== undefined && span.endTimeUnixNano < opts.startTimeNano) return false;
  if (opts.endTimeNano !== undefined && span.startTimeUnixNano > opts.endTimeNano) return false;

  if (opts.traceId !== undefined && !bytesEqual(span.traceId, opts.traceId)) return false;
  if (opts.spanName !== undefined && span.name !== opts.spanName) return false;
  if (opts.spanNameRegex !== undefined) {
    opts.spanNameRegex.lastIndex = 0;
    if (!opts.spanNameRegex.test(span.name)) return false;
  }
  if (opts.kind !== undefined && span.kind !== opts.kind) return false;
  if (opts.statusCode !== undefined && span.statusCode !== opts.statusCode) return false;

  if (opts.minDurationNanos !== undefined && span.durationNanos < opts.minDurationNanos)
    return false;
  if (opts.maxDurationNanos !== undefined && span.durationNanos > opts.maxDurationNanos)
    return false;

  if (opts.serviceName !== undefined) {
    const svc = findAttribute(resource.attributes, "service.name");
    if (svc === undefined || svc !== opts.serviceName) return false;
  }

  if (opts.attributes !== undefined) {
    for (const pred of opts.attributes) {
      const val = findAttribute(span.attributes, pred.key);
      if (val === undefined || !anyValueEquals(val, pred.value)) return false;
    }
  }

  if (opts.attributePredicates !== undefined) {
    for (const pred of opts.attributePredicates) {
      if (!matchesAttributePredicate(span, pred)) return false;
    }
  }

  return true;
}

// ─── Attribute predicate matching ────────────────────────────────────

/** Extract a comparable numeric value from an AnyValue (number or bigint). */
function toComparable(v: AnyValue): number | bigint | string | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return v;
  if (typeof v === "string") return v;
  return null;
}

/**
 * Evaluate a rich attribute predicate against a span.
 * Handles all AttributeOp values.
 */
function matchesAttributePredicate(span: SpanRecord, pred: AttributePredicate): boolean {
  const attrVal = findAttribute(span.attributes, pred.key);

  if (pred.op === "exists") return attrVal !== undefined;
  if (pred.op === "notExists") return attrVal === undefined;

  if (attrVal === undefined) return false;

  switch (pred.op) {
    case "eq":
      return anyValueEquals(attrVal, pred.value as AnyValue);

    case "neq":
      return !anyValueEquals(attrVal, pred.value as AnyValue);

    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toComparable(attrVal);
      const b = toComparable(pred.value as AnyValue);
      if (a === null || b === null) return false;
      if (typeof a !== typeof b) return false;
      switch (pred.op) {
        case "gt":
          return a > b;
        case "gte":
          return a >= b;
        case "lt":
          return a < b;
        case "lte":
          return a <= b;
      }
      break;
    }

    case "regex": {
      if (typeof attrVal !== "string" || typeof pred.value !== "string") return false;
      if (!isSafePattern(pred.value)) return false;
      try {
        let re = regexCache.get(pred);
        if (!re) {
          re = new RegExp(pred.value, "u");
          regexCache.set(pred, re);
        }
        re.lastIndex = 0;
        return re.test(attrVal);
      } catch {
        return false;
      }
    }

    case "contains": {
      if (typeof attrVal !== "string" || typeof pred.value !== "string") return false;
      return attrVal.includes(pred.value);
    }

    case "startsWith": {
      if (typeof attrVal !== "string" || typeof pred.value !== "string") return false;
      return attrVal.startsWith(pred.value);
    }

    case "in": {
      if (!Array.isArray(pred.value)) return false;
      return (pred.value as AnyValue[]).some((v) => anyValueEquals(attrVal, v));
    }
  }

  return false;
}

// ─── Trace-level intrinsics matching ─────────────────────────────────

/** Check if an assembled trace matches trace-level filter predicates. */
function matchesTraceIntrinsics(trace: Trace, filter: TraceIntrinsics): boolean {
  if (filter.minDurationNanos !== undefined && trace.durationNanos < filter.minDurationNanos)
    return false;
  if (filter.maxDurationNanos !== undefined && trace.durationNanos > filter.maxDurationNanos)
    return false;

  if (filter.minSpanCount !== undefined && trace.spans.length < filter.minSpanCount) return false;
  if (filter.maxSpanCount !== undefined && trace.spans.length > filter.maxSpanCount) return false;

  if (filter.rootServiceName !== undefined) {
    // service.name is a resource attribute in OTLP, not a span attribute
    if (trace.rootResource !== undefined) {
      const svc = findAttribute(trace.rootResource.attributes, "service.name");
      if (svc === undefined || svc !== filter.rootServiceName) return false;
    } else {
      // No resource attached — cannot match rootServiceName
      return false;
    }
  }

  if (filter.rootSpanName !== undefined) {
    if (trace.rootSpan === undefined) return false;
    if (typeof filter.rootSpanName === "string") {
      if (trace.rootSpan.name !== filter.rootSpanName) return false;
    } else {
      filter.rootSpanName.lastIndex = 0;
      if (!filter.rootSpanName.test(trace.rootSpan.name)) return false;
    }
  }

  return true;
}

// ─── Structural predicate matching ───────────────────────────────────

/**
 * Check if a span matches a SpanPredicate (used inside structural queries).
 * All specified fields must match (AND).
 */
function matchesSpanPredicate(span: SpanRecord, pred: SpanPredicate): boolean {
  if (pred.spanName !== undefined && span.name !== pred.spanName) return false;
  if (pred.spanNameRegex !== undefined) {
    pred.spanNameRegex.lastIndex = 0;
    if (!pred.spanNameRegex.test(span.name)) return false;
  }
  if (pred.statusCode !== undefined && span.statusCode !== pred.statusCode) return false;
  if (pred.kind !== undefined && span.kind !== pred.kind) return false;
  if (pred.attributes !== undefined) {
    for (const attrPred of pred.attributes) {
      if (!matchesAttributePredicate(span, attrPred)) return false;
    }
  }
  return true;
}

/**
 * Check if a trace's spans satisfy a structural predicate.
 * Uses nested set encoding for O(1) relationship checks.
 */
function matchesStructuralPredicate(
  spans: readonly SpanRecord[],
  pred: StructuralPredicate
): boolean {
  const leftSpans = spans.filter((s) => matchesSpanPredicate(s, pred.left));
  const rightSpans = spans.filter((s) => matchesSpanPredicate(s, pred.right));

  if (leftSpans.length === 0 || rightSpans.length === 0) return false;

  const spanByHex = new Map<string, SpanRecord>();
  for (const s of spans) spanByHex.set(bytesToHex(s.spanId), s);

  for (const a of leftSpans) {
    for (const b of rightSpans) {
      if (a === b) continue;
      if (checkRelation(a, b, pred.relation, spanByHex)) return true;
    }
  }
  return false;
}

function checkRelation(
  a: SpanRecord,
  b: SpanRecord,
  relation: StructuralPredicate["relation"],
  spanByHex: Map<string, SpanRecord>
): boolean {
  switch (relation) {
    case "descendant":
      if (
        a.nestedSetLeft !== undefined &&
        a.nestedSetRight !== undefined &&
        b.nestedSetLeft !== undefined &&
        b.nestedSetRight !== undefined
      ) {
        return a.nestedSetLeft < b.nestedSetLeft && b.nestedSetRight < a.nestedSetRight;
      }
      return isDescendantByParent(b, a, spanByHex);

    case "ancestor":
      if (
        a.nestedSetLeft !== undefined &&
        a.nestedSetRight !== undefined &&
        b.nestedSetLeft !== undefined &&
        b.nestedSetRight !== undefined
      ) {
        return b.nestedSetLeft < a.nestedSetLeft && a.nestedSetRight < b.nestedSetRight;
      }
      return isDescendantByParent(a, b, spanByHex);

    case "child":
      if (b.parentSpanId !== undefined) {
        return bytesEqual(b.parentSpanId, a.spanId);
      }
      return false;

    case "parent":
      if (a.parentSpanId !== undefined) {
        return bytesEqual(a.parentSpanId, b.spanId);
      }
      return false;

    case "sibling":
      if (a.parentSpanId !== undefined && b.parentSpanId !== undefined) {
        return bytesEqual(a.parentSpanId, b.parentSpanId);
      }
      // Root spans (no parent) are not considered siblings
      return false;
  }
}

function isDescendantByParent(
  descendant: SpanRecord,
  ancestor: SpanRecord,
  spanByHex: Map<string, SpanRecord>
): boolean {
  const visited = new Set<string>();
  let current: SpanRecord | undefined = descendant;
  while (current?.parentSpanId !== undefined) {
    const parentHex = bytesToHex(current.parentSpanId);
    if (visited.has(parentHex)) return false;
    if (bytesEqual(current.parentSpanId, ancestor.spanId)) return true;
    visited.add(parentHex);
    current = spanByHex.get(parentHex);
  }
  return false;
}

// ─── Utilities ───────────────────────────────────────────────────────

/** Safe bigint sort comparator for spans by startTimeUnixNano. */
function compareBigint(a: SpanRecord, b: SpanRecord): number {
  return a.startTimeUnixNano < b.startTimeUnixNano
    ? -1
    : a.startTimeUnixNano > b.startTimeUnixNano
      ? 1
      : 0;
}

// ─── Structural queries (nested set model) ───────────────────────────

/**
 * O(1) ancestor check using nested set encoding.
 * Returns true if `ancestor` is an ancestor of `descendant`.
 * Both spans must have nestedSetLeft/Right populated and belong to the same trace.
 * (Nested set numbers are per-trace, so cross-trace comparisons are invalid.)
 */
export function isAncestorOf(ancestor: SpanRecord, descendant: SpanRecord): boolean {
  if (
    ancestor.nestedSetLeft === undefined ||
    ancestor.nestedSetRight === undefined ||
    descendant.nestedSetLeft === undefined ||
    descendant.nestedSetRight === undefined
  ) {
    return false;
  }
  // Must be from the same trace (nested set numbers are per-trace)
  if (!bytesEqual(ancestor.traceId, descendant.traceId)) return false;
  return (
    ancestor.nestedSetLeft < descendant.nestedSetLeft &&
    descendant.nestedSetRight < ancestor.nestedSetRight
  );
}

/**
 * O(1) descendant check (inverse of isAncestorOf).
 */
export function isDescendantOf(descendant: SpanRecord, ancestor: SpanRecord): boolean {
  return isAncestorOf(ancestor, descendant);
}

/**
 * O(1) sibling check — two spans with the same nestedSetParent and same trace.
 */
export function isSiblingOf(a: SpanRecord, b: SpanRecord): boolean {
  if (a.nestedSetParent === undefined || b.nestedSetParent === undefined) return false;
  if (!bytesEqual(a.traceId, b.traceId)) return false;
  return a.nestedSetParent === b.nestedSetParent && a.nestedSetParent !== 0 && a !== b;
}

/**
 * Compute the depth of a span from its nested set encoding.
 * Counts how many other spans in the list are ancestors of this span.
 * For pre-computed depth, use buildSpanTree() instead.
 */
export function nestedSetDepth(span: SpanRecord, allSpans: readonly SpanRecord[]): number {
  if (span.nestedSetLeft === undefined) return 0;
  let depth = 0;
  for (const other of allSpans) {
    if (other !== span && isAncestorOf(other, span)) depth++;
  }
  return depth;
}
