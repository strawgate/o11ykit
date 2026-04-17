/**
 * Synthetic OTLP metrics generator.
 *
 * Produces ExportMetricsServiceRequest JSON payloads covering all 5 OTLP
 * metric types: Gauge, Sum, Histogram, ExponentialHistogram, Summary.
 *
 * We generate JSON and then convert to protobuf for wire encoding because
 * VictoriaMetrics only accepts protobuf, while Prometheus/Mimir accept both.
 */

import type { BenchConfig } from "./config.js";

// ── OTLP JSON types (subset needed for generation) ─────────────────────

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpNumberDataPoint {
  attributes: OtlpKeyValue[];
  timeUnixNano: string;
  startTimeUnixNano: string;
  asDouble?: number;
  asInt?: string;
}

interface OtlpHistogramDataPoint {
  attributes: OtlpKeyValue[];
  timeUnixNano: string;
  startTimeUnixNano: string;
  count: string;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
}

interface OtlpExponentialHistogramDataPoint {
  attributes: OtlpKeyValue[];
  timeUnixNano: string;
  startTimeUnixNano: string;
  count: string;
  sum: number;
  scale: number;
  zeroCount: string;
  positive: { offset: number; bucketCounts: string[] };
  negative: { offset: number; bucketCounts: string[] };
}

interface OtlpSummaryDataPoint {
  attributes: OtlpKeyValue[];
  timeUnixNano: string;
  startTimeUnixNano: string;
  count: string;
  sum: number;
  quantileValues: { quantile: number; value: number }[];
}

interface OtlpMetric {
  name: string;
  unit?: string;
  description?: string;
  gauge?: { dataPoints: OtlpNumberDataPoint[] };
  sum?: {
    dataPoints: OtlpNumberDataPoint[];
    aggregationTemporality: number;
    isMonotonic: boolean;
  };
  histogram?: {
    dataPoints: OtlpHistogramDataPoint[];
    aggregationTemporality: number;
  };
  exponentialHistogram?: {
    dataPoints: OtlpExponentialHistogramDataPoint[];
    aggregationTemporality: number;
  };
  summary?: { dataPoints: OtlpSummaryDataPoint[] };
}

