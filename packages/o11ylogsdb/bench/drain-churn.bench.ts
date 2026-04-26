/**
 * drain-churn — measures Drain behaviour as new templates appear
 * over time, modeling production where each new build / error
 * pattern adds templates the parser hasn't seen before.
 *
 * All previous benches cycle a finite corpus, so Drain template
 * count plateaus immediately. Real production has a slow drift —
 * a new error message appears every few thousand records as code
 * paths get exercised, builds roll out, etc. This bench surfaces
 * any architectural risk in Drain's tree-growth behaviour or
 * matching cost as the template count grows.
 *
 * Synthesis: generate 100K records where every Nth record is a new
 * synthetic template (by injecting a unique token into a base
 * template). N is varied across configurations:
 *
 *   - 100k_records, 1 new template per 100 records  → 1000 templates
 *   - 100k_records, 1 new template per 1000 records →  100 templates
 *   - 100k_records, 1 new template per 10000        →   10 templates
 *
 * Reports per config:
 *   - Throughput (rec/s) — should stay flat if Drain scales
 *   - Drain template count over time (snapshots every 5K records)
 *   - Per-record append latency p50/p99/max — does it grow?
 *   - bytes/log on the produced chunks
 */

import { performance } from "node:perf_hooks";
import {
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  type LogRecord,
  LogStore,
  type Resource,
  TypedColumnarDrainPolicy,
  ZstdCodec,
} from "../dist/index.js";

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };
const TARGET_RECORDS = 100_000;
const SNAPSHOT_EVERY = 5_000;

interface Config {
  name: string;
  /** A new template is introduced every `period` records. */
  period: number;
}

const CONFIGS: Config[] = [
  { name: "no_churn", period: TARGET_RECORDS + 1 }, // 1 template, no growth
  { name: "1_per_10000", period: 10_000 }, // 10 templates total
  { name: "1_per_1000", period: 1_000 }, // 100 templates
  { name: "1_per_100", period: 100 }, // 1000 templates — adversarial
  { name: "1_per_10", period: 10 }, // 10000 templates — pathological
];

function buildResource(): Resource {
  return {
    attributes: [
      { key: "service.name", value: "drain-churn-bench" },
      { key: "service.instance.id", value: "instance-0" },
    ],
  };
}

/**
 * Synthesize a log line. The first 4 tokens are the per-template
 * fingerprint (Drain's fixed-depth tree branches on the first
 * `depth-1 = 3` tokens at the leaf, so we put four distinguishing
 * tokens up front to force separate Drain leaves per template).
 * The trailing tokens are per-record variables.
 *
 * Final line shape:
 *   "<tag1> <tag2> <tag3> <tag4> seq <n> latency_ms <ms>"
 *
 * Each template generates its own (tag1..tag4) tuple. Drain will
 * treat each as a distinct template if they differ in any of the
 * first three tokens.
 */
function makeLine(tag: readonly [string, string, string, string], seq: number): string {
  const latency = ((seq * 7) % 1000) / 10;
  return `${tag[0]} ${tag[1]} ${tag[2]} ${tag[3]} seq ${seq} latency_ms ${latency}`;
}

/**
 * Produce a (tag0, tag1, tag2, tag3) tuple unique per template idx.
 * Use simple words from a stable wordlist + a counter as suffix on
 * the last tag, so the first three tokens vary across templates and
 * Drain produces a separate leaf per template.
 */
const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
];

function templateTag(idx: number): readonly [string, string, string, string] {
  const w = WORDS.length;
  const a = WORDS[idx % w] as string;
  const b = WORDS[Math.floor(idx / w) % w] as string;
  const c = WORDS[Math.floor(idx / (w * w)) % w] as string;
  // Last tag is a deterministic word-pair so adjacent templates
  // differ in the last token at minimum.
  const d = `${WORDS[idx % 7] as string}-${WORDS[(idx >> 3) % 11] as string}`;
  return [a, b, c, d] as const;
}

interface RunResult {
  config: string;
  period: number;
  totalRecords: number;
  totalChunks: number;
  totalChunkBytes: number;
  bytesPerLog: number;
  durationMs: number;
  throughput: number;
  drainTemplateCount: number;
  /** Templates introduced (= records / period). */
  templatesIntroduced: number;
  /** Per-(append) latency stats. */
  meanAppendNs: number;
  p99AppendNs: number;
  maxAppendNs: number;
  /** Templates over time. */
  snapshots: { records: number; ms: number; templateCount: number }[];
}

