/**
 * profile-policies — encode-time CPU + memory profile of every
 * shipping ChunkPolicy across the Loghub-2k corpora.
 *
 * Captures (per corpus, per policy):
 *   - bytes/log (the compression metric)
 *   - encode timing percentiles (p50, p90, p99, max) over N iters
 *   - heap delta (V8 heapUsed before/after, after a forced GC)
 *   - ArrayBuffer delta (Node's external buffer pool — what TypedArrays
 *     and codec output buffers actually live in)
 *
 * Run with:
 *   node --expose-gc bench/run.mjs profile-policies --markdown
 *
 * The encode closure for each policy:
 *   - constructs a fresh LogStore + policy
 *   - ingests the corpus (so timing includes Drain ingest + chunk freeze)
 *   - calls flush()
 *   - returns total chunk bytes
 *
 * Each measured iteration reconstructs the LogStore, so memory delta
 * captures one corpus's worth of resident chunks; iterations run
 * back-to-back without GC between them so we can see steady-state
 * allocation behaviour. A final GC + snapshot resolves the delta.
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
  TypedColumnarDrainPolicy,
  ZstdCodec,
} from "../dist/index.js";
import { type Corpus, loadAllAvailable } from "./corpora.js";
import { buildProfileReport, type ProfileResult, profileEncode } from "./profile-harness.js";

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

interface PolicyVariant {
  name: string;
  build: () =>
    | DefaultChunkPolicy
    | DrainChunkPolicy
    | ColumnarDrainPolicy
    | ColumnarRawPolicy
    | TypedColumnarDrainPolicy;
}

const VARIANTS: PolicyVariant[] = [
  { name: "default_zstd-19", build: () => new DefaultChunkPolicy("zstd-19") },
  { name: "drain_zstd-19", build: () => new DrainChunkPolicy({ bodyCodec: "zstd-19" }) },
  { name: "columnar_raw_zstd-19", build: () => new ColumnarRawPolicy({ bodyCodec: "zstd-19" }) },
  {
    name: "columnar_drain_zstd-19",
    build: () => new ColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
  },
  {
    name: "typed_columnar_zstd-19",
    build: () => new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
  },
  // Tier sweeps for typed (the M5 hot-path candidate)
  {
    name: "typed_columnar_zstd-3",
    build: () => new TypedColumnarDrainPolicy({ bodyCodec: "zstd-3" }),
  },
  {
    name: "typed_columnar_zstd-9",
    build: () => new TypedColumnarDrainPolicy({ bodyCodec: "zstd-9" }),
  },
];

function profileOne(corpus: Corpus, variant: PolicyVariant): ProfileResult {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const resource = buildResource(corpus.name);

  const encode = (): number => {
    const store = new LogStore({
      registry: defaultRegistry()
        .register(new GzipCodec(6))
        .register(new ZstdCodec(3))
        .register(new ZstdCodec(9))
        .register(new ZstdCodec(19)),
      policy: variant.build(),
      rowsPerChunk: 4096,
    });
    for (let i = 0; i < lines.length; i++) {
      store.append(resource, SCOPE, recordFromLine(lines[i] as string, i));
    }
    store.flush();
    return store.stats().totalChunkBytes;
  };

  return profileEncode({
    corpus: corpus.name,
    codec: variant.name,
    inputBytes: corpus.text.length,
    rawTextBytes: corpus.text.length,
    rawNdjsonBytes: corpus.ndjson.length,
    logCount: corpus.count,
    encode,
    options: { warmup: 2, iterations: 5 },
  });
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) throw new Error("No corpora present at bench/corpora/loghub-2k/.");
  const results: ProfileResult[] = [];
  for (const corpus of corpora) {
    for (const variant of VARIANTS) {
      results.push(profileOne(corpus, variant));
    }
  }
  return buildProfileReport("profile-policies", results);
}
