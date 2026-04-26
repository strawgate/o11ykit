/**
 * engine-typed — applies M4 per-template variable typing through the
 * actual engine (LogStore + TypedColumnarDrainPolicy). Validates
 * the prediction that auto-detecting `blk_int` and
 * `signed_int` slot shapes turns 22.5 → ~19 B/log on HDFS without
 * lossy techniques.
 *
 * Compares:
 *   - engine_columnar_z19         (baseline; no typing)
 *   - engine_typed_z19            (this experiment; per-slot typing)
 *
 * Both at body-codec z19 for apples-to-apples; tier strategy from
 * this codec choice is orthogonal and tested separately.
 *
 * Round-trip is verified for content + count.
 */

import {
  ColumnarDrainPolicy,
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

interface Variant {
  name: string;
  build: () => ColumnarDrainPolicy | TypedColumnarDrainPolicy;
}

const VARIANTS: Variant[] = [
  {
    name: "engine_columnar_z19",
    build: () => new ColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
  },
  {
    name: "engine_typed_z19",
    build: () => new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
  },
];

function runOne(corpus: Corpus, variant: Variant): CompressionResult {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: variant.build(),
    rowsPerChunk: 4096, // bigger chunk = more records per template = better typing detection
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

  // Round-trip count + content sanity.
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
          throw new Error(
            `${variant.name}: body mismatch at ${corpus.name} chunk[0][${i}]\n` +
              `  expected: ${JSON.stringify(want)}\n` +
              `  got:      ${JSON.stringify(got)}`
          );
        }
      }
      firstChunkChecked = true;
    }
  }
  if (roundTripCount !== stats.totalLogs) {
    throw new Error(`${variant.name}: count mismatch on ${corpus.name}`);
  }

  return {
    corpus: corpus.name,
    codec: variant.name,
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
    for (const variant of VARIANTS) {
      compression.push(runOne(corpus, variant));
    }
  }
  return buildReport("engine-typed", compression);
}
