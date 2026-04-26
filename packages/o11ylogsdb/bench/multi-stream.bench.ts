/**
 * multi-stream — sustained-ingest at scale across many streams.
 *
 * Sustained-ingest (Experiment Y) tested 1 stream × 500K records.
 * Real production ingest is 10s-100s of streams (one per service
 * instance) interleaved into the same engine. This bench measures
 * what happens when the engine sees 100 streams × 5K records each.
 *
 * Three configurations tested per corpus:
 *
 *  - few_long:  10 streams × 50K records each = 500K total
 *  - mid:       50 streams × 10K records each = 500K total
 *  - many_short: 100 streams × 5K records each = 500K total
 *
 * Records are interleaved round-robin across streams (the natural
 * shape from an OTLP-batch source that exporters from many services).
 *
 * Reports per (corpus, config):
 *   - throughput (rec/s)
 *   - total chunk bytes / log
 *   - chunk count
 *   - peak heap, peak arrayBuffers, peak rss
 *   - drain template count (validates per-stream Drain isolation)
 *
 * The PLAN's per-stream-chunking claim (Experiment E) said this
 * shape produces 1.13-1.28× compression vs cross-stream interleaved.
 * That was at 2K-sample scale; this bench validates at 500K records.
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
import { type Corpus, loadAllAvailable } from "./corpora.js";

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };
const TARGET_TOTAL = 500_000;

interface ConfigShape {
  name: string;
  numStreams: number;
  recordsPerStream: number;
}

const CONFIGS: ConfigShape[] = [
  { name: "1_stream", numStreams: 1, recordsPerStream: TARGET_TOTAL },
  { name: "10_streams", numStreams: 10, recordsPerStream: TARGET_TOTAL / 10 },
  { name: "50_streams", numStreams: 50, recordsPerStream: TARGET_TOTAL / 50 },
  { name: "100_streams", numStreams: 100, recordsPerStream: TARGET_TOTAL / 100 },
];

function buildResources(corpusName: string, n: number): Resource[] {
  // Each stream gets its own service.instance.id but shares
  // service.name (the "n instances of one service" shape).
  const out: Resource[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      attributes: [
        { key: "service.name", value: corpusName.toLowerCase() },
        { key: "service.instance.id", value: `${corpusName.toLowerCase()}-${i}` },
      ],
    };
  }
  return out;
}

interface RunResult {
  corpus: string;
  config: string;
  numStreams: number;
  recordsPerStream: number;
  totalRecords: number;
  totalChunks: number;
  totalChunkBytes: number;
  bytesPerLog: number;
  durationMs: number;
  throughput: number;
  drainTemplateCount: number;
  peakHeapBytes: number;
  peakArrayBuffersBytes: number;
  peakRssBytes: number;
  finalRssBytes: number;
  postGcHeapBytes: number;
}

function tryGc(): void {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

function snapshotMem(): { heapUsed: number; arrayBuffers: number; rss: number } {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers, rss: m.rss };
}

function runOne(corpus: Corpus, config: ConfigShape): RunResult {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const lineCount = lines.length;
  if (lineCount === 0) throw new Error(`empty corpus ${corpus.name}`);

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
  const resources = buildResources(corpus.name, config.numStreams);

  let peakHeap = 0;
  let peakArrayBuffers = 0;
  let peakRss = 0;

  tryGc();
  const t0 = performance.now();
  // Round-robin interleave: record idx i goes to stream (i % numStreams).
  // recordsPerStream is the same for all streams so the total is exact.
  const totalRecords = config.numStreams * config.recordsPerStream;
  for (let i = 0; i < totalRecords; i++) {
    const streamIdx = i % config.numStreams;
    const recordInStream = Math.floor(i / config.numStreams);
    const line = lines[recordInStream % lineCount] as string;
    const record: LogRecord = {
      timeUnixNano: BigInt(i) * 1_000_000_000n,
      severityNumber: 9,
      severityText: "INFO",
      body: line,
      attributes: [],
    };
    store.append(resources[streamIdx] as Resource, SCOPE, record);

    if ((i + 1) % 25_000 === 0) {
      const m = snapshotMem();
      if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
      if (m.arrayBuffers > peakArrayBuffers) peakArrayBuffers = m.arrayBuffers;
      if (m.rss > peakRss) peakRss = m.rss;
    }
  }
  store.flush();
  const t1 = performance.now();
  const durationMs = t1 - t0;

  const finalSnap = snapshotMem();
  if (finalSnap.heapUsed > peakHeap) peakHeap = finalSnap.heapUsed;
  if (finalSnap.arrayBuffers > peakArrayBuffers) peakArrayBuffers = finalSnap.arrayBuffers;
  if (finalSnap.rss > peakRss) peakRss = finalSnap.rss;

  tryGc();
  const postGcSnap = snapshotMem();
  const stats = store.stats();

  process.stderr.write(
    `  ${corpus.name.padEnd(11)} ${config.name.padEnd(13)} ` +
      `${totalRecords.toLocaleString().padStart(8)} rec  ` +
      `${(totalRecords / (durationMs / 1000)).toFixed(0).padStart(7)} rec/s  ` +
      `${stats.chunks.toString().padStart(4)} chunks  ` +
      `${(stats.totalChunkBytes / totalRecords).toFixed(2).padStart(6)} B/log  ` +
      `templates=${policy.drain.templateCount().toString().padStart(3)}  ` +
      `peakRss=${(peakRss / 1_000_000).toFixed(0).padStart(4)}MB  ` +
      `liveHeap=${(postGcSnap.heapUsed / 1_000_000).toFixed(1).padStart(5)}MB\n`
  );

  return {
    corpus: corpus.name,
    config: config.name,
    numStreams: config.numStreams,
    recordsPerStream: config.recordsPerStream,
    totalRecords,
    totalChunks: stats.chunks,
    totalChunkBytes: stats.totalChunkBytes,
    bytesPerLog: stats.totalChunkBytes / totalRecords,
    durationMs,
    throughput: totalRecords / (durationMs / 1000),
    drainTemplateCount: policy.drain.templateCount(),
    peakHeapBytes: peakHeap,
    peakArrayBuffersBytes: peakArrayBuffers,
    peakRssBytes: peakRss,
    finalRssBytes: finalSnap.rss,
    postGcHeapBytes: postGcSnap.heapUsed,
  };
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  const targets = ["Apache", "OpenStack"]
    .map((n) => corpora.find((c) => c.name === n))
    .filter((c): c is Corpus => !!c);
  const results: RunResult[] = [];
  for (const corpus of targets) {
    for (const config of CONFIGS) {
      results.push(runOne(corpus, config));
    }
  }
  return {
    module: "multi-stream",
    timestamp: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? null,
    node: process.version,
    results,
  };
}
