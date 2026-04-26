/**
 * pino-query — query an engine populated with Pino-shape KVList
 * bodies. Tests the M4 sidecar attribute extraction under real
 * KVList workload.
 *
 * Pino-style records have the body as an object:
 *
 *   {
 *     "level": 30,
 *     "msg": "incoming request",
 *     "req": {"id": "...", "method": "GET", "url": "/api/foo"},
 *     "res": {"statusCode": 200},
 *     "responseTime": 600.02,
 *     "userId": "user_2913"
 *   }
 *
 * The current TypedColumnarDrainPolicy classifies non-string bodies
 * as KIND_OTHER and stuffs them into the sidecar NDJSON. Queries
 * that filter on body sub-fields must therefore decode the chunk
 * (cheap) + deserialize the sidecar JSON (expensive) + walk the
 * body object per record.
 *
 * This bench measures:
 *   - Storage cost: KVList bodies via M4 sidecar vs raw NDJSON.
 *   - Query latency: severity-pruned, attribute-equals, body-leaf
 *     equals at varying selectivity.
 *
 * Output validates whether the sidecar approach is good enough for
 * v1 KVList query, or whether M4 needs a real per-key column path.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AnyValue,
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  LogStore,
  type QuerySpec,
  query,
  type Resource,
  TypedColumnarDrainPolicy,
  ZstdCodec,
} from "../dist/index.js";
import { buildProfileReport, type ProfileResult, profileEncode } from "./profile-harness.js";

// Walk up from the compiled module to find the package root (which
// has `package.json`), so the corpus path resolves whether we're
// running the bench from `dist-bench/` or `bench/`. Same pattern as
// `corpora.ts`.
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate package root from ${import.meta.url}`);
}
const PACKAGE_ROOT = findPackageRoot();
const CORPUS_PATH = join(PACKAGE_ROOT, "bench", "corpora", "synthetic", "pino_5k.ndjson");

interface PinoSourceRecord {
  timestamp: number;
  severity: string;
  resource: { "service.name": string };
  body: Record<string, unknown>;
}

function loadPinoCorpus(): PinoSourceRecord[] {
  if (!existsSync(CORPUS_PATH)) {
    throw new Error(
      `Pino corpus not found at ${CORPUS_PATH}. Generate via:\n  python3 bench/scripts/generate-pino-corpus.py`
    );
  }
  const text = readFileSync(CORPUS_PATH, "utf8");
  const records: PinoSourceRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    records.push(JSON.parse(line) as PinoSourceRecord);
  }
  return records;
}

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };

function severityToNumber(s: string): number {
  switch (s) {
    case "TRACE":
      return 1;
    case "DEBUG":
      return 5;
    case "INFO":
      return 9;
    case "WARN":
      return 13;
    case "ERROR":
      return 17;
    case "FATAL":
      return 21;
    default:
      return 9;
  }
}

function buildResource(serviceName: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: serviceName },
      { key: "service.instance.id", value: `${serviceName}-0` },
    ],
  };
}

function buildStore(records: PinoSourceRecord[]): {
  store: LogStore;
  resourceByService: Map<string, Resource>;
} {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 1024,
  });
  const resourceByService = new Map<string, Resource>();
  for (const r of records) {
    const svc = r.resource["service.name"];
    let resource = resourceByService.get(svc);
    if (!resource) {
      resource = buildResource(svc);
      resourceByService.set(svc, resource);
    }
    store.append(resource, SCOPE, {
      timeUnixNano: BigInt(r.timestamp),
      severityNumber: severityToNumber(r.severity),
      severityText: r.severity,
      body: r.body as AnyValue, // KVList body
      attributes: [],
    });
  }
  store.flush();
  return { store, resourceByService };
}

interface QueryCase {
  name: string;
  spec: QuerySpec;
  /** Optional expected min hit count (sanity check). */
  expectedMinRecords?: number;
}

const QUERIES: QueryCase[] = [
  {
    name: "all_records",
    spec: {},
    expectedMinRecords: 5000,
  },
  {
    name: "service_api",
    spec: { resourceEquals: { "service.name": "api" } },
    expectedMinRecords: 1,
  },
  {
    name: "warn_or_higher",
    spec: { severityGte: 13 },
    expectedMinRecords: 1,
  },
  {
    name: "method_GET",
    spec: { bodyLeafEquals: { "body.req.method": "GET" } },
    expectedMinRecords: 1,
  },
  {
    name: "method_POST_status_500",
    spec: {
      bodyLeafEquals: {
        "body.req.method": "POST",
        "body.res.statusCode": 500,
      },
    },
  },
  {
    name: "userId_specific",
    spec: { bodyLeafEquals: { "body.userId": "user_42" } },
  },
  {
    name: "method_GET_AND_warn",
    spec: {
      severityGte: 13,
      bodyLeafEquals: { "body.req.method": "GET" },
    },
  },
];

function runOne(qCase: QueryCase, store: LogStore): ProfileResult {
  const sample = query(store, qCase.spec);
  if (qCase.expectedMinRecords !== undefined && sample.records.length < qCase.expectedMinRecords) {
    process.stderr.write(
      `  ⚠ ${qCase.name}: expected ≥${qCase.expectedMinRecords} records, got ${sample.records.length}\n`
    );
  }
  process.stderr.write(
    `  ${qCase.name.padEnd(28)} ` +
      `chunks scanned=${sample.stats.chunksScanned.toString().padStart(3)} pruned=${sample.stats.chunksPruned.toString().padStart(3)} ` +
      `streams scanned=${sample.stats.streamsScanned} pruned=${sample.stats.streamsPruned} ` +
      `recs scanned=${sample.stats.recordsScanned.toString().padStart(5)} emitted=${sample.records.length.toString().padStart(5)} ` +
      `decode=${sample.stats.decodeMillis.toFixed(0)}ms\n`
  );
  const stats = store.stats();
  return profileEncode({
    corpus: "pino_5k",
    codec: qCase.name,
    inputBytes: stats.totalChunkBytes,
    rawTextBytes: stats.totalChunkBytes,
    rawNdjsonBytes: stats.totalChunkBytes,
    logCount: sample.records.length,
    encode: () => query(store, qCase.spec).records.length,
    options: { warmup: 2, iterations: 5 },
  });
}

export default async function run() {
  const records = loadPinoCorpus();
  process.stderr.write(`\n→ Loaded ${records.length.toLocaleString()} Pino records\n`);

  const { store } = buildStore(records);
  const stats = store.stats();
  process.stderr.write(
    `  ingested into ${stats.streams} streams, ${stats.chunks} chunks, ` +
      `${stats.totalChunkBytes.toLocaleString()} bytes (${stats.bytesPerLog.toFixed(2)} B/log)\n\n`
  );

  const results: ProfileResult[] = [];
  for (const q of QUERIES) {
    results.push(runOne(q, store));
  }
  return buildProfileReport("pino-query", results);
}
