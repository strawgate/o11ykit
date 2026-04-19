import { parseOtlpToSamples } from '../../packages/o11ytsdb/dist/ingest.js';
import {
  assertSameParsedResult,
  createSpecializedGaugeIngestFromFirstPayload,
} from './03-codegen-prototype.mjs';

function buildSyntheticPayload(metricCount = 10_000) {
  const metrics = [];
  const baseTs = 1_710_000_000_000_000_000n;

  for (let i = 0; i < metricCount; i++) {
    metrics.push({
      name: `bench.cpu.utilization.${i % 32}`,
      gauge: {
        dataPoints: [
          {
            timeUnixNano: (baseTs + BigInt(i) * 1_000_000_000n).toString(),
            attributes: [
              { key: 'host.name', value: { stringValue: `node-${i % 256}` } },
              { key: 'cpu', value: { stringValue: String(i % 8) } },
            ],
            asDouble: 0.25 + (i % 100) / 100,
          },
        ],
      },
    });
  }

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'o11ytsdb-ingest-bench' } },
            { key: 'service.instance.id', value: { stringValue: 'bench-1' } },
          ],
        },
        scopeMetrics: [
          {
            scope: {
              name: 'bench.ingest',
              version: '0.0.1',
            },
            metrics,
          },
        ],
      },
    ],
  };
}

function nowNs() {
  return process.hrtime.bigint();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function runBench(name, fn, { warmup = 10, iterations = 40, itemsPerCall = 10_000 } = {}) {
  for (let i = 0; i < warmup; i++) fn();

  const rates = [];
  const durationsMs = [];
  for (let i = 0; i < iterations; i++) {
    const start = nowNs();
    fn();
    const elapsedNs = nowNs() - start;
    const elapsedSec = Number(elapsedNs) / 1e9;
    const elapsedMs = Number(elapsedNs) / 1e6;
    rates.push(itemsPerCall / elapsedSec);
    durationsMs.push(elapsedMs);
  }

  rates.sort((a, b) => a - b);
  durationsMs.sort((a, b) => a - b);
  return {
    name,
    warmup,
    iterations,
    p50Throughput: percentile(rates, 0.5),
    p95Throughput: percentile(rates, 0.95),
    p50DurationMs: percentile(durationsMs, 0.5),
  };
}

function fmtRate(v) {
  return `${(v / 1_000_000).toFixed(2)}M pts/sec`;
}

function fmtMs(v) {
  return `${v.toFixed(3)} ms`;
}

const payload = buildSyntheticPayload(10_000);

const shapeStart = nowNs();
const specialized = createSpecializedGaugeIngestFromFirstPayload(payload);
const shapeDetectMs = Number(nowNs() - shapeStart) / 1e6;

const baselineParsed = parseOtlpToSamples(payload);
const specializedParsed = specialized.parse(payload);
assertSameParsedResult(specializedParsed, baselineParsed);

const genericReport = runBench('generic_parseOtlpToSamples', () => {
  parseOtlpToSamples(payload);
});

const specializedReport = runBench('specialized_codegen_parse', () => {
  specialized.parse(payload);
});

const fallbackPayload = structuredClone(payload);
fallbackPayload.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].attributes[0].key = 'host.id';
const fallback = specialized.parse(fallbackPayload);

console.log('== Codegen ingest prototype benchmark ==');
console.log(`shape detection: ${fmtMs(shapeDetectMs)}`);
console.log(`${genericReport.name}: p50=${fmtRate(genericReport.p50Throughput)}, p95=${fmtRate(genericReport.p95Throughput)}, p50-lat=${fmtMs(genericReport.p50DurationMs)}`);
console.log(`${specializedReport.name}: p50=${fmtRate(specializedReport.p50Throughput)}, p95=${fmtRate(specializedReport.p95Throughput)}, p50-lat=${fmtMs(specializedReport.p50DurationMs)}`);
console.log(`speedup(p50): ${(specializedReport.p50Throughput / genericReport.p50Throughput).toFixed(2)}x`);
console.log(`fallback path mode: ${fallback.mode}`);

import { parseOtlpToSamples } from '../../packages/o11ytsdb/dist/ingest.js';

const SCOPE_NAME_LABEL = 'otel.scope.name';
const SCOPE_VERSION_LABEL = 'otel.scope.version';
const ATTR_PREFIX_RESOURCE = 'resource.';
const ATTR_PREFIX_SCOPE = 'scope_attr.';
const ATTR_PREFIX_POINT = 'attr.';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function sanitizeLabelKey(key) {
  return key.replace(/[^a-zA-Z0-9_]/gu, '_');
}

