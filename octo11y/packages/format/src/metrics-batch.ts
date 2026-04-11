/**
 * MetricsBatch — ergonomic, immutable wrapper over OtlpMetricsDocument.
 *
 * Flattens the nested OTLP structure into MetricPoint tuples and provides
 * chainable filter/group/merge operations. Round-trips cleanly to OTLP JSON.
 */
import type {
  OtlpMetricsDocument,
  OtlpAttribute,
  OtlpMetric,
  OtlpAnyValue,
  OtlpGaugeDataPoint,
} from "./types.js";
import type { Direction, MetricRole } from "./otlp-conventions.js";
import {
  ATTR_RUN_ID,
  ATTR_KIND,
  ATTR_SOURCE_FORMAT,
  ATTR_REF,
  ATTR_COMMIT,
  ATTR_WORKFLOW,
  ATTR_JOB,
  ATTR_RUN_ATTEMPT,
  ATTR_RUNNER,
  ATTR_SERVICE_NAME,
  ATTR_SCENARIO,
  ATTR_SERIES,
  ATTR_METRIC_DIRECTION,
  ATTR_METRIC_ROLE,
  MONITOR_METRIC_PREFIX,
  RESERVED_DATAPOINT_ATTRIBUTES,
} from "./otlp-conventions.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MetricPoint {
  readonly scenario: string;
  readonly series: string;
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly direction: Direction | undefined;
  readonly role: MetricRole | undefined;
  readonly tags: Readonly<Record<string, string>>;
  readonly timestamp: string | undefined;
}

export interface ResourceContext {
  readonly runId: string | undefined;
  readonly kind: string | undefined;
  readonly sourceFormat: string | undefined;
  readonly commit: string | undefined;
  readonly ref: string | undefined;
  readonly workflow: string | undefined;
  readonly job: string | undefined;
  readonly runAttempt: string | undefined;
  readonly runner: string | undefined;
  readonly serviceName: string | undefined;
}

// ---------------------------------------------------------------------------
// Attribute helpers (internal)
// ---------------------------------------------------------------------------

function getStr(attrs: OtlpAttribute[], key: string): string | undefined {
  const a = attrs.find((x) => x.key === key);
  return a?.value?.stringValue;
}

function pointValue(dp: OtlpGaugeDataPoint): number {
  if (dp.asInt !== undefined) return Number(dp.asInt);
  if (dp.asDouble !== undefined) return dp.asDouble;
  return NaN;
}

function extractResourceContext(attrs: OtlpAttribute[]): ResourceContext {
  return {
    runId: getStr(attrs, ATTR_RUN_ID),
    kind: getStr(attrs, ATTR_KIND),
    sourceFormat: getStr(attrs, ATTR_SOURCE_FORMAT),
    commit: getStr(attrs, ATTR_COMMIT),
    ref: getStr(attrs, ATTR_REF),
    workflow: getStr(attrs, ATTR_WORKFLOW),
    job: getStr(attrs, ATTR_JOB),
    runAttempt: getStr(attrs, ATTR_RUN_ATTEMPT),
    runner: getStr(attrs, ATTR_RUNNER),
    serviceName: getStr(attrs, ATTR_SERVICE_NAME),
  };
}

function flattenGaugePoints(
  metric: OtlpMetric,
  dpAttrs: (dp: OtlpGaugeDataPoint) => OtlpAttribute[],
  dpValue: (dp: OtlpGaugeDataPoint) => number,
  dataPoints: OtlpGaugeDataPoint[] | undefined,
): MetricPoint[] {
  if (!dataPoints) return [];
  const results: MetricPoint[] = [];
  for (const dp of dataPoints) {
    const attrs = dpAttrs(dp);
    const tags: Record<string, string> = {};
    for (const a of attrs) {
      if (!RESERVED_DATAPOINT_ATTRIBUTES.has(a.key) && a.value?.stringValue !== undefined) {
        tags[a.key] = a.value.stringValue;
      }
    }
    results.push({
      scenario: getStr(attrs, ATTR_SCENARIO) ?? "",
      series: getStr(attrs, ATTR_SERIES) ?? "",
      metric: metric.name,
      value: dpValue(dp),
      unit: metric.unit ?? "",
      direction: getStr(attrs, ATTR_METRIC_DIRECTION) as Direction | undefined,
      role: getStr(attrs, ATTR_METRIC_ROLE) as MetricRole | undefined,
      tags,
      timestamp: dp.timeUnixNano,
    });
  }
  return results;
}

