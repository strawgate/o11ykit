// @ts-nocheck
// ── Traces Model — RED metrics, anomaly detection, insights ─────────
import { aggregateSpans, deriveREDMetrics } from "o11ytracesdb";
import { normalizeTraceId, spanServiceName } from "./utils.js";

/**
 * Compute RED (Rate, Error, Duration) metrics per service.
 * Uses the engine's aggregateSpans() for percentiles and deriveREDMetrics()
 * for time-bucketed sparkline data and error counts.
 * @param {Array} spans All spans
 * @param {string[]} serviceNames
 * @returns {Map<string, ServiceMetrics>}
 */
export function computeServiceMetrics(spans, serviceNames) {
  const metrics = new Map();

  for (const name of serviceNames) {
    metrics.set(name, {
      name,
      spanCount: 0,
      errorCount: 0,
      totalDurationNs: 0n,
      errorTimeBuckets: new Array(20).fill(0),
      rateBuckets: new Array(20).fill(0),
    });
  }

  if (spans.length === 0) return metrics;

  let minTime = spans[0].startTimeUnixNano;
  let maxTime = spans[0].startTimeUnixNano;
  for (const span of spans) {
    if (span.startTimeUnixNano < minTime) minTime = span.startTimeUnixNano;
    if (span.startTimeUnixNano > maxTime) maxTime = span.startTimeUnixNano;
  }

  const timeRange = maxTime - minTime;
  // Divide time range into ~20 buckets for sparklines; require at least 1ns per bucket
  const bucketSizeNanos = timeRange >= 20n ? timeRange / 20n : 1_000_000_000n;

  // Group spans by service for per-service engine calls
  const byService = new Map();
  for (const span of spans) {
    const svc = spanServiceName(span);
    if (!byService.has(svc)) byService.set(svc, []);
    byService.get(svc).push(span);
  }

  for (const [name, svcSpans] of byService) {
    const m = metrics.get(name);
    if (!m) continue;

    // Delegate percentile/sum/count computation to the engine
    const agg = aggregateSpans(svcSpans, [
      { fn: "count", field: "duration" },
      { fn: "sum", field: "duration" },
      { fn: "p50", field: "duration" },
      { fn: "p95", field: "duration" },
      { fn: "p99", field: "duration" },
      { fn: "max", field: "duration" },
    ]);
    const getVal = (fn) => agg.results.find((r) => r.fn === fn)?.value ?? 0;

    m.spanCount = Number(getVal("count"));
    m.totalDurationNs = BigInt(getVal("sum"));
    m.p50DurationNs = Number(getVal("p50"));
    m.p95DurationNs = Number(getVal("p95"));
    m.p99DurationNs = Number(getVal("p99"));
    m.maxDurationNs = Number(getVal("max"));
    m.avgDurationNs = m.spanCount > 0 ? Number(m.totalDurationNs) / m.spanCount : 0;

    // Delegate bucketed error/rate data to the engine
    const red = deriveREDMetrics(svcSpans, bucketSizeNanos, name);
    for (const r of red) {
      const rawOffset = r.bucketStartNano > minTime ? Number(r.bucketStartNano - minTime) : 0;
      const bucket =
        timeRange > 0n
          ? Math.min(19, Math.max(0, Math.floor((rawOffset / Number(timeRange)) * 20)))
          : 0;
      m.rateBuckets[bucket] += r.rate;
      m.errorTimeBuckets[bucket] += r.errors;
      m.errorCount += r.errors;
    }

    m.errorRate = m.spanCount > 0 ? m.errorCount / m.spanCount : 0;
  }

  return metrics;
}

/**
 * Detect anomalies / problematic traces.
 * Returns ranked list of problematic traces with severity.
 */
