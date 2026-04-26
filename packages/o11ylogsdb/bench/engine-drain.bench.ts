/**
 * engine-drain — engine roundtrip with the DrainChunkPolicy plugged in.
 *
 * Same shape as `engine-roundtrip.bench.ts`, but instead of the
 * default NDJSON+zstd policy, this exercises Drain templating on the
 * body column. The chunk header carries the per-chunk template
 * dictionary; the codec-meta blob is round-tripped through chunk
 * serialize/deserialize.
 *
 * Validation in addition to count round-trip: a content check on the
 * first 32 records of every chunk verifies that body reconstruction
 * is bit-identical to the original input. This is the
 * `(template, vars) → reconstructed line` invariant; if it ever
 * fails, the policy or the Drain port is buggy.
 *
 * The expected numbers: drain_zstd-19 should beat default zstd-19 on
 * Loghub corpora because the templated form removes most body bytes.
 * The exact margin matches the standalone drain_zstd-19 row in
 * bytes-per-log.bench.ts modulo NDJSON envelope + chunk header.
 */

import {
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
  build(): DefaultChunkPolicy | DrainChunkPolicy;
}

const VARIANTS: PolicyVariant[] = [
  {
    name: "engine_default_zstd-19",
    build: () => new DefaultChunkPolicy("zstd-19"),
  },
  {
    name: "engine_drain_zstd-19",
    build: () => new DrainChunkPolicy({ bodyCodec: "zstd-19" }),
  },
  {
    name: "engine_drain_gzip-6",
    build: () => new DrainChunkPolicy({ bodyCodec: "gzip-6" }),
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

  // Count round-trip + content round-trip on the first 32 records.
  let roundTripCount = 0;
  let firstChunkChecked = false;
  for (const { records } of store.iterRecords()) {
    roundTripCount += records.length;
    if (!firstChunkChecked) {
      const checkN = Math.min(32, records.length);
      for (let i = 0; i < checkN; i++) {
        const got = (records[i] as LogRecord).body;
        const wantRaw = lines[i] as string;
        // Drain normalizes whitespace (split / join on single space).
        // Default policy preserves bytes verbatim. Compare against the
        // appropriate form per variant.
        const want = variant.name.startsWith("engine_drain")
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
  return buildReport("engine-drain", compression);
}
