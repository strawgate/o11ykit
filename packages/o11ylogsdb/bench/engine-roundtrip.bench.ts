/**
 * Engine roundtrip benchmark — measures the actual o11ylogsdb engine
 * end-to-end, not just standalone codecs.
 *
 *   for each Loghub-2k corpus:
 *     ingest every line as a LogRecord into a LogStore
 *     flush
 *     measure total chunk bytes / log
 *     iterate records back and verify count
 *
 * The engine currently uses NDJSON + zstd-19 (DefaultChunkPolicy). M3
 * (per-stream chunk format with template dict + FSST symbol table)
 * and M4 (per-column dispatch) will lower these numbers significantly.
 *
 * This row tells us what the *whole* engine produces, including chunk
 * header overhead, magic bytes, length prefixes, and the JSON
 * serialization tax. Compare against the standalone `text_zstd-19`
 * row in `bytes-per-log.bench.ts` for the irreducible compression
 * floor at the same level.
 */

import {
  DefaultChunkPolicy,
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  type LogRecord,
  LogStore,
  type Resource,
  ZstdCodec,
} from "../dist/index.js";
import { type Corpus, loadAllAvailable } from "./corpora.js";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

function recordFromLine(line: string, idx: number): LogRecord {
  return {
    timeUnixNano: BigInt(idx) * 1_000_000_000n,
    severityNumber: 9, // INFO per OTLP severity_number
    severityText: "INFO",
    body: line,
    attributes: [],
  };
}

function buildResource(corpusName: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: corpusName.toLowerCase() },
      { key: "service.instance.id", value: `${corpusName.toLowerCase()}-0` },
    ],
  };
}

function buildScope(): InstrumentationScope {
  return { name: "o11ylogsdb-bench", version: "0.0.0" };
}

interface EngineCodec {
  name: string;
  policy: DefaultChunkPolicy;
}

const ENGINE_CODECS: EngineCodec[] = [
  { name: "engine_zstd-19", policy: new DefaultChunkPolicy("zstd-19") },
  { name: "engine_zstd-3", policy: new DefaultChunkPolicy("zstd-3") },
  { name: "engine_gzip-6", policy: new DefaultChunkPolicy("gzip-6") },
];

function runOne(corpus: Corpus, codec: EngineCodec): CompressionResult {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(19)),
    policy: codec.policy,
    rowsPerChunk: 1024,
  });
  const resource = buildResource(corpus.name);
  const scope = buildScope();
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);

  const t0 = nowMillis();
  for (let i = 0; i < lines.length; i++) {
    store.append(resource, scope, recordFromLine(lines[i] as string, i));
  }
  store.flush();
  const t1 = nowMillis();

  const stats = store.stats();

  // Sanity round-trip: count how many records come back.
  let roundTripCount = 0;
  for (const { records } of store.iterRecords()) {
    roundTripCount += records.length;
  }
  if (roundTripCount !== stats.totalLogs) {
    throw new Error(`Engine round-trip count mismatch: ${roundTripCount} vs ${stats.totalLogs}`);
  }

  return {
    corpus: corpus.name,
    codec: codec.name,
    inputBytes: corpus.text.length,
    outputBytes: stats.totalChunkBytes,
    logCount: stats.totalLogs,
    bytesPerLog: bytesPerLog(stats.totalChunkBytes, stats.totalLogs),
    ratioVsRaw: ratioFn(corpus.text.length, stats.totalChunkBytes),
    ratioVsNdjson: ratioFn(corpus.ndjson.length, stats.totalChunkBytes),
    encodeMillis: t1 - t0,
  };
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) {
    throw new Error("No corpora present. Run `bash bench/scripts/download-loghub.sh`.");
  }
  const compression: CompressionResult[] = [];
  for (const corpus of corpora) {
    for (const codec of ENGINE_CODECS) {
      compression.push(runOne(corpus, codec));
    }
  }
  return buildReport("engine-roundtrip", compression);
}
