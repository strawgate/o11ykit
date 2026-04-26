/**
 * query-at-scale — measures query latency against a 500K-record
 * store. The earlier query-latency bench used 2-chunk stores;
 * production scenarios have hundreds. This bench validates that
 * latency scales sensibly (linear with chunks-not-pruned, near-zero
 * for fully-pruned queries) and surfaces any super-linear costs.
 *
 * Build phase: ingest 500K records of each (Apache, OpenStack) using
 * TypedColumnarDrainPolicy at body-codec z19 (the worst case for
 * decode time). Apache + OpenStack are the throughput extremes from
 * Experiment Y, so they bound the query-latency space.
 *
 * Query phase: 7 representative queries per store, profiled via the
 * profile-harness for timing percentiles + heap delta.
 *
 * Reports inline (stderr): chunks scanned/pruned, records emitted.
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
const TARGET_RECORDS = 500_000;

function buildResource(corpusName: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: corpusName.toLowerCase() },
      { key: "service.instance.id", value: `${corpusName.toLowerCase()}-0` },
    ],
  };
}

function recordFromLine(line: string, idx: number): LogRecord {
  // Severity cycle: most INFO, some WARN, rare ERROR. No FATAL —
  // makes "fatal_only" the canonical adversarial-pruning case.
  let severityNumber = 9;
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
    rowsPerChunk: 4096,
  });
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const lineCount = lines.length;
  const resource = buildResource(corpus.name);
  for (let i = 0; i < TARGET_RECORDS; i++) {
    const line = lines[i % lineCount] as string;
    store.append(resource, SCOPE, recordFromLine(line, i));
  }
  store.flush();
  return store;
}

interface QueryCase {
  name: string;
  spec: (corpus: Corpus) => QuerySpec;
}

const QUERIES: QueryCase[] = [
  // Adversarial-pruning cases (should be near-zero ms).
  { name: "fatal_only", spec: () => ({ severityGte: 21 }) },
  {
    name: "service_no_match",
    spec: () => ({ resourceEquals: { "service.name": "_does_not_exist_" } }),
  },
  // Pruned by time range — only 60s of 500K seconds = 60 records.
  {
    name: "first_60s",
    spec: () => ({
      range: { from: 0n, to: 60n * 1_000_000_000n },
    }),
  },
  // Full-decode cases (every chunk has WARN/ERROR).
  { name: "warn_or_higher", spec: () => ({ severityGte: 13 }) },
  { name: "error_or_higher", spec: () => ({ severityGte: 17 }) },
  // Resource match — every chunk is in scope; full scan needed.
  {
    name: "service_match",
    spec: (corpus) => ({
      resourceEquals: { "service.name": corpus.name.toLowerCase() },
    }),
  },
  // Body substring — full chunk decode + per-record string scan.
  {
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
  const sample = query(store, spec);
  const totalChunkBytes = store.stats().totalChunkBytes;
  process.stderr.write(
    `  ${corpus.name.padEnd(11)} ${qCase.name.padEnd(28)} ` +
      `chunks scanned=${sample.stats.chunksScanned.toString().padStart(4)} pruned=${sample.stats.chunksPruned.toString().padStart(4)} ` +
      `records emitted=${sample.records.length.toLocaleString().padStart(8)} ` +
      `decode=${sample.stats.decodeMillis.toFixed(0)}ms\n`
  );
  return profileEncode({
    corpus: corpus.name,
    codec: qCase.name,
    inputBytes: totalChunkBytes,
    rawTextBytes: corpus.text.length,
    rawNdjsonBytes: corpus.ndjson.length,
    logCount: sample.records.length,
    encode: () => {
      const r = query(store, spec);
      return r.records.length;
    },
    options: { warmup: 2, iterations: 5 },
  });
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  const targets = ["Apache", "OpenStack"]
    .map((n) => corpora.find((c) => c.name === n))
    .filter((c): c is Corpus => !!c);
  const results: ProfileResult[] = [];
  for (const corpus of targets) {
    process.stderr.write(
      `\n→ Building ${corpus.name} store at ${TARGET_RECORDS.toLocaleString()} records…\n`
    );
    const t0 = Date.now();
    const store = buildStore(corpus);
    process.stderr.write(
      `  built in ${Date.now() - t0} ms (${store.stats().chunks} chunks, ${store.stats().totalChunkBytes.toLocaleString()} bytes)\n`
    );
    for (const q of QUERIES) {
      results.push(runOne(corpus, q, store));
    }
  }
  return buildProfileReport("query-at-scale", results);
}
