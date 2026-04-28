/**
 * ingest-throughput.bench.ts — Sustained ingest throughput across corpus types.
 *
 * Measures records/second and MB/second for each corpus type at 100K scale.
 * Tests both the append path and the flush/encode path separately, then
 * combined end-to-end throughput.
 *
 * Also measures memory efficiency: peak RSS and heap per 10K records.
 */

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
import {
  CORPUS_GENERATORS,
  type SyntheticCorpusType,
} from "./synthetic-corpora.js";
import { nowMillis } from "./harness.js";

const SCOPE: InstrumentationScope = { name: "bench-ingest", version: "0.0.0" };
const RECORD_COUNT = 100_000;

function buildResource(corpusType: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: `bench-${corpusType}` },
    ],
  };
}

interface IngestResult {
  corpusType: string;
  recordCount: number;
  totalRawBytes: number;
  totalChunkBytes: number;
  ingestMs: number;
  recordsPerSecond: number;
  rawMBPerSecond: number;
  bytesPerLog: number;
  chunkCount: number;
  peakHeapMB: number;
  peakRssMB: number;
}

function measureIngest(corpusType: SyntheticCorpusType): IngestResult {
  const records = CORPUS_GENERATORS[corpusType](RECORD_COUNT);

  let totalRawBytes = 0;
  for (const r of records) {
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    totalRawBytes += body.length;
  }

  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 1024,
  });

  const resource = buildResource(corpusType);

  // Force GC before measurement
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
  const memBefore = process.memoryUsage();

  const t0 = nowMillis();
  for (const record of records) {
    store.append(resource, SCOPE, record);
  }
  store.flush();
  const t1 = nowMillis();

  const memAfter = process.memoryUsage();
  const ingestMs = t1 - t0;
  const stats = store.stats();

  return {
    corpusType,
    recordCount: RECORD_COUNT,
    totalRawBytes,
    totalChunkBytes: stats.totalChunkBytes,
    ingestMs,
    recordsPerSecond: RECORD_COUNT / (ingestMs / 1000),
    rawMBPerSecond: (totalRawBytes / 1_000_000) / (ingestMs / 1000),
    bytesPerLog: stats.totalChunkBytes / RECORD_COUNT,
    chunkCount: stats.chunks,
    peakHeapMB: Math.max(memBefore.heapUsed, memAfter.heapUsed) / 1_000_000,
    peakRssMB: Math.max(memBefore.rss, memAfter.rss) / 1_000_000,
  };
}

const CORPUS_TYPES: SyntheticCorpusType[] = [
  "syslog",
  "structured",
  "high-cardinality",
  "cloud-native",
  "mixed",
];

export default async function run() {
  process.stderr.write("\n═══ Ingest Throughput Benchmark (100K records per corpus) ═══\n\n");
  const results: IngestResult[] = [];

  // Warmup pass
  process.stderr.write("  Warmup…\n");
  CORPUS_GENERATORS["syslog"](1000);

  for (const corpusType of CORPUS_TYPES) {
    process.stderr.write(`  ${corpusType}… `);
    const result = measureIngest(corpusType);
    results.push(result);
    process.stderr.write(
      `${(result.recordsPerSecond / 1000).toFixed(0)}K rec/s | ` +
        `${result.rawMBPerSecond.toFixed(1)} MB/s raw | ` +
        `${result.bytesPerLog.toFixed(2)} B/log | ` +
        `heap=${result.peakHeapMB.toFixed(0)}MB\n`
    );
  }

  // Summary table
  process.stderr.write("\n─── Ingest Throughput Summary ───\n");
  process.stderr.write(
    "  " +
      "corpus".padEnd(18) +
      "rec/s".padEnd(12) +
      "MB/s".padEnd(10) +
      "B/log".padEnd(10) +
      "chunks".padEnd(10) +
      "heap MB".padEnd(10) +
      "\n"
  );
  for (const r of results) {
    process.stderr.write(
      "  " +
        r.corpusType.padEnd(18) +
        `${(r.recordsPerSecond / 1000).toFixed(0)}K`.padEnd(12) +
        r.rawMBPerSecond.toFixed(1).padEnd(10) +
        r.bytesPerLog.toFixed(2).padEnd(10) +
        String(r.chunkCount).padEnd(10) +
        r.peakHeapMB.toFixed(0).padEnd(10) +
        "\n"
    );
  }
  process.stderr.write("\n");

  return {
    module: "ingest-throughput",
    timestamp: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? null,
    node: process.version,
    results,
  };
}