function flattenDoc(doc: OtlpMetricsDocument): { points: MetricPoint[]; context: ResourceContext } {
  const allPoints: MetricPoint[] = [];
  let context: ResourceContext = {
    runId: undefined, kind: undefined, sourceFormat: undefined,
    commit: undefined, ref: undefined, workflow: undefined,
    job: undefined, runAttempt: undefined, runner: undefined,
    serviceName: undefined,
  };

  for (const rm of doc.resourceMetrics) {
    if (rm.resource?.attributes) {
      context = extractResourceContext(rm.resource.attributes);
    }
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        // Gauge
        if (metric.gauge?.dataPoints) {
          allPoints.push(
            ...flattenGaugePoints(metric, (dp) => dp.attributes ?? [], pointValue, metric.gauge.dataPoints),
          );
        }
        // Sum (same datapoint shape as gauge)
        if (metric.sum?.dataPoints) {
          allPoints.push(
            ...flattenGaugePoints(metric, (dp) => dp.attributes ?? [], pointValue, metric.sum.dataPoints),
          );
        }
        // Histogram → split into .count and .sum child metrics
        if (metric.histogram?.dataPoints) {
          for (const dp of metric.histogram.dataPoints) {
            const attrs = dp.attributes ?? [];
            const tags: Record<string, string> = {};
            for (const a of attrs as OtlpAttribute[]) {
              if (!RESERVED_DATAPOINT_ATTRIBUTES.has(a.key) && a.value?.stringValue !== undefined) {
                tags[a.key] = a.value.stringValue;
              }
            }
            const base = {
              scenario: getStr(attrs as OtlpAttribute[], ATTR_SCENARIO) ?? "",
              series: getStr(attrs as OtlpAttribute[], ATTR_SERIES) ?? "",
              unit: metric.unit ?? "",
              direction: getStr(attrs as OtlpAttribute[], ATTR_METRIC_DIRECTION) as Direction | undefined,
              role: getStr(attrs as OtlpAttribute[], ATTR_METRIC_ROLE) as MetricRole | undefined,
              tags,
              timestamp: dp.timeUnixNano,
            };
            if (dp.count !== undefined) {
              allPoints.push({ ...base, metric: `${metric.name}.count`, value: Number(dp.count) });
            }
            if (dp.sum !== undefined) {
              allPoints.push({ ...base, metric: `${metric.name}.sum`, value: dp.sum });
            }
          }
        }
      }
    }
  }

  return { points: allPoints, context };
}

// ---------------------------------------------------------------------------
// OTLP reconstruction helpers
// ---------------------------------------------------------------------------

function toOtlpValue(value: string): OtlpAnyValue {
  return { stringValue: value };
}

function attr(key: string, value: string): OtlpAttribute {
  return { key, value: toOtlpValue(value) };
}

function dpValue(value: number): { asInt?: string; asDouble?: number } {
  return Number.isSafeInteger(value) ? { asInt: String(value) } : { asDouble: value };
}

function contextToResourceAttrs(ctx: ResourceContext): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [];
  if (ctx.runId) attrs.push(attr(ATTR_RUN_ID, ctx.runId));
  if (ctx.kind) attrs.push(attr(ATTR_KIND, ctx.kind));
  if (ctx.sourceFormat) attrs.push(attr(ATTR_SOURCE_FORMAT, ctx.sourceFormat));
  if (ctx.ref) attrs.push(attr(ATTR_REF, ctx.ref));
  if (ctx.commit) attrs.push(attr(ATTR_COMMIT, ctx.commit));
  if (ctx.workflow) attrs.push(attr(ATTR_WORKFLOW, ctx.workflow));
  if (ctx.job) attrs.push(attr(ATTR_JOB, ctx.job));
  if (ctx.runAttempt) attrs.push(attr(ATTR_RUN_ATTEMPT, ctx.runAttempt));
  if (ctx.runner) attrs.push(attr(ATTR_RUNNER, ctx.runner));
  if (ctx.serviceName) attrs.push(attr(ATTR_SERVICE_NAME, ctx.serviceName));
  return attrs;
}

