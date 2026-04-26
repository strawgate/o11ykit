/**
 * per-stream-drain — Experiment J: Per-stream Drain isolation impact.
 *
 * Validation question: how much does sharing one Drain instance across
 * all streams cost vs giving each stream its own Drain?
 *
 * The current `DrainChunkPolicy` keeps a Drain per policy-instance, and
 * the engine attaches one policy to every stream. This bench measures
 * the gap between three configurations on the 6 Loghub-2k corpora
 * concatenated as 6 streams (one service.name per corpus, all flowing
 * into one engine):
 *
 *   1. shared_drain     — one DrainChunkPolicy shared across all
 *                          streams (the current default).
 *   2. per_stream_drain — engine `policyFactory` returns a fresh
 *                          DrainChunkPolicy per stream.
 *   3. isolated_runs    — one LogStore per corpus, each with its own
 *                          DrainChunkPolicy. Upper-bound reference
 *                          (matches engine-drain.bench.ts shape).
 *
 * For each configuration we report a per-corpus row and an aggregate
 * row across all 6 streams. The "win" of per-stream isolation is the
 * gap between `shared_drain` and (`per_stream_drain` ≈ `isolated_runs`)
 * at the aggregate row.
 *
 * Round-trip is verified for every chunk in every configuration.
 */

import {
  DrainChunkPolicy,
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  type LogRecord,
  LogStore,
  type Resource,
  serializeChunk,
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

function makeRegistry() {
  return defaultRegistry()
    .register(new GzipCodec(6))
    .register(new ZstdCodec(3))
    .register(new ZstdCodec(19));
}

interface CorpusLines {
  corpus: Corpus;
  resource: Resource;
  lines: string[];
}

function prepare(corpora: Corpus[]): CorpusLines[] {
  return corpora.map((c) => ({
    corpus: c,
    resource: buildResource(c.name),
    lines: c.text
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0),
  }));
}

/**
 * Round-trip every chunk in `store`, asserting the count matches the
 * recorded total and that each chunk's first record reconstructs to the
 * (whitespace-normalized) source line. Returns total round-tripped count.
 */
function verifyRoundTrip(
  store: LogStore,
  expectedByStream: Map<string, string[]>,
  configName: string
): number {
  let total = 0;
  // Build a per-service "next index" pointer so we can walk the
  // original lines in the same order they were appended.
  const cursors = new Map<string, number>();
  for (const k of expectedByStream.keys()) cursors.set(k, 0);

  for (const { streamId, records } of store.iterRecords()) {
    total += records.length;
    const resource = store.streams.resourceOf(streamId);
    const svc = (resource.attributes.find((kv) => kv.key === "service.name")?.value ??
      "") as string;
    const lines = expectedByStream.get(svc);
    if (!lines) {
      throw new Error(`${configName}: unknown stream service ${svc}`);
    }
    let cursor = cursors.get(svc) ?? 0;
    // Spot-check first 4 records of each chunk.
    const checkN = Math.min(4, records.length);
    for (let i = 0; i < checkN; i++) {
      const got = (records[i] as LogRecord).body;
      const wantRaw = lines[cursor + i] as string;
      const want = wantRaw
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .join(" ");
      if (got !== want) {
        throw new Error(
          `${configName}: body mismatch for ${svc} chunk record ${i}\n` +
            `  expected: ${JSON.stringify(want)}\n` +
            `  got:      ${JSON.stringify(got)}`
        );
      }
    }
    cursor += records.length;
    cursors.set(svc, cursor);
  }
  return total;
}

interface ConfigOutcome {
  perCorpus: CompressionResult[];
  aggregate: CompressionResult;
  totalTemplates: number;
}

