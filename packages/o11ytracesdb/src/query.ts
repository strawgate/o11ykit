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
 * - Future: BF8 bloom filter on trace_id for point lookups
 */

import type { Chunk, ChunkPolicy } from "./chunk.js";
import { ColumnarTracePolicy } from "./codec-columnar.js";
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

// ─── Query execution ─────────────────────────────────────────────────

export function queryTraces(store: TraceStore, opts: TraceQueryOpts): TraceQueryResult {
  const policy = new ColumnarTracePolicy();
  let chunksScanned = 0;
  let chunksPruned = 0;
  let spansExamined = 0;

  // Collect matching spans
  const matchingSpans: SpanRecord[] = [];

  for (const { resource, chunk } of store.iterChunks()) {
    // Chunk-level pruning
    if (canPruneChunk(chunk, opts, resource)) {
      chunksPruned++;
      continue;
    }

    chunksScanned++;
    const spans = policy.decodePayload(chunk.payload, chunk.header.nSpans, chunk.header.codecMeta);

    for (const span of spans) {
      spansExamined++;
      if (matchesSpan(span, opts, resource)) {
        matchingSpans.push(span);
      }
    }
  }

  // Group spans by trace_id → assemble traces
  const traceMap = new Map<string, SpanRecord[]>();
  for (const span of matchingSpans) {
    const key = hexFromBytes(span.traceId);
    const group = traceMap.get(key);
    if (group) {
      group.push(span);
    } else {
      traceMap.set(key, [span]);
    }
  }

  // If searching by trace_id, we want ALL spans for those traces
  // (not just the matching ones). For now, this is a single-pass query.
  // A production implementation would do a second pass to collect full traces.

  let traces: Trace[] = [];
  for (const [traceIdHex, spans] of traceMap) {
    spans.sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
    const rootSpan = spans.find((s) => s.parentSpanId === undefined);
    const first = spans[0]!;
    const minStart = first.startTimeUnixNano;
    const maxEnd = spans.reduce(
      (max, s) => (s.endTimeUnixNano > max ? s.endTimeUnixNano : max),
      first.endTimeUnixNano,
    );
    traces.push({
      traceId: first.traceId,
      ...(rootSpan !== undefined ? { rootSpan } : {}),
      spans,
      durationNanos: maxEnd - minStart,
    });
  }

  // Sort traces by start time (most recent first)
  traces.sort((a, b) => Number(b.spans[0]!.startTimeUnixNano - a.spans[0]!.startTimeUnixNano));

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
 * Returns the root node(s). Handles multiple roots (orphaned spans).
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

  // Compute depths and self-times
  function setDepths(node: SpanNode, depth: number): void {
    node.depth = depth;
    // Sort children by start time
    node.children.sort((a, b) => Number(a.span.startTimeUnixNano - b.span.startTimeUnixNano));
    // Self-time = duration - overlapping child time
    let childTime = 0n;
    for (const child of node.children) {
      // Only count child time that overlaps with parent
      const overlapStart =
        child.span.startTimeUnixNano > node.span.startTimeUnixNano
          ? child.span.startTimeUnixNano
          : node.span.startTimeUnixNano;
      const overlapEnd =
        child.span.endTimeUnixNano < node.span.endTimeUnixNano
          ? child.span.endTimeUnixNano
          : node.span.endTimeUnixNano;
      if (overlapEnd > overlapStart) {
        childTime += overlapEnd - overlapStart;
      }
      setDepths(child, depth + 1);
    }
    node.selfTimeNanos = node.span.durationNanos - childTime;
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
    // Find the child that ends latest (blocks parent completion)
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

  // Time range pruning
  if (opts.startTimeNano !== undefined) {
    const chunkMax = BigInt(h.maxTimeNano);
    if (chunkMax < opts.startTimeNano) return true;
  }
  if (opts.endTimeNano !== undefined) {
    const chunkMin = BigInt(h.minTimeNano);
    if (chunkMin > opts.endTimeNano) return true;
  }

  // Error filter pruning
  if (opts.statusCode === 2 && !h.hasError) return true;

  // Span name pruning (check if chunk's name dictionary contains the target)
  if (opts.spanName !== undefined && !h.spanNames.includes(opts.spanName)) return true;

  // Service name pruning (check resource attributes in header)
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

function hexFromBytes(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function anyValueEquals(a: AnyValue, b: AnyValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "string" || typeof a === "number" || typeof a === "bigint" || typeof a === "boolean") {
    return a === b;
  }
  // For complex types, fall back to JSON comparison
  return JSON.stringify(a) === JSON.stringify(b);
}
