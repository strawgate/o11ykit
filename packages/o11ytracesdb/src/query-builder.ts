/**
 * Fluent query builder for o11ytracesdb.
 *
 * Provides a chainable API for constructing trace queries,
 * inspired by TraceQL and Honeycomb's query builder.
 *
 * Usage:
 *   TraceQuery.where()
 *     .service("frontend")
 *     .spanName("POST /api")
 *     .duration({ min: 100_000_000n })
 *     .attribute("http.status_code", "gte", 400)
 *     .hasAttribute("error")
 *     .status("error")
 *     .traceDuration({ min: 5_000_000_000n })
 *     .sortBy("duration", "desc")
 *     .limit(50)
 *     .exec(store);
 */

import type { TraceStore } from "./engine.js";
import { queryTraces } from "./query.js";
import type {
  AnyValue,
  AttributeOp,
  AttributePredicate,
  SortOrder,
  SpanKind,
  SpanPredicate,
  StatusCode,
  StructuralPredicate,
  StructuralRelation,
  TraceIntrinsics,
  TraceQueryOpts,
  TraceQueryResult,
  TraceSortField,
} from "./types.js";
import { SpanKind as SpanKindEnum, StatusCode as StatusCodeEnum } from "./types.js";

// ─── String-to-enum helpers ──────────────────────────────────────────

const STATUS_MAP: Record<string, StatusCode> = {
  unset: StatusCodeEnum.UNSET,
  ok: StatusCodeEnum.OK,
  error: StatusCodeEnum.ERROR,
};

const KIND_MAP: Record<string, SpanKind> = {
  internal: SpanKindEnum.INTERNAL,
  server: SpanKindEnum.SERVER,
  client: SpanKindEnum.CLIENT,
  producer: SpanKindEnum.PRODUCER,
  consumer: SpanKindEnum.CONSUMER,
};

// ─── Builder ─────────────────────────────────────────────────────────

export class TraceQuery {
  private _opts: TraceQueryOpts = {};
  private _predicates: AttributePredicate[] = [];
  private _traceFilter: TraceIntrinsics = {};
  private _structural: StructuralPredicate[] = [];

  /** Create a new builder instance. */
  static where(): TraceQuery {
    return new TraceQuery();
  }

  /** Filter by service name. */
  service(name: string): this {
    this._opts.serviceName = name;
    return this;
  }

  /** Filter by span name (exact string or regex). */
  spanName(name: string | RegExp): this {
    if (typeof name === "string") {
      this._opts.spanName = name;
    } else {
      this._opts.spanNameRegex = name;
    }
    return this;
  }

  /** Filter by trace ID (exact match). */
  traceId(id: Uint8Array): this {
    this._opts.traceId = id;
    return this;
  }

  /** Filter by time window. */
  timeRange(start?: bigint, end?: bigint): this {
    if (start !== undefined) this._opts.startTimeNano = start;
    if (end !== undefined) this._opts.endTimeNano = end;
    return this;
  }

  /** Filter by span duration range. */
  duration(opts: { min?: bigint; max?: bigint }): this {
    if (opts.min !== undefined) this._opts.minDurationNanos = opts.min;
    if (opts.max !== undefined) this._opts.maxDurationNanos = opts.max;
    return this;
  }

  /** Filter by status code (accepts string name or numeric value). */
  status(code: "unset" | "ok" | "error" | StatusCode): this {
    if (typeof code === "string") {
      this._opts.statusCode = STATUS_MAP[code]!;
    } else {
      this._opts.statusCode = code;
    }
    return this;
  }

  /** Filter by span kind (accepts string name or numeric value). */
  kind(k: "internal" | "server" | "client" | "producer" | "consumer" | SpanKind): this {
    if (typeof k === "string") {
      this._opts.kind = KIND_MAP[k]!;
    } else {
      this._opts.kind = k;
    }
    return this;
  }