export function detectProblematicTraces(spans, serviceMetrics) {
  const traceMap = groupByTrace(spans);
  const problems = [];

  for (const [traceId, traceSpans] of traceMap) {
    const issues = [];

    const rootSpan = traceSpans.find((s) => !s.parentSpanId);
    const traceDur = rootSpan
      ? Number(rootSpan.endTimeUnixNano - rootSpan.startTimeUnixNano)
      : traceSpans.reduce(
          (max, s) => Math.max(max, Number(s.endTimeUnixNano - s.startTimeUnixNano)),
          0
        );

    const errorSpans = traceSpans.filter((s) => s.statusCode === 2);
    if (errorSpans.length > 0) {
      issues.push({
        type: "errors",
        severity: errorSpans.length > 3 ? "high" : "medium",
        message: `${errorSpans.length} error span(s)`,
      });
    }

    if (traceDur > 1_000_000_000) {
      issues.push({
        type: "slow",
        severity: traceDur > 5_000_000_000 ? "high" : "medium",
        message: `Trace duration: ${(traceDur / 1_000_000).toFixed(0)}ms`,
      });
    }

    for (const span of traceSpans) {
      const svc = spanServiceName(span);
      const m = serviceMetrics.get(svc);
      if (m && Number(span.durationNanos || 0) > m.p99DurationNs * 1.5) {
        issues.push({
          type: "p99-outlier",
          severity: "medium",
          message: `${span.name} exceeds p99 for ${svc}`,
        });
        break;
      }
    }

    if (issues.length > 0) {
      const severity = issues.some((i) => i.severity === "high") ? "high" : "medium";
      problems.push({
        traceId,
        rootService: rootSpan ? spanServiceName(rootSpan) : "unknown",
        rootSpan: rootSpan?.name || "unknown",
        spanCount: traceSpans.length,
        duration: traceDur,
        errorCount: errorSpans.length,
        severity,
        issues,
      });
    }
  }

  problems.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    return (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2) || b.errorCount - a.errorCount;
  });

  return problems.slice(0, 50);
}

/**
 * Generate insights from metrics.
 */
export function generateInsights(serviceMetrics) {
  const insights = [];

  for (const [name, m] of serviceMetrics) {
    if (m.errorRate > 0.05) {
      insights.push({
        severity: m.errorRate > 0.15 ? "high" : "medium",
        icon: "🔴",
        message: `${name} has ${(m.errorRate * 100).toFixed(1)}% error rate`,
      });
    }

    if (m.p99DurationNs > 500_000_000) {
      insights.push({
        severity: m.p99DurationNs > 2_000_000_000 ? "high" : "medium",
        icon: "🐢",
        message: `${name} p99 latency is ${(m.p99DurationNs / 1_000_000).toFixed(0)}ms`,
      });
    }

    if (m.p99DurationNs > m.p50DurationNs * 10) {
      insights.push({
        severity: "medium",
        icon: "📊",
        message: `${name} has high latency variance (p99/p50 = ${(m.p99DurationNs / Math.max(1, m.p50DurationNs)).toFixed(1)}x)`,
      });
    }
  }

  const totalErrors = [...serviceMetrics.values()].reduce((a, m) => a + m.errorCount, 0);
  const totalSpans = [...serviceMetrics.values()].reduce((a, m) => a + m.spanCount, 0);
  if (totalErrors > 0) {
    insights.push({
      severity: "low",
      icon: "📈",
      message: `Overall error rate: ${((totalErrors / totalSpans) * 100).toFixed(2)}% (${totalErrors} / ${totalSpans})`,
    });
  }

  insights.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    return (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2);
  });

  return insights;
}

/**
 * Group spans by traceId.
 */
export function groupByTrace(spans) {
  const map = new Map();
  for (const span of spans) {
    const tid = normalizeTraceId(span.traceId);
    if (!map.has(tid)) map.set(tid, []);
    map.get(tid).push(span);
  }
  return map;
}

/**
 * Build trace summary for results table.
 */
export function buildTraceSummaries(spans) {
  const traceMap = groupByTrace(spans);
  const summaries = [];

  for (const [traceId, traceSpans] of traceMap) {
    const rootSpan = traceSpans.find((s) => !s.parentSpanId);
    const hasError = traceSpans.some((s) => s.statusCode === 2);
    const duration = rootSpan
      ? Number(rootSpan.endTimeUnixNano - rootSpan.startTimeUnixNano)
      : traceSpans.reduce(
          (max, s) => Math.max(max, Number(s.endTimeUnixNano - s.startTimeUnixNano)),
          0
        );

    summaries.push({
      traceId,
      rootService: rootSpan ? spanServiceName(rootSpan) : "unknown",
      rootSpan: rootSpan?.name || traceSpans[0]?.name || "unknown",
      spanCount: traceSpans.length,
      duration,
      hasError,
      statusCode: hasError ? 2 : 1,
      spans: traceSpans,
    });
  }

  return summaries;
}
