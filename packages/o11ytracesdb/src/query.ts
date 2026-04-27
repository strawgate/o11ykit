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

import type { Chunk } from "./chunk.js";
import { bloomFromBase64, bloomMayContain } from "./bloom.js";
import type { TraceStore } from "./engine.js";
import type {
  AnyValue,
  KeyValue,
  SpanNode,
  SpanRecord,
  StatusCode,
  Trace,
  TraceQueryOpts,
  TraceQueryResult,
} from "./types.js";

// ─── Hex lookup table (pre-computed for 0-255) ──────────────────────

const HEX_LUT: string[] = new Array(256);
for (let i = 0; i < 256; i++) HEX_LUT[i] = i.toString(16).padStart(2, "0");

function hexFromBytes(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += HEX_LUT[bytes[i]!]!;
  return hex;
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
  // Fast path: trace_id-only query — avoid all hex/Map overhead
  if (opts.traceId !== undefined && isTraceIdOnlyQuery(opts)) {
    return queryByTraceIdFast(store, opts.traceId);
  }

  return queryTracesGeneral(store, opts);
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
    opts.attributes === undefined
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

  for (const { chunk } of store.iterChunks()) {
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
      spansExamined++;
      if (bytesEqual(spans[i]!.traceId, traceId)) {
        matchingSpans.push(spans[i]!);
      }
    }
  }

  if (matchingSpans.length === 0) {
    return { traces: [], chunksScanned, chunksPruned, spansExamined };
  }

  // Assemble the single trace
  matchingSpans.sort(compareBigint);
  const rootSpan = matchingSpans.find((s) => s.parentSpanId === undefined);
  const first = matchingSpans[0]!;
  let maxEnd = first.endTimeUnixNano;
  for (let i = 1; i < matchingSpans.length; i++) {
    if (matchingSpans[i]!.endTimeUnixNano > maxEnd) maxEnd = matchingSpans[i]!.endTimeUnixNano;
  }

  const trace: Trace = {
    traceId: first.traceId,
    ...(rootSpan !== undefined ? { rootSpan } : {}),
    spans: matchingSpans,
    durationNanos: maxEnd - first.startTimeUnixNano,
  };

  return { traces: [trace], chunksScanned, chunksPruned, spansExamined };
}

/**
 * General query path — handles multi-predicate queries.
 * Groups spans by trace using hex strings + Map.
 */