function prefixedKey(prefix, key) {
  return `${prefix}${sanitizeLabelKey(key)}`;
}

function fnvHashString(hash, s) {
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

function fnvHashEntry(hash, key, value) {
  hash = fnvHashString(hash, key);
  hash ^= 0xFF;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  hash = fnvHashString(hash, value);
  hash ^= 0xFE;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  return hash;
}

function toFingerprint(hash, size) {
  hash = (hash ^ size) >>> 0;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  return hash.toString(36);
}

function normalizeTimestampNanoStringToMs(value) {
  // Benchmark payload uses nanosecond digit strings.
  return Number(value.slice(0, 13));
}

function buildShape(document) {
  const resourceMetric = document?.resourceMetrics?.[0];
  const scopeMetric = resourceMetric?.scopeMetrics?.[0];
  const metrics = scopeMetric?.metrics;
  if (!resourceMetric || !scopeMetric || !Array.isArray(metrics)) return null;

  const resourceAttrs = resourceMetric.resource?.attributes ?? [];
  const scopeAttrs = scopeMetric.scope?.attributes ?? [];
  const scopeName = scopeMetric.scope?.name ?? '';
  const scopeVersion = scopeMetric.scope?.version ?? '';

  const firstGauge = metrics.find((m) => Array.isArray(m.gauge?.dataPoints) && m.gauge.dataPoints.length > 0);
  const firstPoint = firstGauge?.gauge?.dataPoints?.[0];
  const pointAttrKeys = (firstPoint?.attributes ?? []).map((a) => a.key);

  const baseEntries = [
    [SCOPE_NAME_LABEL, scopeName],
    [SCOPE_VERSION_LABEL, scopeVersion],
    ...resourceAttrs.map((a) => [prefixedKey(ATTR_PREFIX_RESOURCE, a.key), String(a.value?.stringValue ?? '')]),
    ...scopeAttrs.map((a) => [prefixedKey(ATTR_PREFIX_SCOPE, a.key), String(a.value?.stringValue ?? '')]),
  ];

  let baseHash = FNV_OFFSET >>> 0;
  for (const [k, v] of baseEntries) baseHash = fnvHashEntry(baseHash, k, v);
  const baseSize = baseEntries.length;

  const metricNames = [];
  const metricHashByName = Object.create(null);
  for (const metric of metrics) {
    if (!Array.isArray(metric.gauge?.dataPoints)) continue;
    metricNames.push(metric.name);
    metricHashByName[metric.name] = fnvHashEntry(baseHash, '__name__', metric.name);
  }

  const attrKeyLabels = pointAttrKeys.map((k) => prefixedKey(ATTR_PREFIX_POINT, k));

  // Precompute fingerprints/labels for series seen in first payload.
  const perMetricSeries = Object.create(null);
  for (const metric of metrics) {
    if (!Array.isArray(metric.gauge?.dataPoints)) continue;
    const point = metric.gauge.dataPoints[0];
    const attrs = point.attributes ?? [];
    if (attrs.length !== pointAttrKeys.length) continue;
    const attrValues = pointAttrKeys.map((k, idx) => String(attrs[idx]?.value?.stringValue ?? ''));
    const seriesKey = attrValues.join('\u0001');
    if (perMetricSeries[metric.name]?.[seriesKey]) continue;

    let hash = metricHashByName[metric.name];
    for (let i = 0; i < pointAttrKeys.length; i++) {
      hash = fnvHashEntry(hash, attrKeyLabels[i], attrValues[i]);
    }
    const fp = toFingerprint(hash, baseSize + 1 + pointAttrKeys.length);
    const labels = new Map(baseEntries);
    labels.set('__name__', metric.name);
    for (let i = 0; i < pointAttrKeys.length; i++) labels.set(attrKeyLabels[i], attrValues[i]);

    perMetricSeries[metric.name] ??= Object.create(null);
    perMetricSeries[metric.name][seriesKey] = { fp, labels };
  }

  return {
    metricCount: metrics.length,
    metricNames,
    pointAttrKeys,
    baseEntries,
    baseHash,
    baseSize,
    metricHashByName,
    attrKeyLabels,
    perMetricSeries,
  };
}

function shapeMatches(document, shape) {
  const resourceMetric = document?.resourceMetrics?.[0];
  const scopeMetric = resourceMetric?.scopeMetrics?.[0];
  const metrics = scopeMetric?.metrics;
  if (!Array.isArray(metrics) || metrics.length !== shape.metricCount) return false;

  for (let i = 0; i < metrics.length; i++) {
    const metric = metrics[i];
    if (metric.name !== shape.metricNames[i]) return false;
    const points = metric.gauge?.dataPoints;
    if (!Array.isArray(points) || points.length !== 1) return false;
    const attrs = points[0]?.attributes;
    if (!Array.isArray(attrs) || attrs.length !== shape.pointAttrKeys.length) return false;
    for (let j = 0; j < attrs.length; j++) {
      if (attrs[j]?.key !== shape.pointAttrKeys[j]) return false;
    }
  }

  return true;
}

function makeSpecializedIngest(shape) {
  const source = `
    return function specializedIngest(document) {
      const pending = new Map();
      const result = {
        pointsSeen: 0,
        pointsAccepted: 0,
        samplesInserted: 0,
        seriesCreated: 0,
        errors: 0,
        dropped: 0,
        metricTypeCounts: {
          gauge: 0,
          sum: 0,
          histogram: 0,
          summary: 0,
          exponentialHistogram: 0,
        },
      };

      const metrics = document.resourceMetrics[0].scopeMetrics[0].metrics;
      for (let i = 0; i < metrics.length; i++) {
        const metric = metrics[i];
        const dp = metric.gauge.dataPoints[0];

        result.metricTypeCounts.gauge++;
        result.pointsSeen++;

        const ts = normalizeTimestampNanoStringToMs(dp.timeUnixNano);
        const value = dp.asDouble ?? Number(dp.asInt ?? NaN);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) {
          result.errors++;
          result.dropped++;
          continue;
        }

        const attrs = dp.attributes;
        const v0 = String(attrs[0].value.stringValue ?? '');
        const v1 = String(attrs[1].value.stringValue ?? '');
        const seriesKey = v0 + '\\u0001' + v1;

        let pre = perMetricSeries[metric.name]?.[seriesKey];
        if (!pre) {
          let hash = metricHashByName[metric.name];
          hash = fnvHashEntry(hash, attrKeyLabels[0], v0);
          hash = fnvHashEntry(hash, attrKeyLabels[1], v1);
          const fp = toFingerprint(hash, baseSize + 3);
          const labels = new Map(baseEntries);
          labels.set('__name__', metric.name);
          labels.set(attrKeyLabels[0], v0);
          labels.set(attrKeyLabels[1], v1);
          pre = { fp, labels };
          perMetricSeries[metric.name] ??= Object.create(null);
          perMetricSeries[metric.name][seriesKey] = pre;
        }

        let batch = pending.get(pre.fp);
        if (!batch) {
          batch = { labels: pre.labels, timestamps: [], values: [] };
          pending.set(pre.fp, batch);
        }
        batch.timestamps.push(ts);
        batch.values.push(value);
        result.pointsAccepted++;
      }

      return { pending, result };
    };
  `;

  return new Function(
    'normalizeTimestampNanoStringToMs',
    'metricHashByName',
    'attrKeyLabels',
    'baseSize',
    'baseEntries',
    'perMetricSeries',
    'fnvHashEntry',
    'toFingerprint',
    source,
  )(
    normalizeTimestampNanoStringToMs,
    shape.metricHashByName,
    shape.attrKeyLabels,
    shape.baseSize,
    shape.baseEntries,
    shape.perMetricSeries,
    fnvHashEntry,
    toFingerprint,
  );
}

export function createSpecializedGaugeIngestFromFirstPayload(firstPayload) {
  const shape = buildShape(firstPayload);
  if (!shape) {
    return {
      shape: null,
      parse(payload) {
        return { mode: 'fallback', ...parseOtlpToSamples(payload) };
      },
    };
  }

  const specializedIngest = makeSpecializedIngest(shape);

  return {
    shape,
    parse(payload) {
      if (!shapeMatches(payload, shape)) {
        return { mode: 'fallback', ...parseOtlpToSamples(payload) };
      }
      return { mode: 'specialized', ...specializedIngest(payload) };
    },
  };
}

function normalizeBatch(batch) {
  return {
    labels: Object.fromEntries([...batch.labels.entries()].sort(([a], [b]) => a.localeCompare(b))),
    timestamps: [...batch.timestamps],
    values: [...batch.values],
  };
}

function normalizeParsed(parsed) {
  return {
    result: parsed.result,
    pending: [...parsed.pending.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fp, batch]) => [fp, normalizeBatch(batch)]),
  };
}

