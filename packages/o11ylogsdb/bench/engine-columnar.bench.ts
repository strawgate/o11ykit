/**
 * engine-columnar — M4 columnar binary body codec.
 *
 * Same setup as `engine-drain.bench.ts`, but exercises three policies:
 *
 *   - `engine_default_zstd-19`   (baseline; NDJSON envelope + ZSTD-19)
 *   - `engine_drain_zstd-19`     (NDJSON Drain — the NDJSON Drain refutation; should
 *                                  reproduce its 5–35% loss vs default)
 *   - `engine_columnar_zstd-19`  (NEW: columnar binary payload, Drain
 *                                  templates, ZSTD-19)
 *   - `engine_columnar_raw_zstd-19` (NEW: columnar binary payload,
 *                                     no Drain templating — isolates
 *                                     "layout wins" from "Drain wins")
 *
 * Validation: count round-trip on every chunk, plus content round-trip
 * on the first 32 records of every chunk. Templated rows are compared
 * after Drain whitespace normalization (same rule as engine-drain).
 *
 * Success criteria:
 *   hard — `engine_columnar_zstd-19` beats `engine_default_zstd-19` on
 *          ≥4 of the 6 Loghub-2k corpora.
 *   soft — beats by ~1.3× or more on Apache, OpenSSH, Linux.
 */

import {
  ColumnarDrainPolicy,
  ColumnarRawPolicy,
  DefaultChunkPolicy,
  DrainChunkPolicy,
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

function buildResource(corpusName: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: corpusName.toLowerCase() },
      { key: "service.instance.id", value: `${corpusName.toLowerCase()}-0` },
    ],
  };
}

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };

interface PolicyVariant {
  name: string;
  /** Whether this variant normalizes templated-body whitespace. */
  normalizesWhitespace: boolean;
  build(): DefaultChunkPolicy | DrainChunkPolicy | ColumnarDrainPolicy | ColumnarRawPolicy;
}

const VARIANTS: PolicyVariant[] = [
  {
    name: "engine_default_zstd-19",
    normalizesWhitespace: false,
    build: () => new DefaultChunkPolicy("zstd-19"),
  },
  {
    name: "engine_drain_zstd-19",
    normalizesWhitespace: true,
    build: () => new DrainChunkPolicy({ bodyCodec: "zstd-19" }),
  },
  {
    name: "engine_columnar_zstd-19",
    normalizesWhitespace: true,
    build: () => new ColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
  },
  {
    name: "engine_columnar_raw_zstd-19",
    normalizesWhitespace: false,
    build: () => new ColumnarRawPolicy({ bodyCodec: "zstd-19" }),
  },
];

function runOne(corpus: Corpus, variant: PolicyVariant): CompressionResult {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(19)),
    policy: variant.build(),
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

  // Count + content round-trip on every chunk's first 32 records.
  let roundTripCount = 0;
  let firstChunkChecked = false;
  for (const { records } of store.iterRecords()) {
    roundTripCount += records.length;
    if (!firstChunkChecked) {
      const checkN = Math.min(32, records.length);
      for (let i = 0; i < checkN; i++) {
        const got = (records[i] as LogRecord).body;
        const wantRaw = lines[i] as string;
        const want = variant.normalizesWhitespace
          ? wantRaw
              .split(/\s+/)
              .filter((t) => t.length > 0)
              .join(" ")
          : wantRaw;
        if (got !== want) {
          throw new Error(
            `${variant.name}: body mismatch at chunk[0][${i}] for ${corpus.name}\n` +
              `  expected: ${JSON.stringify(want)}\n` +
              `  got:      ${JSON.stringify(got)}`
          );
        }
      }
      firstChunkChecked = true;
    }
  }
  if (roundTripCount !== stats.totalLogs) {
    throw new Error(`${variant.name}: count mismatch ${roundTripCount} vs ${stats.totalLogs}`);
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
  if (corpora.length === 0) {
    throw new Error("No corpora present at bench/corpora/loghub-2k/.");
  }
  const compression: CompressionResult[] = [];
  for (const corpus of corpora) {
    for (const variant of VARIANTS) {
      compression.push(runOne(corpus, variant));
    }
  }
  return buildReport("engine-columnar", compression);
}
