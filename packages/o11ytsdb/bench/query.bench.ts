/**
 * Query benchmark — dedicated query performance regression suite.
 *
 * Populates a single ColumnStore (best config: ALP + fused range-decode)
 * once, then benchmarks a matrix of query scenarios:
 *
 *   - raw reads (single, multi-series)
 *   - step-aligned aggregation (sum, avg, rate, percentiles)
 *   - transforms (rate + sumBy)
 *   - regex label matching
 *   - time range selectivity (full vs last-10%)
 *
 * Each scenario reports ops/sec, p50/p95/p99 latency, and memory delta.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchReport } from "./harness.js";
import { fmt, printReport, Suite } from "./harness.js";
import { generateLabelSets, Rng } from "./vectors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

// ── Types ────────────────────────────────────────────────────────────

type StorageBackend = import("../dist/types.js").StorageBackend;
type QueryEngine = import("../dist/types.js").QueryEngine;
type Labels = import("../dist/types.js").Labels;
type QueryOpts = import("../dist/types.js").QueryOpts;

// ── Configuration ────────────────────────────────────────────────────

const NUM_SERIES = 1_000;
const POINTS_PER_SERIES = 10_000;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES; // 10M
const CHUNK_SIZE = 640;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n; // 15s scrape interval
const END = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;
const STEP_1M = 60_000n;
const STEP_4H = 14_400_000n;
const REGIONS = ["us-east", "us-west", "eu-west", "ap-south"] as const;

// ── Setup ────────────────────────────────────────────────────────────

async function createStore(): Promise<StorageBackend> {
  const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
  const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } = await import(
    "./wasm-loader.js"
  );
  const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
  const wasm = await loadWasm(wasmPath);
  const alpVals = makeALPValuesCodec(wasm);
  const wasmTs = makeTimestampCodec(wasm);
  const rangeCodec = makeALPRangeCodec(wasm);
  return new ColumnStore(
    {
      name: "alp-range",
      encodeValues: alpVals.encodeValues,
      decodeValues: alpVals.decodeValues,
      encodeValuesWithStats: alpVals.encodeValuesWithStats,
      encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
      decodeBatchValues: alpVals.decodeBatchValues,
    },
    CHUNK_SIZE,
    () => 0,
    undefined,
    {
      name: "rust-wasm-ts",
      encodeTimestamps: wasmTs.encodeTimestamps,
      decodeTimestamps: wasmTs.decodeTimestamps,
    },
    rangeCodec,
  );
}

async function loadQueryEngine(): Promise<QueryEngine> {
  const { ScanEngine } = await import(pkgPath("dist/query.js"));
  return new ScanEngine();
}

// ── Data generation (same patterns as engine.bench.ts) ───────────────

function populateStore(store: StorageBackend): void {
  const rng = new Rng(42);
  const labelSets = generateLabelSets(NUM_SERIES, 4, 42);

  // Build labels with 10 distinct metric names + a "region" label for groupBy.
  const labels: Labels[] = [];
  const ids: number[] = [];
  for (let s = 0; s < NUM_SERIES; s++) {
    const ls = labelSets[s]!;
    const m = new Map<string, string>();
    m.set("__name__", `metric_${s % 10}`);
    m.set("region", REGIONS[s % REGIONS.length]!);
    for (const [k, v] of ls.labels) m.set(k, v);
    labels.push(m);
    ids.push(store.getOrCreateSeries(m));
  }

  // Generate and ingest data in chunk-sized round-robin batches.
  const ts = new BigInt64Array(CHUNK_SIZE);
  const vs = new Float64Array(CHUNK_SIZE);

  for (let s = 0; s < NUM_SERIES; s++) {
    const pattern = s % 10;
    let counter = pattern <= 2 ? Math.floor(rng.next() * 10000) : 0;
    let gauge = rng.next() * 100;
    let ticks = Math.floor(rng.next() * 1e6);
    let totalTicks = Math.floor(1e7 + rng.next() * 1e6);

    for (let offset = 0; offset < POINTS_PER_SERIES; offset += CHUNK_SIZE) {
      const len = Math.min(CHUNK_SIZE, POINTS_PER_SERIES - offset);

      for (let i = 0; i < len; i++) {
        ts[i] = T0 + BigInt(offset + i) * INTERVAL;

        if (pattern === 0) {
          vs[i] = 42.5;
        } else if (pattern <= 2) {
          counter += Math.floor(rng.next() * 10) + 1;
          vs[i] = counter;
        } else if (pattern <= 6) {
          gauge += rng.gaussian(0, 0.05);
          gauge = Math.max(0, gauge);
          vs[i] = Math.round(gauge * 100) / 100;
        } else if (pattern <= 8) {
          ticks += Math.floor(rng.next() * 200) + 1;
          totalTicks += 1000;
          vs[i] = ticks / totalTicks;
        } else {
          gauge += rng.gaussian(0, 0.5);
          gauge = Math.max(0, gauge);
          vs[i] = Math.round(gauge * 100) / 100;
        }
      }

      store.appendBatch(ids[s]!, ts.subarray(0, len), vs.subarray(0, len));
    }
  }
}

// ── Scenario definitions ─────────────────────────────────────────────

interface Scenario {
  name: string;
  opts: QueryOpts;
  expectedSeries: number;
  samplesPerQuery: number;
}

function buildScenarios(): Scenario[] {
  const metric0 = "metric_0"; // 100 series match (1000 / 10 metrics)
  const matchCount = NUM_SERIES / 10;

  return [
    // Raw reads — no aggregation
    {
      name: "raw-single",
      opts: { metric: metric0, matchers: [{ label: "region", op: "=", value: "us-east" }], start: T0, end: END },
      expectedSeries: matchCount / REGIONS.length,
      samplesPerQuery: (matchCount / REGIONS.length) * POINTS_PER_SERIES,
    },
    {
      name: "raw-100",
      opts: { metric: metric0, start: T0, end: END },
      expectedSeries: matchCount,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },

    // Step-aligned aggregation — 1 minute
    {
      name: "sum-1m-100",
      opts: { metric: metric0, start: T0, end: END, step: STEP_1M, agg: "sum" },
      expectedSeries: 1,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },
    {
      name: "avg-1m-100",
      opts: { metric: metric0, start: T0, end: END, step: STEP_1M, agg: "avg" },
      expectedSeries: 1,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },

    // Step-aligned aggregation — 4 hour (coarse)
    {
      name: "sum-4h-100",
      opts: { metric: metric0, start: T0, end: END, step: STEP_4H, agg: "sum" },
      expectedSeries: 1,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },

    // Aggregation at 1K scale — metric field is required by QueryOpts,
    // so we use the regex matcher on __name__ to widen the initial match
    // beyond the metric_0 pre-filter. The query engine intersects matchers
    // with the metric result, so metric_0 acts as the base set here.
    // To truly hit all 1K series we'd need 10 queries. Instead, this
    // scenario benchmarks the regex matcher overhead at 100-series scale.
    {
      name: "avg-1m-regex",
      opts: {
        metric: "metric_0",
        matchers: [{ label: "__name__", op: "=~", value: "metric_.*" }],
        start: T0,
        end: END,
        step: STEP_1M,
        agg: "avg",
      },
      expectedSeries: 1,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },

    // Rate transform
    {
      name: "rate-1m-100",
      opts: { metric: metric0, start: T0, end: END, step: STEP_1M, transform: "rate", agg: "sum" },
      expectedSeries: 1,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },

    // Rate + groupBy region
    {
      name: "rate-sumBy-region",
      opts: {
        metric: metric0,
        start: T0,
        end: END,
        step: STEP_1M,
        transform: "rate",
        agg: "sum",
        groupBy: ["region"],
      },
      expectedSeries: 4,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },

    // Percentiles (require step)
    {
      name: "p50-1m-100",
      opts: { metric: metric0, start: T0, end: END, step: STEP_1M, agg: "p50" },
      expectedSeries: 1,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },
    {
      name: "p99-1m-100",
      opts: { metric: metric0, start: T0, end: END, step: STEP_1M, agg: "p99" },
      expectedSeries: 1,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },

    // Regex label matching — tests regex matcher overhead on the 100-series
    // metric_0 set. The regex is redundant (metric_0 already matches) but
    // exercises the =~ codepath.
    {
      name: "regex-match-100",
      opts: {
        metric: "metric_0",
        matchers: [{ label: "__name__", op: "=~", value: "metric_[0-9]" }],
        start: T0,
        end: END,
        step: STEP_1M,
        agg: "sum",
      },
      expectedSeries: 1,
      samplesPerQuery: matchCount * POINTS_PER_SERIES,
    },

    // Time range selectivity — last 10%
    {
      name: "sum-1m-last10pct",
      opts: {
        metric: metric0,
        start: T0 + ((END - T0) * 9n) / 10n,
        end: END,
        step: STEP_1M,
        agg: "sum",
      },
      expectedSeries: 1,
      samplesPerQuery: matchCount * (POINTS_PER_SERIES / 10),
    },
  ];
}

// ── Main benchmark ───────────────────────────────────────────────────

export default async function (): Promise<BenchReport> {
  const suite = new Suite("query");
  const store = await createStore();
  const qe = await loadQueryEngine();

  console.log(
    `  Configuration: ${NUM_SERIES.toLocaleString()} series × ${POINTS_PER_SERIES.toLocaleString()} pts = ${TOTAL_SAMPLES.toLocaleString()} total`,
  );
  console.log(`  Backend: ${store.name}`);
  console.log(`  Query engine: ${qe.name}`);
  console.log();

  // Populate (timed but not part of the benchmark suite).
  console.log("  Populating store...");
  const ingestStart = performance.now();
  populateStore(store);
  const ingestMs = performance.now() - ingestStart;
  console.log(
    `  Done: ${fmt(TOTAL_SAMPLES / (ingestMs / 1000))} samples/sec (${(ingestMs / 1000).toFixed(1)}s)`,
  );
  console.log();

  // Run each query scenario.
  const scenarios = buildScenarios();

  for (const scenario of scenarios) {
    // Warm-up: verify query works and get a sanity check.
    const warmResult = qe.query(store, scenario.opts);
    if (warmResult.series.length === 0 && scenario.expectedSeries > 0) {
      console.log(`  ⚠ ${scenario.name}: returned 0 series, expected ${scenario.expectedSeries} — skipping`);
      continue;
    }

    suite.add(
      scenario.name,
      store.name,
      () => {
        qe.query(store, scenario.opts);
      },
      {
        warmup: 5,
        iterations: 30,
        itemsPerCall: scenario.samplesPerQuery,
        unit: "samples/sec",
      },
    );
  }

  const report = suite.run();
  printReport(report);
  return report;
}