function tryGc(): void {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

function runOne(config: Config): RunResult {
  const policy = new TypedColumnarDrainPolicy({ bodyCodec: "zstd-3" });
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy,
    rowsPerChunk: 4096,
  });
  const resource = buildResource();

  // Pre-build records so timing only captures append().
  const records: LogRecord[] = new Array(TARGET_RECORDS);
  for (let i = 0; i < TARGET_RECORDS; i++) {
    const tplIdx = Math.floor(i / config.period);
    const tag = templateTag(tplIdx);
    records[i] = {
      timeUnixNano: BigInt(i) * 1_000_000_000n,
      severityNumber: 9,
      severityText: "INFO",
      body: makeLine(tag, i),
      attributes: [],
    };
  }

  // Warmup with the first 1000 records (don't include in stats).
  // Use a separate store so we don't pollute the measurement.
  const warmupStore = new LogStore({
    registry: defaultRegistry().register(new ZstdCodec(3)).register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-3" }),
    rowsPerChunk: 4096,
  });
  for (let i = 0; i < 1000; i++) warmupStore.append(resource, SCOPE, records[i] as LogRecord);
  tryGc();

  const latencies = new Float64Array(TARGET_RECORDS);
  const snapshots: RunResult["snapshots"] = [];
  const wallStart = performance.now();
  for (let i = 0; i < TARGET_RECORDS; i++) {
    const t0 = process.hrtime.bigint();
    store.append(resource, SCOPE, records[i] as LogRecord);
    const t1 = process.hrtime.bigint();
    latencies[i] = Number(t1 - t0);
    if ((i + 1) % SNAPSHOT_EVERY === 0) {
      snapshots.push({
        records: i + 1,
        ms: performance.now() - wallStart,
        templateCount: policy.drain.templateCount(),
      });
    }
  }
  const wallMs = performance.now() - wallStart;
  store.flush();

  const sorted = Float64Array.from(latencies).sort();
  const pct = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
  let sum = 0;
  for (const ns of latencies) sum += ns;
  const mean = sum / latencies.length;

  const stats = store.stats();
  const result: RunResult = {
    config: config.name,
    period: config.period,
    totalRecords: TARGET_RECORDS,
    totalChunks: stats.chunks,
    totalChunkBytes: stats.totalChunkBytes,
    bytesPerLog: stats.totalChunkBytes / TARGET_RECORDS,
    durationMs: wallMs,
    throughput: TARGET_RECORDS / (wallMs / 1000),
    drainTemplateCount: policy.drain.templateCount(),
    templatesIntroduced: Math.ceil(TARGET_RECORDS / config.period),
    meanAppendNs: mean,
    p99AppendNs: pct(99),
    maxAppendNs: pct(100),
    snapshots,
  };

  process.stderr.write(
    `  ${config.name.padEnd(13)} ` +
      `period=${config.period.toString().padStart(5)} ` +
      `templates=${result.drainTemplateCount.toString().padStart(5)} ` +
      `${result.throughput.toFixed(0).padStart(7)} rec/s  ` +
      `B/log=${result.bytesPerLog.toFixed(2).padStart(5)}  ` +
      `appendP99=${(result.p99AppendNs / 1000).toFixed(1).padStart(5)}µs  ` +
      `appendMax=${(result.maxAppendNs / 1_000_000).toFixed(1).padStart(5)}ms\n`
  );
  // Time-series snapshot for the most adversarial configs.
  if (config.period <= 100) {
    process.stderr.write(`    records  ms     templates\n`);
    for (const s of result.snapshots) {
      process.stderr.write(
        `    ${s.records.toString().padStart(7)} ${s.ms.toFixed(0).padStart(6)} ${s.templateCount.toString().padStart(9)}\n`
      );
    }
  }
  return result;
}

export default async function run() {
  const results: RunResult[] = [];
  for (const config of CONFIGS) {
    results.push(runOne(config));
  }
  return {
    module: "drain-churn",
    timestamp: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? null,
    node: process.version,
    results,
  };
}
