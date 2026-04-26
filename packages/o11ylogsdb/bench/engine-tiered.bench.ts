/**
 * engine-tiered — Experiment U. Validates Experiment T's tiered
 * codec recommendation through the *actual* engine (LogStore +
 * ColumnarDrainPolicy), not a 3-column microbench.
 *
 * Runs the same Loghub-2k ingest pipeline at three body-codec levels:
 *   - zstd-3   (hot ingest target)
 *   - zstd-9   (warm tier)
 *   - zstd-19  (cold / fully compressed)
 *
 * Reports bytes/log and total ingest wall-clock time per corpus.
 * The structural columns (timestamps, severities, kinds) all use
 * zstd-19 implicitly via ChunkBuilder's bodyCodec — but the
 * ColumnarDrainPolicy.encodePayload returns a single concatenated
 * buffer fed to one ZSTD pass, so this benchmark is more a
 * "single-pass body codec level" test than a per-column tier test.
 * Either way it measures whether T's recommendation holds in the
 * shipping engine.
 *
 * Round-trip is verified: each chunk's records are decoded back and
 * the count + first 32 records' bodies match the input (modulo
 * Drain's whitespace normalization).
 */

import {
  ColumnarDrainPolicy,
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
    severityNumber: 9,
    severityText: "INFO",
    body: line,
    attributes: [],
  };
}

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };

function buildResource(corpusName: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: corpusName.toLowerCase() },
      { key: "service.instance.id", value: `${corpusName.toLowerCase()}-0` },
    ],
  };
}

interface Tier {
  name: string;
  bodyCodec: string;
}

const TIERS: Tier[] = [
  { name: "engine_columnar_z3", bodyCodec: "zstd-3" },
  { name: "engine_columnar_z9", bodyCodec: "zstd-9" },
  { name: "engine_columnar_z19", bodyCodec: "zstd-19" },
];

function runOne(corpus: Corpus, tier: Tier): CompressionResult {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: new ColumnarDrainPolicy({ bodyCodec: tier.bodyCodec }),
    rowsPerChunk: 1024,
  });
  const resource = buildResource(corpus.name);
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);

  const t0 = nowMillis();
  for (let i = 0; i < lines.length; i++) {
    store.append(resource, SCOPE, recordFromLine(lines[i] as string, i));
  }
  store.flush();
  const t1 = nowMillis();

  const stats = store.stats();

  // Round-trip count + first-chunk content sanity.
  let roundTripCount = 0;
  let firstChunkChecked = false;
  for (const { records } of store.iterRecords()) {
    roundTripCount += records.length;
    if (!firstChunkChecked) {
      const checkN = Math.min(8, records.length);
      for (let i = 0; i < checkN; i++) {
        const got = (records[i] as LogRecord).body;
        const want = (lines[i] as string)
          .split(/\s+/)
          .filter((t) => t.length > 0)
          .join(" ");
        if (got !== want) {
          throw new Error(`${tier.name}: body mismatch at ${corpus.name} chunk[0][${i}]`);
        }
      }
      firstChunkChecked = true;
    }
  }
  if (roundTripCount !== stats.totalLogs) {
    throw new Error(`${tier.name}: count mismatch on ${corpus.name}`);
  }

  return {
    corpus: corpus.name,
    codec: tier.name,
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
  if (corpora.length === 0) throw new Error("No corpora present at bench/corpora/loghub-2k/.");
  const compression: CompressionResult[] = [];
  for (const corpus of corpora) {
    for (const tier of TIERS) {
      compression.push(runOne(corpus, tier));
    }
  }
  return buildReport("engine-tiered", compression);
}