/** shared_drain or per_stream_drain — one LogStore for all 6 streams. */
function runOneStore(
  configName: string,
  prepared: CorpusLines[],
  build: () => { store: LogStore; getTemplateCount: () => number }
): ConfigOutcome {
  const { store, getTemplateCount } = build();

  const expectedByStream = new Map<string, string[]>();
  for (const p of prepared) {
    expectedByStream.set(p.resource.attributes[0]?.value as string, p.lines);
  }

  const t0 = nowMillis();
  let totalInput = 0;
  for (const { resource, lines } of prepared) {
    for (let i = 0; i < lines.length; i++) {
      store.append(resource, SCOPE, recordFromLine(lines[i] as string, i));
    }
    totalInput += lines.reduce((s, l) => s + l.length + 1, 0);
  }
  store.flush();
  const t1 = nowMillis();

  // Per-corpus byte breakdown: walk each stream's chunks individually.
  const perCorpus: CompressionResult[] = [];
  let totalBytes = 0;
  let totalLogs = 0;
  for (const p of prepared) {
    const svc = p.resource.attributes[0]?.value as string;
    let streamBytes = 0;
    let streamLogs = 0;
    for (const id of store.streams.ids()) {
      const r = store.streams.resourceOf(id);
      if ((r.attributes.find((kv) => kv.key === "service.name")?.value ?? "") !== svc) continue;
      for (const chunk of store.streams.chunksOf(id)) {
        streamBytes += serializeChunk(chunk).length;
        streamLogs += chunk.header.nLogs;
      }
    }
    totalBytes += streamBytes;
    totalLogs += streamLogs;
    perCorpus.push({
      corpus: p.corpus.name,
      codec: configName,
      inputBytes: p.corpus.text.length,
      outputBytes: streamBytes,
      logCount: streamLogs,
      bytesPerLog: bytesPerLog(streamBytes, streamLogs),
      ratioVsRaw: ratioFn(p.corpus.text.length, streamBytes),
      ratioVsNdjson: ratioFn(p.corpus.ndjson.length, streamBytes),
      encodeMillis: 0,
    });
  }

  const totalRawText = prepared.reduce((s, p) => s + p.corpus.text.length, 0);
  const totalRawNdjson = prepared.reduce((s, p) => s + p.corpus.ndjson.length, 0);

  // Verify count + content round-trips.
  const got = verifyRoundTrip(store, expectedByStream, configName);
  if (got !== totalLogs) {
    throw new Error(`${configName}: round-trip count ${got} vs stats ${totalLogs}`);
  }

  const aggregate: CompressionResult = {
    corpus: "ALL",
    codec: configName,
    inputBytes: totalInput,
    outputBytes: totalBytes,
    logCount: totalLogs,
    bytesPerLog: bytesPerLog(totalBytes, totalLogs),
    ratioVsRaw: ratioFn(totalRawText, totalBytes),
    ratioVsNdjson: ratioFn(totalRawNdjson, totalBytes),
    encodeMillis: t1 - t0,
  };
  return { perCorpus, aggregate, totalTemplates: getTemplateCount() };
}