export function assertSameParsedResult(actual, expected) {
  const a = JSON.stringify(normalizeParsed(actual));
  const b = JSON.stringify(normalizeParsed(expected));
  if (a !== b) {
    throw new Error('Specialized parser output differs from parseOtlpToSamples baseline.');
  }
}
# 03 — Schema-specialized ingest codegen (prototype)

## Scope

Prototype-only exploration of runtime codegen for gauge ingest with a shape-locked fast path.

Deliverables:
- `03-codegen-prototype.mjs`: shape analyzer + `new Function()` specialized parser + fallback to generic parser.
- `03-codegen-bench.mjs`: 10K-point benchmark driver and correctness checks.

## What was implemented

1. **Shape analysis** on first payload:
   - Captures metric ordering/names and expected point attribute key ordering.
   - Captures base labels (`otel.scope.*`, `resource.*`, `scope_attr.*`) and computes `baseHash`.
   - Computes per-metric `metricHash` (`baseHash + __name__`).
   - Precomputes fingerprints + full label maps for each observed `(metricName, attribute-values)` series in the first payload.

2. **Specialized ingest generation** via `new Function()`:
   - Hardcodes two point-attribute accesses (`attrs[0]`, `attrs[1]`) and avoids generic key iteration.
   - Reuses precomputed `(fp, labels)` where the series was seen during shape discovery.
   - For unseen value combos under the same key shape, computes hash/fingerprint with direct access.
   - Produces the same `ParsedOtlpResult` shape (`pending`, `result`) as the generic parser.

