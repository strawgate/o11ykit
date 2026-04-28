/**
 * comprehensive-query.bench.ts — Cross-corpus query performance benchmark.
 *
 * Tests common query patterns against all synthetic corpus types at 10K scale:
 *   1. Time range (first 10%, last 10%)
 *   2. Severity filter (ERROR+, WARN+)
 *   3. Body substring search
 *   4. Resource/service filter
 *   5. Combined predicates (time + severity + body)
 *   6. Full scan (no predicates)
 *
 * Reports query latency (p50/p99), records scanned, records emitted,
 * and pruning effectiveness (chunks pruned / total).
 */

import {
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  type LogRecord,
  LogStore,
  query,
  type QuerySpec,
  type Resource,
  TypedColumnarDrainPolicy,
  ZstdCodec,
} from "../dist/index.js";
import {
  CORPUS_GENERATORS,
  type SyntheticCorpusType,
} from "./synthetic-corpora.js";
import { nowMillis } from "./harness.js";
import { buildProfileReport, type ProfileResult, profileEncode } from "./profile-harness.js";

const SCOPE: InstrumentationScope = { name: "bench-query", version: "0.0.0" };
const RECORD_COUNT = 10_000;

function buildResource(corpusType: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: `bench-${corpusType}` },
      { key: "corpus.type", value: corpusType },
    ],
  };
}

function buildStore(corpusType: SyntheticCorpusType): LogStore {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 1024,
  });

  const records = CORPUS_GENERATORS[corpusType](RECORD_COUNT);
  const resource = buildResource(corpusType);
  for (const record of records) {
    store.append(resource, SCOPE, record);
  }
  store.flush();
  return store;
}

interface QueryCase {
  name: string;
  description: string;
  spec: (records: LogRecord[]) => QuerySpec;
}

const QUERY_CASES: QueryCase[] = [
  {
    name: "full_scan",
    description: "No predicates — full decode + emit",
    spec: () => ({}),
  },
  {
    name: "severity_warn+",
    description: "Severity >= WARN (13)",
    spec: () => ({ severityGte: 13 }),
  },
  {
    name: "severity_error+",
    description: "Severity >= ERROR (17)",
    spec: () => ({ severityGte: 17 }),
  },
  {
    name: "time_first_10pct",
    description: "First 10% of time range",
    spec: (records) => {
      const first = records[0]!.timeUnixNano;
      const last = records[records.length - 1]!.timeUnixNano;
      const range = last - first;
      return { range: { from: first, to: first + range / 10n } };
    },
  },
  {
    name: "time_last_10pct",
    description: "Last 10% of time range",
    spec: (records) => {
      const first = records[0]!.timeUnixNano;
      const last = records[records.length - 1]!.timeUnixNano;
      const range = last - first;
      return { range: { from: last - range / 10n, to: last } };
    },
  },
  {
    name: "service_match",
    description: "Resource service.name match",
    spec: () => ({
      resourceEquals: { "service.name": "bench-syslog" },
    }),
  },
  {
    name: "service_no_match",
    description: "Resource service.name no match",
    spec: () => ({
      resourceEquals: { "service.name": "_does_not_exist_" },
    }),
  },
  {
    name: "body_substring",
    description: "Body contains common keyword",
    spec: () => ({ bodyContains: "error" }),
  },
  {
    name: "combined_time+severity",
    description: "Time range + severity filter",
    spec: (records) => {
      const first = records[0]!.timeUnixNano;
      const last = records[records.length - 1]!.timeUnixNano;
      const range = last - first;
      return {
        severityGte: 17,
        range: { from: first, to: first + range / 2n },
      };
    },
  },
  {
    name: "combined_all",
    description: "Time + severity + service + body",
    spec: (records) => {
      const first = records[0]!.timeUnixNano;
      const last = records[records.length - 1]!.timeUnixNano;
      const range = last - first;
      return {
        severityGte: 13,
        range: { from: first, to: first + range / 2n },
        resourceEquals: { "corpus.type": "syslog" },
        bodyContains: "ssh",
      };
    },
  },
];

const CORPUS_TYPES: SyntheticCorpusType[] = [
  "syslog",
  "structured",
  "high-cardinality",
  "cloud-native",
  "mixed",
];

function runQueryCase(
  corpusType: SyntheticCorpusType,
  store: LogStore,
  records: LogRecord[],
  qCase: QueryCase
): ProfileResult {
  const spec = qCase.spec(records);
  const totalChunkBytes = store.stats().totalChunkBytes;

  // Warm up + sample to get record count
  const sample = query(store, spec);
  process.stderr.write(
    `    ${qCase.name.padEnd(24)} emitted=${String(sample.records.length).padStart(6)} ` +
      `scanned=${sample.stats.chunksScanned} pruned=${sample.stats.chunksPruned}\n`
  );

  // Estimate raw sizes for ratio fields
  const rawTextBytes = records.reduce((s, r) => {
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return s + body.length;
  }, 0);

  return profileEncode({
    corpus: corpusType,
    codec: qCase.name,
    inputBytes: totalChunkBytes,
    rawTextBytes,
    rawNdjsonBytes: rawTextBytes * 2, // rough proxy
    logCount: sample.records.length || 1,
    encode: () => {
      const r = query(store, spec);
      return r.records.length;
    },
    options: { warmup: 2, iterations: 5 },
  });
}

export default async function run() {
  process.stderr.write("\n═══ Comprehensive Query Benchmark (10K records per corpus) ═══\n\n");
  const results: ProfileResult[] = [];

  for (const corpusType of CORPUS_TYPES) {
    process.stderr.write(`  ─── ${corpusType} ───\n`);
    const records = CORPUS_GENERATORS[corpusType](RECORD_COUNT);
    const store = buildStore(corpusType);

    for (const qCase of QUERY_CASES) {
      results.push(runQueryCase(corpusType, store, records, qCase));
    }
    process.stderr.write("\n");
  }

  // Summary
  process.stderr.write("─── Query latency summary (p50 ms) ───\n");
  process.stderr.write("  " + "query".padEnd(24));
  for (const ct of CORPUS_TYPES) process.stderr.write(ct.padEnd(16));
  process.stderr.write("\n");

  for (const qCase of QUERY_CASES) {
    process.stderr.write("  " + qCase.name.padEnd(24));
    for (const ct of CORPUS_TYPES) {
      const r = results.find((x) => x.corpus === ct && x.codec === qCase.name);
      const val = r ? r.timing.p50.toFixed(1) : "—";
      process.stderr.write(val.padEnd(16));
    }
    process.stderr.write("\n");
  }
  process.stderr.write("\n");

  return buildProfileReport("comprehensive-query", results);
}
