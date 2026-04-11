import type {
  OtlpAttribute,
  OtlpMetric,
  OtlpMetricsDocument,
  ParseContext,
  ParsedBenchmark,
  ParsedMetric,
} from "./types.js";

function toAnyValue(value: string | number | boolean): OtlpAttribute["value"] {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function attr(key: string, value: string | number | boolean): OtlpAttribute {
  return { key, value: toAnyValue(value) };
}

function pointValue(value: number): { asInt?: string; asDouble?: number } {
  return Number.isSafeInteger(value) ? { asInt: String(value) } : { asDouble: value };
}

function normalizeMetric(metric: ParsedMetric | number): ParsedMetric {
  return typeof metric === "number" ? { value: metric } : metric;
}

function buildResourceAttributes(ctx: ParseContext): OtlpAttribute[] {
  const out: OtlpAttribute[] = [attr("o11ykit.source_format", ctx.sourceFormat)];
  if (ctx.runId) out.push(attr("o11ykit.run_id", ctx.runId));
  if (ctx.commit) out.push(attr("o11ykit.commit", ctx.commit));
  if (ctx.ref) out.push(attr("o11ykit.ref", ctx.ref));
  if (ctx.workflow) out.push(attr("o11ykit.workflow", ctx.workflow));
  if (ctx.job) out.push(attr("o11ykit.job", ctx.job));
  if (ctx.runAttempt) out.push(attr("o11ykit.run_attempt", ctx.runAttempt));
  if (ctx.runner) out.push(attr("o11ykit.runner", ctx.runner));
  return out;
}

export function buildOtlpResult(
  benchmarks: readonly ParsedBenchmark[],
  context: ParseContext
): OtlpMetricsDocument {
  const now = String(BigInt(Date.now()) * 1_000_000n);
  const metrics: OtlpMetric[] = [];

  for (const benchmark of benchmarks) {
    for (const [metricName, inputMetric] of Object.entries(benchmark.metrics)) {
      const metric = normalizeMetric(inputMetric);
      const pointAttributes: OtlpAttribute[] = [
        attr("o11ykit.scenario", benchmark.name),
        attr("o11ykit.series", benchmark.name),
      ];

      if (metric.direction) {
        pointAttributes.push(attr("o11ykit.metric_direction", metric.direction));
      }
      if (benchmark.tags) {
        for (const [key, value] of Object.entries(benchmark.tags)) {
          pointAttributes.push(attr(key, value));
        }
      }

      metrics.push({
        name: metricName,
        ...(metric.unit ? { unit: metric.unit } : {}),
        gauge: {
          dataPoints: [
            {
              timeUnixNano: now,
              attributes: pointAttributes,
              ...pointValue(metric.value),
            },
          ],
        },
      });
    }
  }

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: buildResourceAttributes(context),
        },
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };
}

export function mergeOtlpDocuments(
  benchmarkDoc: OtlpMetricsDocument,
  monitorDoc: OtlpMetricsDocument | undefined
): OtlpMetricsDocument {
  if (!monitorDoc) return benchmarkDoc;
  return {
    resourceMetrics: [...benchmarkDoc.resourceMetrics, ...monitorDoc.resourceMetrics],
  };
}

export function countDataPoints(doc: OtlpMetricsDocument): number {
  let count = 0;
  for (const rm of doc.resourceMetrics) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        count += metric.gauge?.dataPoints?.length ?? 0;
      }
    }
  }
  return count;
}