/** isolated_runs — one LogStore per corpus, each with its own DrainChunkPolicy. */
function runIsolated(prepared: CorpusLines[]): ConfigOutcome {
  const perCorpus: CompressionResult[] = [];
  let totalBytes = 0;
  let totalLogs = 0;
  let totalInput = 0;
  let totalTemplates = 0;
  let totalEncodeMs = 0;

  for (const p of prepared) {
    const policy = new DrainChunkPolicy({ bodyCodec: "zstd-19" });
    const store = new LogStore({
      registry: makeRegistry(),
      policy,
      rowsPerChunk: 1024,
    });
    const t0 = nowMillis();
    for (let i = 0; i < p.lines.length; i++) {
      store.append(p.resource, SCOPE, recordFromLine(p.lines[i] as string, i));
    }
    store.flush();
    const t1 = nowMillis();
    totalEncodeMs += t1 - t0;

    const stats = store.stats();
    totalBytes += stats.totalChunkBytes;
    totalLogs += stats.totalLogs;
    totalInput += p.corpus.text.length;
    totalTemplates += policy.drain.templateCount();

    perCorpus.push({
      corpus: p.corpus.name,
      codec: "isolated_runs",
      inputBytes: p.corpus.text.length,
      outputBytes: stats.totalChunkBytes,
      logCount: stats.totalLogs,
      bytesPerLog: bytesPerLog(stats.totalChunkBytes, stats.totalLogs),
      ratioVsRaw: ratioFn(p.corpus.text.length, stats.totalChunkBytes),
      ratioVsNdjson: ratioFn(p.corpus.ndjson.length, stats.totalChunkBytes),
      encodeMillis: t1 - t0,
    });

    // Round-trip check.
    let rt = 0;
    for (const { records } of store.iterRecords()) rt += records.length;
    if (rt !== stats.totalLogs) {
      throw new Error(
        `isolated_runs: count mismatch ${rt} vs ${stats.totalLogs} for ${p.corpus.name}`
      );
    }
  }

  const totalRawNdjson = prepared.reduce((s, p) => s + p.corpus.ndjson.length, 0);
  const aggregate: CompressionResult = {
    corpus: "ALL",
    codec: "isolated_runs",
    inputBytes: totalInput,
    outputBytes: totalBytes,
    logCount: totalLogs,
    bytesPerLog: bytesPerLog(totalBytes, totalLogs),
    ratioVsRaw: ratioFn(totalInput, totalBytes),
    ratioVsNdjson: ratioFn(totalRawNdjson, totalBytes),
    encodeMillis: totalEncodeMs,
  };
  return { perCorpus, aggregate, totalTemplates };
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) {
    throw new Error("No corpora present at bench/corpora/loghub-2k/.");
  }
  const prepared = prepare(corpora);

  // 1. shared_drain — one DrainChunkPolicy across all streams.
  const sharedPolicyHolder: { policy?: DrainChunkPolicy } = {};
  const sharedOutcome = runOneStore("shared_drain", prepared, () => {
    const policy = new DrainChunkPolicy({ bodyCodec: "zstd-19" });
    sharedPolicyHolder.policy = policy;
    return {
      store: new LogStore({
        registry: makeRegistry(),
        policy,
        rowsPerChunk: 1024,
      }),
      getTemplateCount: () => policy.drain.templateCount(),
    };
  });

  // 2. per_stream_drain — fresh DrainChunkPolicy per stream via factory.
  const policies: DrainChunkPolicy[] = [];
  const perStreamOutcome = runOneStore("per_stream_drain", prepared, () => {
    return {
      store: new LogStore({
        registry: makeRegistry(),
        policyFactory: () => {
          const p = new DrainChunkPolicy({ bodyCodec: "zstd-19" });
          policies.push(p);
          return p;
        },
        rowsPerChunk: 1024,
      }),
      getTemplateCount: () => policies.reduce((s, p) => s + p.drain.templateCount(), 0),
    };
  });

  // 3. isolated_runs — one LogStore per corpus.
  const isolatedOutcome = runIsolated(prepared);

  const compression: CompressionResult[] = [
    ...sharedOutcome.perCorpus,
    sharedOutcome.aggregate,
    ...perStreamOutcome.perCorpus,
    perStreamOutcome.aggregate,
    ...isolatedOutcome.perCorpus,
    isolatedOutcome.aggregate,
  ];

  // Append a synthetic row carrying the template counts in `logCount`
  // so the JSON output preserves the data without changing the schema.
  const templateRows: CompressionResult[] = [
    {
      corpus: "TEMPLATES",
      codec: "shared_drain",
      inputBytes: 0,
      outputBytes: 0,
      logCount: sharedOutcome.totalTemplates,
      bytesPerLog: 0,
      ratioVsRaw: 0,
      ratioVsNdjson: 0,
      encodeMillis: 0,
    },
    {
      corpus: "TEMPLATES",
      codec: "per_stream_drain",
      inputBytes: 0,
      outputBytes: 0,
      logCount: perStreamOutcome.totalTemplates,
      bytesPerLog: 0,
      ratioVsRaw: 0,
      ratioVsNdjson: 0,
      encodeMillis: 0,
    },
    {
      corpus: "TEMPLATES",
      codec: "isolated_runs",
      inputBytes: 0,
      outputBytes: 0,
      logCount: isolatedOutcome.totalTemplates,
      bytesPerLog: 0,
      ratioVsRaw: 0,
      ratioVsNdjson: 0,
      encodeMillis: 0,
    },
  ];

  return buildReport("per-stream-drain", [...compression, ...templateRows]);
}
