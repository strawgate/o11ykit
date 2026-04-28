/**
 * comprehensive-storage.bench.ts — Cross-corpus storage efficiency benchmark.
 *
 * Tests all synthetic corpus types (syslog, structured JSON, high-cardinality,
 * cloud-native, mixed) at multiple sizes through the full TypedColumnarDrainPolicy
 * engine stack. Reports B/log, compression ratio, and ingest throughput.
 *
 * This is the merge gate benchmark for storage efficiency across workloads.
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
  CORPUS_SIZES,
  type CorpusSize,
  type SyntheticCorpusType,
} from "./synthetic-corpora.js";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

const SCOPE: InstrumentationScope = { name: "bench-comprehensive", version: "0.0.0" };

function buildResource(corpusType: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: `bench-${corpusType}` },
      { key: "corpus.type", value: corpusType },
    ],
  };
}

interface BenchCase {
  corpusType: SyntheticCorpusType;
  size: CorpusSize;
}

// Run 10K for all types (fast), 100K for key types, skip 1M for CI speed
const CASES: BenchCase[] = [
  { corpusType: "syslog", size: "1k" },
  { corpusType: "syslog", size: "10k" },
  { corpusType: "syslog", size: "100k" },
  { corpusType: "structured", size: "1k" },
  { corpusType: "structured", size: "10k" },
  { corpusType: "structured", size: "100k" },
  { corpusType: "high-cardinality", size: "1k" },
  { corpusType: "high-cardinality", size: "10k" },
  { corpusType: "high-cardinality", size: "100k" },
  { corpusType: "cloud-native", size: "1k" },
  { corpusType: "cloud-native", size: "10k" },
  { corpusType: "cloud-native", size: "100k" },
  { corpusType: "mixed", size: "1k" },
  { corpusType: "mixed", size: "10k" },
  { corpusType: "mixed", size: "100k" },
];

function measureRawSize(records: LogRecord[]): number {
  // Raw NDJSON size: what you'd get without any compression
  // Custom replacer handles BigInt fields
  let total = 0;
  const replacer = (_k: string, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v;
  for (const r of records) {
    total += JSON.stringify(r, replacer).length + 1; // +1 for newline
  }
  return total;
}

function measureRawTextSize(records: LogRecord[]): number {
  let total = 0;
  for (const r of records) {
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    total += body.length + 1;
  }
  return total;
}

function runCase(c: BenchCase): CompressionResult {
  const count = CORPUS_SIZES[c.size];
  const generator = CORPUS_GENERATORS[c.corpusType];
  const label = `${c.corpusType}/${c.size}`;

  process.stderr.write(`  Generating ${label} (${count.toLocaleString()} records)… `);
  const t0 = nowMillis();
  const records = generator(count);
  const genMs = nowMillis() - t0;
  process.stderr.write(`${genMs.toFixed(0)}ms\n`);

  const rawNdjsonBytes = measureRawSize(records);
  const rawTextBytes = measureRawTextSize(records);

  // Ingest into LogStore with TypedColumnarDrainPolicy + ZSTD-19
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 1024,
  });

  const resource = buildResource(c.corpusType);
  const ingestStart = nowMillis();
  for (const record of records) {
    store.append(resource, SCOPE, record);
  }
  store.flush();
  const ingestMs = nowMillis() - ingestStart;

  const stats = store.stats();
  const outputBytes = stats.totalChunkBytes;
  const bpl = bytesPerLog(outputBytes, count);
  const rvr = ratioFn(rawTextBytes, outputBytes);
  const rvn = ratioFn(rawNdjsonBytes, outputBytes);

  process.stderr.write(
    `    → ${bpl.toFixed(2)} B/log | ` +
      `${rvr.toFixed(1)}× vs text | ` +
      `${rvn.toFixed(1)}× vs ndjson | ` +
      `${(count / (ingestMs / 1000)).toFixed(0)} records/s | ` +
      `${stats.chunks} chunks\n`
  );

  return {
    corpus: label,
    codec: "typed-columnar-zstd19",
    inputBytes: rawNdjsonBytes,
    outputBytes,
    logCount: count,
    bytesPerLog: bpl,
    ratioVsRaw: rvr,
    ratioVsNdjson: rvn,
    encodeMillis: ingestMs,
  };
}

export default async function run() {
  process.stderr.write("\n═══ Comprehensive Storage Benchmark ═══\n\n");
  const results: CompressionResult[] = [];

  for (const c of CASES) {
    results.push(runCase(c));
  }

  // Summary table by corpus type (averages across sizes)
  process.stderr.write("\n─── Summary by corpus type (10K) ───\n");
  for (const type of Object.keys(CORPUS_GENERATORS) as SyntheticCorpusType[]) {
    const row = results.find((r) => r.corpus === `${type}/10k`);
    if (row) {
      process.stderr.write(
        `  ${type.padEnd(18)} ${row.bytesPerLog.toFixed(2).padStart(8)} B/log  ` +
          `${row.ratioVsNdjson.toFixed(1)}× vs ndjson\n`
      );
    }
  }
  process.stderr.write("\n");

  return buildReport("comprehensive-storage", results);
}
