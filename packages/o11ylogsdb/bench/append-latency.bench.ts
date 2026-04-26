/**
 * append-latency — measures the per-call latency distribution of
 * LogStore.append() under sustained ingest.
 *
 * Sustained-ingest (Y) and multi-stream (AA) measure aggregate
 * throughput. Neither answers "what's the worst-case latency of a
 * single append() call?" In production this matters: the engine
 * stalls the caller for the duration of any chunk-close work
 * (Drain final-template-snapshot pass, ZSTD encode, sidecar
 * NDJSON build). At rowsPerChunk=4096, 1-in-4096 calls is fat.
 *
 * Method:
 *   - Ingest 100K records into one store
 *   - Time every individual append() call via process.hrtime.bigint()
 *   - Bucket the 100K samples into a fast histogram
 *   - Report:
 *     * percentiles (p50, p90, p99, p99.9, max)
 *     * tail count (how many calls > 100 µs, > 1 ms, > 10 ms)
 *     * total chunk-close events (= records / rowsPerChunk)
 *     * mean cost of "fast" calls (record-append) vs "slow" calls
 *       (chunk-close)
 *
 * Three policies tested at z3 + z19:
 *   - DefaultChunkPolicy (NDJSON, baseline)
 *   - ColumnarDrainPolicy (binary, no typing)
 *   - TypedColumnarDrainPolicy (M4 production)
 *
 * Surfaces whether the M4 codec has worse fat-tail latency than the
 * simpler policies — important because M5 hot ingest must avoid
 * 100ms-class stalls.
 */

import { performance } from "node:perf_hooks";
import {
  ColumnarDrainPolicy,
  DefaultChunkPolicy,
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  type LogRecord,
  LogStore,
  type Resource,
  TypedColumnarDrainPolicy,
  ZstdCodec,
} from "../dist/index.js";
import { type Corpus, loadAllAvailable } from "./corpora.js";

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };
const TARGET_RECORDS = 100_000;
const ROWS_PER_CHUNK = 4096;

interface Variant {
  name: string;
  bodyCodec: string;
  build: () => DefaultChunkPolicy | ColumnarDrainPolicy | TypedColumnarDrainPolicy;
}

const VARIANTS: Variant[] = [
  { name: "default_z3", bodyCodec: "zstd-3", build: () => new DefaultChunkPolicy("zstd-3") },
  { name: "default_z19", bodyCodec: "zstd-19", build: () => new DefaultChunkPolicy("zstd-19") },
  {
    name: "columnar_drain_z3",
    bodyCodec: "zstd-3",
    build: () => new ColumnarDrainPolicy({ bodyCodec: "zstd-3" }),
  },
  {
    name: "columnar_drain_z19",
    bodyCodec: "zstd-19",
    build: () => new ColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
  },
  {
    name: "typed_columnar_z3",
    bodyCodec: "zstd-3",
    build: () => new TypedColumnarDrainPolicy({ bodyCodec: "zstd-3" }),
  },
  {
    name: "typed_columnar_z19",
    bodyCodec: "zstd-19",
    build: () => new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
  },
];

function buildResource(name: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: name.toLowerCase() },
      { key: "service.instance.id", value: `${name.toLowerCase()}-0` },
    ],
  };
}

interface RunResult {
  corpus: string;
  variant: string;
  bodyCodec: string;
  totalCalls: number;
  totalDurationMs: number;
  /** Mean latency over all calls. */
  meanNs: number;
  /** Percentiles in nanoseconds. */
  p50Ns: number;
  p90Ns: number;
  p99Ns: number;
  p999Ns: number;
  maxNs: number;
  /** Tail counts. */
  callsOver100us: number;
  callsOver1ms: number;
  callsOver10ms: number;
  /** Expected chunk-close events (= records / rowsPerChunk, rounded). */
  expectedChunkCloses: number;
  /** Estimated mean "fast call" (excluding the slowest N where N=expectedChunkCloses). */
  meanFastCallNs: number;
  /** Mean "slow call" (the slowest N). */
  meanSlowCallNs: number;
}