  /** Add a rich attribute predicate. */
  attribute(key: string, op: AttributeOp, value?: AnyValue | AnyValue[]): this {
    this._predicates.push({
      key,
      op,
      ...(value !== undefined ? { value } : {}),
    });
    return this;
  }

  /** Shorthand: attribute must exist. */
  hasAttribute(key: string): this {
    this._predicates.push({ key, op: "exists" });
    return this;
  }

  /** Shorthand: attribute must NOT exist. */
  missingAttribute(key: string): this {
    this._predicates.push({ key, op: "notExists" });
    return this;
  }

  /** Trace-level duration filter (applied after trace assembly). */
  traceDuration(opts: { min?: bigint; max?: bigint }): this {
    if (opts.min !== undefined) this._traceFilter.minDurationNanos = opts.min;
    if (opts.max !== undefined) this._traceFilter.maxDurationNanos = opts.max;
    return this;
  }

  /** Trace-level root service name filter. */
  rootService(name: string): this {
    this._traceFilter.rootServiceName = name;
    return this;
  }

  /** Trace-level root span name filter (string or RegExp). */
  rootSpanName(name: string | RegExp): this {
    this._traceFilter.rootSpanName = name;
    return this;
  }

  /** Trace-level minimum span count filter. */
  minSpanCount(n: number): this {
    this._traceFilter.minSpanCount = n;
    return this;
  }

  // ─── Structural queries ──────────────────────────────────────────

  /**
   * Require trace to have a span matching `left` with a descendant matching `right`.
   * Equivalent to TraceQL: `{ left } >> { right }`
   */
  hasDescendant(left: SpanPredicate, right: SpanPredicate): this {
    this._structural.push({ relation: "descendant", left, right });
    return this;
  }

  /**
   * Require trace to have a span matching `left` with an ancestor matching `right`.
   * Equivalent to TraceQL: `{ left } << { right }`
   */
  hasAncestor(left: SpanPredicate, right: SpanPredicate): this {
    this._structural.push({ relation: "ancestor", left, right });
    return this;
  }

  /**
   * Require trace to have a span matching `left` with a direct child matching `right`.
   * Equivalent to TraceQL: `{ left } > { right }`
   */
  hasChild(left: SpanPredicate, right: SpanPredicate): this {
    this._structural.push({ relation: "child", left, right });
    return this;
  }

  /**
   * Require trace to have a span matching `left` with a sibling matching `right`.
   * Equivalent to TraceQL: `{ left } ~ { right }`
   */
  hasSibling(left: SpanPredicate, right: SpanPredicate): this {
    this._structural.push({ relation: "sibling", left, right });
    return this;
  }

  /** Sort results by field and direction. */
  sortBy(field: TraceSortField, order?: SortOrder): this {
    this._opts.sortBy = field;
    if (order !== undefined) this._opts.sortOrder = order;
    return this;
  }

  /** Maximum number of traces to return. */
  limit(n: number): this {
    this._opts.limit = n;
    return this;
  }

  /** Offset for pagination (skip first N traces). */
  offset(n: number): this {
    this._opts.offset = n;
    return this;
  }

  /** Build the query options object. */
  build(): TraceQueryOpts {
    const hasTraceFilter =
      this._traceFilter.minDurationNanos !== undefined ||
      this._traceFilter.maxDurationNanos !== undefined ||
      this._traceFilter.rootServiceName !== undefined ||
      this._traceFilter.rootSpanName !== undefined ||
      this._traceFilter.minSpanCount !== undefined ||
      this._traceFilter.maxSpanCount !== undefined;

    return {
      ...this._opts,
      ...(this._predicates.length > 0 ? { attributePredicates: [...this._predicates] } : {}),
      ...(hasTraceFilter ? { traceFilter: { ...this._traceFilter } } : {}),
      ...(this._structural.length > 0 ? { structuralPredicates: [...this._structural] } : {}),
    };
  }

  /** Execute the query against a store. */
  exec(store: TraceStore): TraceQueryResult {
    return queryTraces(store, this.build());
  }
}