function queryTracesGeneral(store: TraceStore, opts: TraceQueryOpts): TraceQueryResult {
  let chunksScanned = 0;
  let chunksPruned = 0;
  let spansExamined = 0;

  // Phase 1: Find matching spans, collect their trace IDs
  const matchingTraceIds = new Set<string>();
  const allSpansByTrace = new Map<string, SpanRecord[]>();

  for (const { resource, chunk } of store.iterChunks()) {
    // Chunk-level pruning
    if (canPruneChunk(chunk, opts, resource)) {
      chunksPruned++;
      continue;
    }

    chunksScanned++;
    const spans = store.decodeChunk(chunk);

    for (const span of spans) {
      spansExamined++;
      const traceHex = hexFromBytes(span.traceId);

      // Accumulate all spans by trace (needed for complete trace assembly)
      let group = allSpansByTrace.get(traceHex);
      if (!group) {
        group = [];
        allSpansByTrace.set(traceHex, group);
      }
      group.push(span);

      // Check if this span matches the filter
      if (matchesSpan(span, opts, resource)) {
        matchingTraceIds.add(traceHex);
      }
    }
  }

  // Phase 2: Assemble complete traces for all matching trace IDs
  let traces: Trace[] = [];
  for (const traceHex of matchingTraceIds) {
    const spans = allSpansByTrace.get(traceHex)!;
    spans.sort(compareBigint);
    const rootSpan = spans.find((s) => s.parentSpanId === undefined);
    const first = spans[0]!;
    const minStart = first.startTimeUnixNano;
    let maxEnd = first.endTimeUnixNano;
    for (let i = 1; i < spans.length; i++) {
      if (spans[i]!.endTimeUnixNano > maxEnd) maxEnd = spans[i]!.endTimeUnixNano;
    }
    traces.push({
      traceId: first.traceId,
      ...(rootSpan !== undefined ? { rootSpan } : {}),
      spans,
      durationNanos: maxEnd - minStart,
    });
  }

  // Sort traces by start time (most recent first) — safe bigint comparison
  traces.sort((a, b) => {
    const aStart = a.spans[0]!.startTimeUnixNano;
    const bStart = b.spans[0]!.startTimeUnixNano;
    return bStart > aStart ? 1 : bStart < aStart ? -1 : 0;
  });

  // Apply limit
  if (opts.limit !== undefined && traces.length > opts.limit) {
    traces = traces.slice(0, opts.limit);
  }

  return { traces, chunksScanned, chunksPruned, spansExamined };
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
    const id = hexFromBytes(span.spanId);
    nodes.set(id, { span, children: [], selfTimeNanos: 0n, depth: 0 });
  }

  // Link parent → child
  for (const span of spans) {
    const id = hexFromBytes(span.spanId);
    const node = nodes.get(id)!;
    if (span.parentSpanId !== undefined) {
      const parentId = hexFromBytes(span.parentSpanId);
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
      a.span.startTimeUnixNano < b.span.startTimeUnixNano ? -1 :
      a.span.startTimeUnixNano > b.span.startTimeUnixNano ? 1 : 0,
    );

    // Compute self-time by merging overlapping child intervals
    // then subtracting total covered time from parent duration
    const intervals: Array<{ start: bigint; end: bigint }> = [];
    for (const child of node.children) {
      // Clip child interval to parent bounds
      const start = child.span.startTimeUnixNano > node.span.startTimeUnixNano
        ? child.span.startTimeUnixNano : node.span.startTimeUnixNano;
      const end = child.span.endTimeUnixNano < node.span.endTimeUnixNano
        ? child.span.endTimeUnixNano : node.span.endTimeUnixNano;
      if (end > start) intervals.push({ start, end });
      setDepths(child, depth + 1);
    }

    // Merge overlapping intervals
    let childCoverage = 0n;
    if (intervals.length > 0) {
      intervals.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
      let mergedStart = intervals[0]!.start;
      let mergedEnd = intervals[0]!.end;
      for (let i = 1; i < intervals.length; i++) {
        const iv = intervals[i]!;
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
    r.span.durationNanos > best.span.durationNanos ? r : best,
  );

  const path: SpanNode[] = [root];
  let current = root;

  while (current.children.length > 0) {
    let latest = current.children[0]!;
    for (let i = 1; i < current.children.length; i++) {
      if (current.children[i]!.span.endTimeUnixNano > latest.span.endTimeUnixNano) {
        latest = current.children[i]!;
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
  resource: { attributes: KeyValue[] },
): boolean {
  const h = chunk.header;

  // Bloom filter pruning — skip chunks that definitely don't contain the target trace ID
  if (opts.traceId !== undefined && h.bloomFilter !== undefined) {
    const filter = bloomFromBase64(h.bloomFilter);
    if (!bloomMayContain(filter, opts.traceId)) return true;
  }

  // Time range pruning
  if (opts.startTimeNano !== undefined) {
    if (BigInt(h.maxTimeNano) < opts.startTimeNano) return true;
  }
  if (opts.endTimeNano !== undefined) {
    if (BigInt(h.minTimeNano) > opts.endTimeNano) return true;
  }

  // Error filter pruning
  if (opts.statusCode === 2 && !h.hasError) return true;

  // Span name pruning
  if (opts.spanName !== undefined && !h.spanNames.includes(opts.spanName)) return true;

  // Service name pruning
  if (opts.serviceName !== undefined) {
    const svcAttr = resource.attributes.find((a) => a.key === "service.name");
    if (svcAttr && svcAttr.value !== opts.serviceName) return true;
  }

  return false;
}

// ─── Span matching ───────────────────────────────────────────────────

function matchesSpan(
  span: SpanRecord,
  opts: TraceQueryOpts,
  resource: { attributes: KeyValue[] },
): boolean {
  if (opts.startTimeNano !== undefined && span.endTimeUnixNano < opts.startTimeNano) return false;
  if (opts.endTimeNano !== undefined && span.startTimeUnixNano > opts.endTimeNano) return false;

  if (opts.traceId !== undefined && !bytesEqual(span.traceId, opts.traceId)) return false;
  if (opts.spanName !== undefined && span.name !== opts.spanName) return false;
  if (opts.kind !== undefined && span.kind !== opts.kind) return false;
  if (opts.statusCode !== undefined && span.statusCode !== opts.statusCode) return false;

  if (opts.minDurationNanos !== undefined && span.durationNanos < opts.minDurationNanos) return false;
  if (opts.maxDurationNanos !== undefined && span.durationNanos > opts.maxDurationNanos) return false;

  if (opts.serviceName !== undefined) {
    const svcAttr = resource.attributes.find((a) => a.key === "service.name");
    if (!svcAttr || svcAttr.value !== opts.serviceName) return false;
  }

  if (opts.attributes !== undefined) {
    for (const pred of opts.attributes) {
      const attr = span.attributes.find((a) => a.key === pred.key);
      if (!attr || !anyValueEquals(attr.value, pred.value)) return false;
    }
  }

  return true;
}

// ─── Utilities ───────────────────────────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function anyValueEquals(a: AnyValue, b: AnyValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "string" || typeof a === "number" || typeof a === "bigint" || typeof a === "boolean") {
    return a === b;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return bytesEqual(a, b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!anyValueEquals(a[i]!, b[i]!)) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const aEntries = Object.entries(a as Record<string, AnyValue>);
    const bObj = b as Record<string, AnyValue>;
    if (aEntries.length !== Object.keys(bObj).length) return false;
    for (const [k, v] of aEntries) {
      if (!anyValueEquals(v, bObj[k]!)) return false;
    }
    return true;
  }
  return false;
}

/** Safe bigint sort comparator for spans by startTimeUnixNano. */
function compareBigint(a: SpanRecord, b: SpanRecord): number {
  return a.startTimeUnixNano < b.startTimeUnixNano ? -1 :
    a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0;
}

// ─── Structural queries (nested set model) ───────────────────────────

/**
 * O(1) ancestor check using nested set encoding.
 * Returns true if `ancestor` is an ancestor of `descendant`.
 * Both spans must have nestedSetLeft/Right populated and belong to the same trace.
 * (Nested set numbers are per-trace, so cross-trace comparisons are invalid.)
 */
export function isAncestorOf(ancestor: SpanRecord, descendant: SpanRecord): boolean {
  if (ancestor.nestedSetLeft === undefined || ancestor.nestedSetRight === undefined ||
      descendant.nestedSetLeft === undefined || descendant.nestedSetRight === undefined) {
    return false;
  }
  // Must be from the same trace (nested set numbers are per-trace)
  if (!bytesEqual(ancestor.traceId, descendant.traceId)) return false;
  return ancestor.nestedSetLeft < descendant.nestedSetLeft &&
         descendant.nestedSetRight < ancestor.nestedSetRight;
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
  return a.nestedSetParent === b.nestedSetParent &&
         a.nestedSetParent !== 0 &&
         a !== b;
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
