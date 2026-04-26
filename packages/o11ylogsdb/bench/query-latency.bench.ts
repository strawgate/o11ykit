/**
 * query-latency — measures end-to-end query latency for a small set
 * of representative predicates against a Loghub-2k corpus ingested
 * through TypedColumnarDrainPolicy.
 *
 * Each query is profiled with the same harness as profile-policies:
 * timing percentiles + heap delta + arrayBuffer delta. The CompressionResult
 * fields are repurposed:
 *   - inputBytes  = total chunk bytes scanned
 *   - outputBytes = total bytes of records emitted (rough)
 *   - logCount    = recordsScanned (denominator for "B/log scanned")
 *   - bytesPerLog = decodeMillis / recordsScanned (microseconds-per-decoded-record)
 *
 * The numbers we actually report (in the per-row console output and
 * results.md):
 *   - emitted records (predicate selectivity)
 *   - decode-only ms (chunks decompressed regardless of predicate)
 *   - total query ms
 *   - chunks pruned vs scanned (header-prune effectiveness)
 *
 * Six predicate kinds, each tested against every Loghub-2k corpus.
 * The intent is to surface the cost of each predicate type
 * separately — bodyContains needs full chunk decode + per-record
 * scan; severityGte can short-circuit at decode-time; resourceEquals
 * is a pure header check.
 */

import {
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  type LogRecord,
  LogStore,
  type QuerySpec,
  query,
  type Resource,
  TypedColumnarDrainPolicy,
  ZstdCodec,
} from "../dist/index.js";
import { type Corpus, loadAllAvailable } from "./corpora.js";
import { buildProfileReport, type ProfileResult, profileEncode } from "./profile-harness.js";

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };

function buildResource(corpusName: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: corpusName.toLowerCase() },
      { key: "service.instance.id", value: `${corpusName.toLowerCase()}-0` },
    ],
  };
}

function recordFromLine(line: string, idx: number): LogRecord {
  // Time spread: each chunk gets ~1024 records spaced 1s apart.
  // Severity: cycle through {INFO=9, WARN=13, ERROR=17, FATAL=21}
  // weighted toward INFO (typical real distribution). The cycle uses
  // mod 16 so most records are INFO and the WARN/ERROR/FATAL sample
  // is non-trivial but realistic.
  let severityNumber = 9; // INFO
  let severityText = "INFO";
  const m = idx % 16;
  if (m === 7) {
    severityNumber = 13;
    severityText = "WARN";
  } else if (m === 13) {
    severityNumber = 17;
    severityText = "ERROR";
  }
  return {
    timeUnixNano: BigInt(idx) * 1_000_000_000n,
    severityNumber,
    severityText,
    body: line,
    attributes: [],
  };
}

function buildStore(corpus: Corpus): LogStore {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 1024, // smaller chunks → more pruning headroom
  });
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const resource = buildResource(corpus.name);
  for (let i = 0; i < lines.length; i++) {
    store.append(resource, SCOPE, recordFromLine(lines[i] as string, i));
  }
  store.flush();
  return store;
}

interface QueryCase {
  name: string;
  spec: (corpus: Corpus) => QuerySpec;
}

const QUERIES: QueryCase[] = [
  {
    name: "warn_or_higher",
    spec: () => ({ severityGte: 13 }),
  },
  {
    name: "error_or_higher",
    spec: () => ({ severityGte: 17 }),
  },
  {
    // Adversarial-pruning case: synthetic severity cycle never emits
    // FATAL (≥21), so every chunk's severityRange.max is below the
    // gate. With zone-map enabled, every chunk is pruned and no
    // payload is decoded. Latency here measures the chunk-iteration
    // overhead — should be dramatically lower than warn_or_higher
    // on the same store, validating the zone-map prune actually fires.
    name: "fatal_only",
    spec: () => ({ severityGte: 21 }),
  },
  {
    name: "first_60s",
    spec: () => ({
      range: {
        from: 0n,
        to: 60n * 1_000_000_000n,
      },
    }),
  },
  {
    name: "service_match",
    spec: (corpus) => ({
      resourceEquals: { "service.name": corpus.name.toLowerCase() },
    }),
  },
  {
    name: "service_no_match",
    spec: () => ({
      resourceEquals: { "service.name": "_does_not_exist_" },
    }),
  },
  {
    // Substring known to appear in HDFS/Apache/etc. — pick a mid-line
    // word that's likely in the templated portion. We use the first
    // word of the first line as an oracle so every corpus has a
    // non-trivial positive match.
    name: "body_contains_first_word",
    spec: (corpus) => {
      const firstLine = corpus.text
        .toString("utf8")
        .split("\n")
        .find((l) => l.length > 0) as string;
      const firstWord = firstLine.split(/\s+/)[0] ?? "";
      return { bodyContains: firstWord };
    },
  },
];

function runOne(corpus: Corpus, qCase: QueryCase, store: LogStore): ProfileResult {
  const spec = qCase.spec(corpus);
  // Sample to capture inputBytes / output count for the result row.
  const sample = query(store, spec);
  const totalChunkBytes = store.stats().totalChunkBytes;
  // Surface pruning stats inline so the user can see whether a
  // latency win came from a real zone-map prune or just from V8
  // warmup. Auditable beats clever-sounding.
  process.stderr.write(
    `  ${corpus.name.padEnd(11)} ${qCase.name.padEnd(28)} ` +
      `chunks scanned=${sample.stats.chunksScanned} pruned=${sample.stats.chunksPruned} ` +
      `streams scanned=${sample.stats.streamsScanned} pruned=${sample.stats.streamsPruned} ` +
      `records emitted=${sample.records.length}\n`
  );
  return profileEncode({
    corpus: corpus.name,
    codec: qCase.name,
    inputBytes: totalChunkBytes,
    rawTextBytes: corpus.text.length,
    rawNdjsonBytes: corpus.ndjson.length,
    logCount: sample.records.length,
    encode: () => {
      // The "encode" closure is the query call. We re-run the query
      // each iteration; the store stays warm across iterations.
      const r = query(store, spec);
      return r.records.length; // returned as outputBytes proxy
    },
    options: { warmup: 2, iterations: 5 },
  });
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) throw new Error("No corpora present at bench/corpora/loghub-2k/.");
  const results: ProfileResult[] = [];
  for (const corpus of corpora) {
    const store = buildStore(corpus);
    for (const q of QUERIES) {
      results.push(runOne(corpus, q, store));
    }
  }
  return buildProfileReport("query-latency", results);
}