function tryGc(): void {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

function runOne(corpus: Corpus, variant: Variant): RunResult {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const lineCount = lines.length;

  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: variant.build(),
    rowsPerChunk: ROWS_PER_CHUNK,
  });
  const resource = buildResource(corpus.name);

  // Pre-build all records so the timing only captures append().
  const records: LogRecord[] = new Array(TARGET_RECORDS);
  for (let i = 0; i < TARGET_RECORDS; i++) {
    records[i] = {
      timeUnixNano: BigInt(i) * 1_000_000_000n,
      severityNumber: 9,
      severityText: "INFO",
      body: lines[i % lineCount] as string,
      attributes: [],
    };
  }

  // Warmup so V8 hits steady-state code (don't include in distribution).
  for (let i = 0; i < 1000; i++) {
    store.append(resource, SCOPE, records[i] as LogRecord);
  }

  tryGc();

  // Per-call latencies in nanoseconds. BigInt → Number after subtraction
  // to avoid the BigInt-everywhere cost.
  const latencies = new Float64Array(TARGET_RECORDS);
  const wallStart = performance.now();
  for (let i = 0; i < TARGET_RECORDS; i++) {
    const t0 = process.hrtime.bigint();
    store.append(resource, SCOPE, records[i] as LogRecord);
    const t1 = process.hrtime.bigint();
    latencies[i] = Number(t1 - t0);
  }
  const wallMs = performance.now() - wallStart;
  store.flush();

  // Sort for percentiles. This is O(n log n) on 100K floats — a few
  // ms; not part of the critical path.
  const sorted = Float64Array.from(latencies).sort();
  const pct = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;

  let sum = 0;
  let over100us = 0;
  let over1ms = 0;
  let over10ms = 0;
  for (const ns of latencies) {
    sum += ns;
    if (ns > 100_000) over100us++;
    if (ns > 1_000_000) over1ms++;
    if (ns > 10_000_000) over10ms++;
  }
  const mean = sum / latencies.length;

  // Estimate fast vs slow split: assume the slowest N calls are
  // chunk-closes, where N = floor(records/rowsPerChunk). Mean of
  // those = mean slow call. Mean of the rest = mean fast call.
  const expectedSlow = Math.floor(TARGET_RECORDS / ROWS_PER_CHUNK);
  let slowSum = 0;
  let fastSum = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i >= sorted.length - expectedSlow) {
      slowSum += sorted[i] as number;
    } else {
      fastSum += sorted[i] as number;
    }
  }
  const meanSlow = expectedSlow > 0 ? slowSum / expectedSlow : 0;
  const meanFast = fastSum / (sorted.length - expectedSlow);

  process.stderr.write(
    `  ${corpus.name.padEnd(11)} ${variant.name.padEnd(20)} ` +
      `total=${wallMs.toFixed(0).padStart(5)}ms  ` +
      `p50=${(pct(50) / 1000).toFixed(1).padStart(5)}µs  ` +
      `p99=${(pct(99) / 1000).toFixed(1).padStart(6)}µs  ` +
      `p999=${(pct(99.9) / 1000).toFixed(1).padStart(7)}µs  ` +
      `max=${(pct(100) / 1_000_000).toFixed(2).padStart(6)}ms  ` +
      `>1ms=${over1ms}  >10ms=${over10ms}\n`
  );

  return {
    corpus: corpus.name,
    variant: variant.name,
    bodyCodec: variant.bodyCodec,
    totalCalls: TARGET_RECORDS,
    totalDurationMs: wallMs,
    meanNs: mean,
    p50Ns: pct(50),
    p90Ns: pct(90),
    p99Ns: pct(99),
    p999Ns: pct(99.9),
    maxNs: pct(100),
    callsOver100us: over100us,
    callsOver1ms: over1ms,
    callsOver10ms: over10ms,
    expectedChunkCloses: expectedSlow,
    meanFastCallNs: meanFast,
    meanSlowCallNs: meanSlow,
  };
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  const targets = ["Apache", "OpenStack"]
    .map((n) => corpora.find((c) => c.name === n))
    .filter((c): c is Corpus => !!c);
  const results: RunResult[] = [];
  for (const corpus of targets) {
    for (const variant of VARIANTS) {
      results.push(runOne(corpus, variant));
    }
  }
  return {
    module: "append-latency",
    timestamp: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? null,
    node: process.version,
    results,
  };
}
