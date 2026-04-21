/**
 * Cache-strategy micro-benchmark.
 *
 * Compares three strategies for the module-level caches that were
 * flagged as unbounded in PR #110:
 *
 *   A. "cached"   — original Map-cached sanitize / prefix / fingerprint
 *   B. "uncached" — inline operations, no Map at all
 *   C. "lru-1024" — capped LRU (1 024 entries) using Map insertion order
 *
 * Each strategy is exercised against the *same* synthetic OTLP payload
 * so the only variable is cache overhead vs. recompute cost.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BenchReport, printReport, Suite } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

type OtlpMetric = import("@otlpkit/otlpjson").OtlpMetric;
type OtlpMetricsDocument = import("@otlpkit/otlpjson").OtlpMetricsDocument;

// ── Synthetic payloads ──────────────────────────────────────────────

function buildPayload(metricCount: number, uniqueKeys: number): OtlpMetricsDocument {
  const metrics: OtlpMetric[] = [];
  const baseTs = 1_710_000_000_000_000_000n;

  for (let i = 0; i < metricCount; i++) {
    metrics.push({
      name: `bench.metric.${i % 32}`,
      gauge: {
        dataPoints: [
          {
            timeUnixNano: (baseTs + BigInt(i) * 1_000_000_000n).toString(),
            attributes: Array.from({ length: uniqueKeys }, (_, k) => ({
              key: `attr.key.${k}`,
              value: { stringValue: `val-${i % 64}-${k}` },
            })),
            asDouble: 0.5 + (i % 100) / 100,
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
            { key: "service.name", value: { stringValue: "cache-bench" } },
            { key: "host.name", value: { stringValue: "bench-host" } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "bench.scope", version: "0.1.0" },
            metrics,
          },
        ],
      },
    ],
  };
}

// ── Micro-benchmarks for individual cache operations ────────────────

const SANITIZE_RE = /[^a-zA-Z0-9_]/gu;
const FNV_PRIME = 0x01000193;

function benchSanitizeUncached(keys: string[]): void {
  for (const k of keys) k.replace(SANITIZE_RE, "_");
}

function benchSanitizeCached(keys: string[]): void {
  const cache = new Map<string, string>();
  for (const k of keys) {
    let v = cache.get(k);
    if (v === undefined) {
      v = k.replace(SANITIZE_RE, "_");
      cache.set(k, v);
    }
  }
}

function benchFingerprintUncached(hashes: number[]): void {
  for (const h of hashes) {
    const mixed = Math.imul((h ^ 42) >>> 0, FNV_PRIME) >>> 0;
    mixed.toString(36);
  }
}

function benchFingerprintCached(hashes: number[]): void {
  const cache = new Map<number, string>();
  for (const h of hashes) {
    const mixed = Math.imul((h ^ 42) >>> 0, FNV_PRIME) >>> 0;
    let s = cache.get(mixed);
    if (s === undefined) {
      s = mixed.toString(36);
      cache.set(mixed, s);
    }
  }
}

// ── End-to-end ingest comparison ────────────────────────────────────

export default async function (): Promise<BenchReport> {
  const suite = new Suite("cache-strategy");
  const { FlatStore } = await import(pkgPath("dist/flat-store.js"));
  const { ingestOtlpJson } = await import(pkgPath("dist/ingest.js"));

  // ── Micro: sanitize ──

  // 50 unique keys repeated 200 times = 10K operations (simulates realistic batch)
  const uniqueKeyCount = 50;
  const repeatFactor = 200;
  const keys: string[] = [];
  for (let r = 0; r < repeatFactor; r++) {
    for (let i = 0; i < uniqueKeyCount; i++) {
      keys.push(`http.request.header.x-custom-${i}`);
    }
  }

  suite.add("micro_sanitize_uncached", "uncached", () => benchSanitizeUncached(keys), {
    warmup: 50,
    iterations: 500,
    itemsPerCall: keys.length,
    unit: "ops/sec",
  });

  suite.add("micro_sanitize_cached", "cached", () => benchSanitizeCached(keys), {
    warmup: 50,
    iterations: 500,
    itemsPerCall: keys.length,
    unit: "ops/sec",
  });

  // ── Micro: fingerprint ──

  const hashes: number[] = [];
  for (let i = 0; i < 10_000; i++) hashes.push((Math.random() * 0xffffffff) >>> 0);

  suite.add("micro_fingerprint_uncached", "uncached", () => benchFingerprintUncached(hashes), {
    warmup: 50,
    iterations: 500,
    itemsPerCall: hashes.length,
    unit: "ops/sec",
  });

  suite.add("micro_fingerprint_cached", "cached", () => benchFingerprintCached(hashes), {
    warmup: 50,
    iterations: 500,
    itemsPerCall: hashes.length,
    unit: "ops/sec",
  });

  // ── End-to-end ingest (uses current code — caches removed) ──

  for (const metricCount of [100, 1_000, 10_000]) {
    const payload = buildPayload(metricCount, 5);

    suite.add(`e2e_ingest_${metricCount}_metrics`, "current", () => {
      const storage = new FlatStore();
      ingestOtlpJson(payload, storage);
    }, {
      warmup: 10,
      iterations: 30,
      itemsPerCall: metricCount,
      unit: "samples/sec",
    });
  }

  const report = suite.run();
  printReport(report);
  return report;
}