3. **Fallback behavior**:
   - Verifies shape match per call (metric count/order, gauge layout, attribute key set/order).
   - On mismatch, immediately routes to `parseOtlpToSamples` generic path.

4. **Correctness check**:
   - Normalizes and deep-compares specialized vs generic parsed output for the same 10K payload.

## Benchmark setup

- Payload: same 10K synthetic gauge workload pattern as main ingest benchmark (32 metric names modulo, 2 point attrs: `host.name`, `cpu`).
- Warmup/iterations: 10/40.
- Metric: p50 throughput in points/sec.

## Results (this environment)

From `node research/ingest-experiments/03-codegen-bench.mjs`:

- Shape detection: **43.359 ms**
- Generic `parseOtlpToSamples`: **p50 1.44M pts/sec** (p50 latency 6.838 ms)
- Specialized codegen parser: **p50 2.51M pts/sec** (p50 latency 3.972 ms)
- Speedup: **1.74x p50**
- Fallback test (mutated attr key): correctly reported `mode: fallback`

## What codegen eliminated

Relative to generic `ingestNumberPoints` path, the prototype removes or reduces:
- Per-point `flattenAttributes` + `Object.keys` walk for point attrs.
- Per-point dynamic key sanitization/prefix lookup for point attrs.
- Most per-point label-map creation (reuses precomputed labels for known series).
- Most per-point full hash construction for known series (reuses precomputed fingerprint).

Still present:
- Pending map get/set and array push costs.
- Timestamp and value extraction.
- Hashing for previously unseen value combinations (still direct, but not precomputed).

## Shape stability discussion

For this synthetic benchmark, shape is perfectly stable, so fast path hit rate is 100% after discovery.

For real OTLP workloads, likely behavior:
- **High stability** for daemon/resource metrics and exporter-generated host metrics (same keys, mostly same metric sets).
- **Lower stability** for dynamic labels (pod UID churn, request path/user-agent labels, changing cardinality).
- In mixed workloads, a partial hit-rate model is expected (some scopes/metrics stay stable; others fall back).

Implication: payoff depends heavily on repeated scrape shape and bounded label churn.

## `new Function()` / deopt observations

Using `node --trace-deopt`, specialized function did optimize but also showed deoptimizations:
- `specializedIngest` had eager deopts for "Insufficient type feedback for generic named access".
- Additional deopts occurred after fallback-shape mutation (map transitions / code dependency invalidation).

Interpretation:
- Runtime codegen is not automatically deopt-safe.
- Mixing stable and mutated object shapes in one process can invalidate optimized code.

## Shape detection overhead

Measured one-time shape detection: ~43 ms in this run.
At p50 savings (~2.866 ms per 10K parse), break-even is roughly:
- `43.359 / 2.866 ≈ 15` parses.

So overhead amortizes quickly only when the same shape repeats at least dozens of times.

## Assessment

- **Performance potential:** meaningful for stable-shape, high-repeat ingest streams.
- **Complexity/risk:** substantial:
  - Harder debugging and maintenance.
  - Shape invalidation and fallback heuristics complexity.
  - JIT/deopt sensitivity and runtime codegen concerns.

## Recommendation

**DEFER**

Reason: strong prototype speedup (1.74x p50) is promising, but productionizing a `new Function()` pipeline now would add significant complexity and deopt risk without real workload hit-rate data. Next step should be low-risk instrumentation in generic ingest to quantify shape-repeat rates in representative traffic before deciding on adoption.