export interface OtlpExportRequest {
  resourceMetrics: {
    resource: { attributes: OtlpKeyValue[] };
    scopeMetrics: {
      scope: { name: string; version: string };
      metrics: OtlpMetric[];
    }[];
  }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function attr(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function nsTimestamp(epochMs: number): string {
  return (BigInt(epochMs) * 1_000_000n).toString();
}

const HISTOGRAM_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Deterministic pseudo-random for reproducibility */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

// ── Generator ───────────────────────────────────────────────────────────

/**
 * Generate a batch of OTLP export requests.
 * Returns an array of request objects (JSON-serialisable) that each contain
 * a slice of time-series data. Each request covers one batch of samples
 * across all series and all metric types.
 */
export function generateOtlpRequests(config: BenchConfig): OtlpExportRequest[] {
  const requests: OtlpExportRequest[] = [];
  const rand = seededRandom(42);

  const totalSamples = config.samplesPerSeries;
  const intervalMs = config.sampleIntervalSec * 1000;

  // For each time step we produce one export request with all series
  for (let sampleIdx = 0; sampleIdx < totalSamples; sampleIdx += config.batchSize) {
    const batchEnd = Math.min(sampleIdx + config.batchSize, totalSamples);
    const metrics: OtlpMetric[] = [];

    for (let step = sampleIdx; step < batchEnd; step++) {
      const ts = config.startTimeMs + step * intervalMs;
      const startTs = config.startTimeMs;
      const tsNano = nsTimestamp(ts);
      const startNano = nsTimestamp(startTs);

      // ── Gauge: cpu_usage_percent ──
      const gaugePoints: OtlpNumberDataPoint[] = [];
      for (let s = 0; s < config.seriesCount; s++) {
        gaugePoints.push({
          attributes: [
            attr("host", `host-${s}`),
            attr("region", `region-${s % 3}`),
          ],
          timeUnixNano: tsNano,
          startTimeUnixNano: startNano,
          asDouble: 20 + rand() * 80,
        });
      }
      metrics.push({
        name: "bench_cpu_usage_percent",
        unit: "",
        description: "Synthetic CPU usage gauge",
        gauge: { dataPoints: gaugePoints },
      });

      // ── Sum (monotonic counter): http_requests_total ──
      const sumPoints: OtlpNumberDataPoint[] = [];
      for (let s = 0; s < config.seriesCount; s++) {
        sumPoints.push({
          attributes: [
            attr("host", `host-${s}`),
            attr("method", ["GET", "POST", "PUT", "DELETE"][s % 4]),
            attr("status", ["200", "201", "400", "500"][s % 4]),
          ],
          timeUnixNano: tsNano,
          startTimeUnixNano: startNano,
          asDouble: (step + 1) * (10 + s) + rand() * 5,
        });
      }
      metrics.push({
        name: "bench_http_requests_total",
        unit: "1",
        description: "Synthetic HTTP request counter",
        sum: {
          dataPoints: sumPoints,
          aggregationTemporality: 2, // CUMULATIVE
          isMonotonic: true,
        },
      });

      // ── Histogram: request_duration_seconds ──
      const histPoints: OtlpHistogramDataPoint[] = [];
      for (let s = 0; s < config.seriesCount; s++) {
        const count = Math.floor(50 + rand() * 200);
        // Generate bucket counts that sum to count
        // OTLP has len(bounds)+1 buckets (last is the overflow/+Inf bucket)
        const numBuckets = HISTOGRAM_BOUNDS.length + 1;
        const rawBuckets: number[] = [];
        let remaining = count;
        for (let b = 0; b < numBuckets - 1; b++) {
          const val = Math.floor(rand() * (remaining / (numBuckets - b)));
          rawBuckets.push(val);
          remaining -= val;
        }
        rawBuckets.push(remaining); // last bucket gets the remainder
        const bucketCounts = rawBuckets.map((v) => v.toString());
        histPoints.push({
          attributes: [
            attr("host", `host-${s}`),
            attr("endpoint", `/api/v${s % 3}`),
          ],
          timeUnixNano: tsNano,
          startTimeUnixNano: startNano,
          count: count.toString(),
          sum: count * (0.05 + rand() * 0.5),
          bucketCounts,
          explicitBounds: HISTOGRAM_BOUNDS,
        });
      }
      metrics.push({
        name: "bench_request_duration_seconds",
        unit: "s",
        description: "Synthetic request duration histogram",
        histogram: {
          dataPoints: histPoints,
          aggregationTemporality: 2,
        },
      });

      // ── Exponential Histogram: db_query_duration_seconds ──
      const expHistPoints: OtlpExponentialHistogramDataPoint[] = [];
      for (let s = 0; s < config.seriesCount; s++) {
        const count = Math.floor(100 + rand() * 300);
        const numBuckets = 8;
        const zeroCount = Math.floor(rand() * 5);
        // Distribute (count - zeroCount) across positive buckets
        let remaining = count - zeroCount;
        const posBuckets: string[] = [];
        for (let b = 0; b < numBuckets - 1; b++) {
          const val = Math.floor(rand() * (remaining / (numBuckets - b)));
          posBuckets.push(val.toString());
          remaining -= val;
        }
        posBuckets.push(remaining.toString());
        expHistPoints.push({
          attributes: [
            attr("host", `host-${s}`),
            attr("query_type", ["select", "insert", "update"][s % 3]),
          ],
          timeUnixNano: tsNano,
          startTimeUnixNano: startNano,
          count: count.toString(),
          sum: count * (0.001 + rand() * 0.1),
          scale: 3,
          zeroCount: zeroCount.toString(),
          positive: { offset: 0, bucketCounts: posBuckets },
          negative: { offset: 0, bucketCounts: [] },
        });
      }
      metrics.push({
        name: "bench_db_query_duration_seconds",
        unit: "s",
        description: "Synthetic DB query duration (exponential histogram)",
        exponentialHistogram: {
          dataPoints: expHistPoints,
          aggregationTemporality: 2,
        },
      });

      // ── Summary: gc_pause_seconds ──
      const summaryPoints: OtlpSummaryDataPoint[] = [];
      for (let s = 0; s < config.seriesCount; s++) {
        const count = Math.floor(20 + rand() * 100);
        const base = 0.001 + rand() * 0.01;
        summaryPoints.push({
          attributes: [
            attr("host", `host-${s}`),
            attr("generation", `gen${s % 3}`),
          ],
          timeUnixNano: tsNano,
          startTimeUnixNano: startNano,
          count: count.toString(),
          sum: count * base,
          quantileValues: [
            { quantile: 0.5, value: base },
            { quantile: 0.9, value: base * 2 },
            { quantile: 0.99, value: base * 5 },
          ],
        });
      }
      metrics.push({
        name: "bench_gc_pause_seconds",
        unit: "s",
        description: "Synthetic GC pause summary",
        summary: { dataPoints: summaryPoints },
      });
    }

    requests.push({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              attr("service.name", "tsdb-benchmark"),
              attr("service.version", "0.1.0"),
            ],
          },
          scopeMetrics: [
            {
              scope: { name: "bench-generator", version: "0.1.0" },
              metrics,
            },
          ],
        },
      ],
    });
  }

  return requests;
}

/** Return a summary of what will be generated */
export function describeWorkload(config: BenchConfig) {
  const totalSamples = config.seriesCount * config.samplesPerSeries;
  const metricTypes = 5;
  const totalDataPoints = totalSamples * metricTypes;
  const timeRangeSec = config.samplesPerSeries * config.sampleIntervalSec;
  return {
    seriesCount: config.seriesCount,
    samplesPerSeries: config.samplesPerSeries,
    metricTypes,
    totalDataPoints,
    timeRangeMinutes: timeRangeSec / 60,
    estimatedRequests: Math.ceil(config.samplesPerSeries / config.batchSize),
  };
}