function pointToDataPointAttrs(p: MetricPoint): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [];
  if (p.scenario) attrs.push(attr(ATTR_SCENARIO, p.scenario));
  if (p.series) attrs.push(attr(ATTR_SERIES, p.series));
  if (p.role) attrs.push(attr(ATTR_METRIC_ROLE, p.role));
  if (p.direction) attrs.push(attr(ATTR_METRIC_DIRECTION, p.direction));
  for (const [k, v] of Object.entries(p.tags)) {
    attrs.push(attr(k, v));
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// MetricsBatch
// ---------------------------------------------------------------------------

const EMPTY_CONTEXT: ResourceContext = {
  runId: undefined, kind: undefined, sourceFormat: undefined,
  commit: undefined, ref: undefined, workflow: undefined,
  job: undefined, runAttempt: undefined, runner: undefined,
  serviceName: undefined,
};

export class MetricsBatch {
  readonly context: ResourceContext;
  readonly points: readonly MetricPoint[];

  private constructor(points: readonly MetricPoint[], context: ResourceContext) {
    this.points = points;
    this.context = context;
  }

  // ---- Constructors -------------------------------------------------------

  static fromOtlp(doc: OtlpMetricsDocument): MetricsBatch {
    const { points, context } = flattenDoc(doc);
    return new MetricsBatch(points, context);
  }

  static fromPoints(points: MetricPoint[], context?: ResourceContext): MetricsBatch {
    return new MetricsBatch(points, context ?? EMPTY_CONTEXT);
  }

  static merge(...batches: MetricsBatch[]): MetricsBatch {
    if (batches.length === 0) return new MetricsBatch([], EMPTY_CONTEXT);
    const allPoints = batches.flatMap((b) => b.points);
    // Use the first batch's context as the merged context
    return new MetricsBatch(allPoints, batches[0].context);
  }

  // ---- Scalar accessors ---------------------------------------------------

  get size(): number {
    return this.points.length;
  }

  get scenarios(): string[] {
    return [...new Set(this.points.map((p) => p.scenario))].sort();
  }

  get metricNames(): string[] {
    return [...new Set(this.points.map((p) => p.metric))].sort();
  }

  // ---- Filter → new MetricsBatch (chainable) ------------------------------

  filter(fn: (p: MetricPoint) => boolean): MetricsBatch {
    return new MetricsBatch(this.points.filter(fn), this.context);
  }

  forScenario(name: string): MetricsBatch {
    return this.filter((p) => p.scenario === name);
  }

  forMetric(name: string): MetricsBatch {
    return this.filter((p) => p.metric === name);
  }

  withoutMonitor(): MetricsBatch {
    return this.filter((p) => !p.metric.startsWith(MONITOR_METRIC_PREFIX));
  }

  onlyMonitor(): MetricsBatch {
    return this.filter((p) => p.metric.startsWith(MONITOR_METRIC_PREFIX));
  }

  // ---- Group → Map<key, MetricsBatch> -------------------------------------

  groupBy(fn: (p: MetricPoint) => string): Map<string, MetricsBatch> {
    const groups = new Map<string, MetricPoint[]>();
    for (const p of this.points) {
      const key = fn(p);
      let arr = groups.get(key);
      if (!arr) {
        arr = [];
        groups.set(key, arr);
      }
      arr.push(p);
    }
    const result = new Map<string, MetricsBatch>();
    for (const [key, pts] of groups) {
      result.set(key, new MetricsBatch(pts, this.context));
    }
    return result;
  }

  groupByScenario(): Map<string, MetricsBatch> {
    return this.groupBy((p) => p.scenario);
  }

  groupByMetric(): Map<string, MetricsBatch> {
    return this.groupBy((p) => p.metric);
  }

  groupBySeries(): Map<string, MetricsBatch> {
    return this.groupBy((p) => seriesKey(p));
  }

  // ---- Output -------------------------------------------------------------

  toOtlp(): OtlpMetricsDocument {
    // Group points by metric name to produce one OtlpMetric per unique name
    const metricMap = new Map<string, { unit: string; points: MetricPoint[] }>();
    for (const p of this.points) {
      let entry = metricMap.get(p.metric);
      if (!entry) {
        entry = { unit: p.unit, points: [] };
        metricMap.set(p.metric, entry);
      }
      entry.points.push(p);
    }

    const metrics: OtlpMetric[] = [];
    for (const [name, { unit, points }] of metricMap) {
      metrics.push({
        name,
        unit: unit || undefined,
        gauge: {
          dataPoints: points.map((p) => ({
            timeUnixNano: p.timestamp,
            attributes: pointToDataPointAttrs(p),
            ...dpValue(p.value),
          })),
        },
      });
    }

    return {
      resourceMetrics: [{
        resource: { attributes: contextToResourceAttrs(this.context) },
        scopeMetrics: [{ metrics }],
      }],
    };
  }

  toJson(): string {
    return JSON.stringify(this.toOtlp());
  }
}

// ---------------------------------------------------------------------------
// Utility: series key (name + sorted tags)
// ---------------------------------------------------------------------------

export function seriesKey(p: MetricPoint): string {
  const tagParts = Object.entries(p.tags).sort(([a], [b]) => a.localeCompare(b));
  if (tagParts.length === 0) return p.series || p.scenario;
  return `${p.series || p.scenario} [${tagParts.map(([k, v]) => `${k}=${v}`).join(",")}]`;
}
