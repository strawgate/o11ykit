/**
 * Build an OtlpMetricsDocument from a simple benchmark input shape.
 *
 * This is the canonical way to produce OTLP output from any parser or
 * builder. Modeled after emit-metric's buildOtlpMetricPayload().
 */
import type {
  OtlpMetricsDocument,
  OtlpAttribute,
  OtlpMetric,
  OtlpAnyValue,
} from "./types.js";
import type { Direction, RunKind, SourceFormat } from "./otlp-conventions.js";
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
} from "./otlp-conventions.js";

// ---- Input types ----------------------------------------------------------

export interface OtlpResultMetric {
  value: number;
  unit?: string;
  direction?: Direction;
}

export interface OtlpResultBenchmark {
  name: string;
  tags?: Record<string, string>;
  metrics: Record<string, OtlpResultMetric | number>;
}

export interface OtlpResultContext {
  runId?: string;
  kind?: RunKind;
  sourceFormat: SourceFormat;
  ref?: string;
  commit?: string;
  workflow?: string;
  job?: string;
  runAttempt?: string;
  runner?: string;
  serviceName?: string;
}

export interface BuildOtlpResultOptions {
  benchmarks: OtlpResultBenchmark[];
  context?: OtlpResultContext;
}

// ---- Attribute helpers ----------------------------------------------------

function toOtlpValue(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: value };
}

function attr(key: string, value: string | number | boolean): OtlpAttribute {
  return { key, value: toOtlpValue(value) };
}

function dataPointValue(value: number): { asInt?: string; asDouble?: number } {
  return Number.isSafeInteger(value)
    ? { asInt: String(value) }
    : { asDouble: value };
}

// ---- Build ----------------------------------------------------------------

function buildResourceAttributes(ctx: OtlpResultContext): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [];
  if (ctx.runId) attrs.push(attr(ATTR_RUN_ID, ctx.runId));
  if (ctx.kind) attrs.push(attr(ATTR_KIND, ctx.kind));
  attrs.push(attr(ATTR_SOURCE_FORMAT, ctx.sourceFormat));
  if (ctx.ref) attrs.push(attr(ATTR_REF, ctx.ref));
  if (ctx.commit) attrs.push(attr(ATTR_COMMIT, ctx.commit));
  if (ctx.workflow) attrs.push(attr(ATTR_WORKFLOW, ctx.workflow));
  if (ctx.job) attrs.push(attr(ATTR_JOB, ctx.job));
  if (ctx.runAttempt) attrs.push(attr(ATTR_RUN_ATTEMPT, ctx.runAttempt));
  if (ctx.runner) attrs.push(attr(ATTR_RUNNER, ctx.runner));
  if (ctx.serviceName) attrs.push(attr(ATTR_SERVICE_NAME, ctx.serviceName));
  return attrs;
}

function normalizeMetric(
  input: OtlpResultMetric | number,
): OtlpResultMetric {
  return typeof input === "number" ? { value: input } : input;
}

/**
 * Build an OtlpMetricsDocument from a list of benchmarks and optional context.
 *
 * Each benchmark becomes a scenario. Each metric key within a benchmark
 * becomes a separate OTLP metric with a single gauge datapoint carrying
 * benchkit semantic attributes.
 */
export function buildOtlpResult(options: BuildOtlpResultOptions): OtlpMetricsDocument {
  const ctx: OtlpResultContext = options.context ?? { sourceFormat: "otlp" };
  const now = String(BigInt(Date.now()) * 1_000_000n);

  const metrics: OtlpMetric[] = [];

  for (const bench of options.benchmarks) {
    for (const [metricName, rawMetric] of Object.entries(bench.metrics)) {
      const m = normalizeMetric(rawMetric);

      const pointAttrs: OtlpAttribute[] = [
        attr(ATTR_SCENARIO, bench.name),
        attr(ATTR_SERIES, bench.name),
        attr(ATTR_METRIC_ROLE, "outcome"),
      ];

      if (m.direction) {
        pointAttrs.push(attr(ATTR_METRIC_DIRECTION, m.direction));
      }

      if (bench.tags) {
        for (const [k, v] of Object.entries(bench.tags)) {
          pointAttrs.push(attr(k, v));
        }
      }

      metrics.push({
        name: metricName,
        unit: m.unit,
        gauge: {
          dataPoints: [{
            timeUnixNano: now,
            attributes: pointAttrs,
            ...dataPointValue(m.value),
          }],
        },
      });
    }
  }

  return {
    resourceMetrics: [{
      resource: {
        attributes: buildResourceAttributes(ctx),
      },
      scopeMetrics: [{
        metrics,
      }],
    }],
  };
}
