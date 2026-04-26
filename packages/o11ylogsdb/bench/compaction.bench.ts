/**
 * compaction — measures cost + benefit of cold-tier promotion.
 *
 * Build a 500K-record store at body codec z3 (the M5 hot-tier
 * default). Then compact every chunk to z9 and to z19. Report:
 *   - Storage delta (B/log before vs after)
 *   - Wall-clock cost per chunk + aggregate
 *   - Round-trip correctness (decode the compacted chunks back
 *     and verify record content matches the original z3 chunks)
 *
 * The expectation from Experiments T and U: storage drops 25 % at
 * z3→z19, cost is ~ZSTD-19 encode time per chunk = ~50–150 ms
 * depending on corpus.
 *
 * Validation:
 *   - Same record count after compaction.
 *   - First N records' body content matches between old + new
 *     chunks (modulo Drain whitespace normalization, same as the
 *     other engine benches).
 *
 * If round-trip fails the compaction primitive is broken.
 */

import { performance } from "node:perf_hooks";
import {
  compactChunk,
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  type LogRecord,
  LogStore,
  type Resource,
  readRecords,
  TypedColumnarDrainPolicy,
  ZstdCodec,
} from "../dist/index.js";
import { type Corpus, loadAllAvailable } from "./corpora.js";

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };
const TARGET_RECORDS = 500_000;

function buildResource(name: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: name.toLowerCase() },
      { key: "service.instance.id", value: `${name.toLowerCase()}-0` },
    ],
  };
}

function buildStore(corpus: Corpus, bodyCodec: string): LogStore {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec }),
    rowsPerChunk: 4096,
  });
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const lineCount = lines.length;
  const resource = buildResource(corpus.name);
  for (let i = 0; i < TARGET_RECORDS; i++) {
    store.append(resource, SCOPE, {
      timeUnixNano: BigInt(i) * 1_000_000_000n,
      severityNumber: 9,
      severityText: "INFO",
      body: lines[i % lineCount] as string,
      attributes: [],
    });
  }
  store.flush();
  return store;
}

interface CompactionResult {
  corpus: string;
  fromCodec: string;
  toCodec: string;
  chunkCount: number;
  inputBytes: number;
  outputBytes: number;
  bytesPerLogBefore: number;
  bytesPerLogAfter: number;
  ratioReduction: number;
  totalDecodeMs: number;
  totalEncodeMs: number;
  totalCompactMs: number;
  meanCompactMsPerChunk: number;
  roundTripOk: boolean;
}

function compactStore(corpus: Corpus, fromCodec: string, toCodec: string): CompactionResult {
  // Build at the source codec (force a fresh policy so chunks have
  // codecName == fromCodec).
  const store = buildStore(corpus, fromCodec);
  const policy = new TypedColumnarDrainPolicy({ bodyCodec: toCodec });
  const registry = defaultRegistry()
    .register(new GzipCodec(6))
    .register(new ZstdCodec(3))
    .register(new ZstdCodec(9))
    .register(new ZstdCodec(19));

  // Snapshot first 8 records of first chunk for round-trip validation.
  const streamId = store.streams.ids()[0] as number;
  const originalChunks = [...store.streams.chunksOf(streamId)];
  const firstChunk = originalChunks[0] as import("../dist/index.js").Chunk;
  const originalRecords = readRecords(firstChunk, registry, policy);

  // Compact every chunk.
  let inputBytes = 0;
  let outputBytes = 0;
  let totalDecodeMs = 0;
  let totalEncodeMs = 0;
  const compactedChunks: import("../dist/index.js").Chunk[] = [];
  const t0 = performance.now();
  for (const chunk of originalChunks) {
    const { chunk: newChunk, stats } = compactChunk(chunk, registry, toCodec);
    compactedChunks.push(newChunk);
    inputBytes += stats.inputBytes;
    outputBytes += stats.outputBytes;
    totalDecodeMs += stats.decodeMillis;
    totalEncodeMs += stats.encodeMillis;
  }
  const totalCompactMs = performance.now() - t0;

  // Round-trip first chunk: read records from compacted version,
  // compare to originals.
  const compactedFirst = compactedChunks[0] as import("../dist/index.js").Chunk;
  const compactedRecords = readRecords(compactedFirst, registry, policy);
  let roundTripOk = compactedRecords.length === originalRecords.length;
  if (roundTripOk) {
    const checkN = Math.min(8, compactedRecords.length);
    for (let i = 0; i < checkN; i++) {
      const a = (originalRecords[i] as LogRecord).body;
      const b = (compactedRecords[i] as LogRecord).body;
      if (a !== b) {
        roundTripOk = false;
        process.stderr.write(
          `  ROUND-TRIP FAILED ${corpus.name} ${fromCodec}->${toCodec} record ${i}\n` +
            `    expected: ${JSON.stringify(a).slice(0, 80)}\n` +
            `    got:      ${JSON.stringify(b).slice(0, 80)}\n`
        );
        break;
      }
    }
  }

  const totalRecords = store.stats().totalLogs;
  const stats = store.stats();
  const result: CompactionResult = {
    corpus: corpus.name,
    fromCodec,
    toCodec,
    chunkCount: originalChunks.length,
    inputBytes: stats.totalChunkBytes,
    outputBytes: stats.totalChunkBytes - inputBytes + outputBytes + originalChunks.length * 32, // approx; payload-only delta
    bytesPerLogBefore: inputBytes / totalRecords,
    bytesPerLogAfter: outputBytes / totalRecords,
    ratioReduction: 1 - outputBytes / inputBytes,
    totalDecodeMs,
    totalEncodeMs,
    totalCompactMs,
    meanCompactMsPerChunk: totalCompactMs / originalChunks.length,
    roundTripOk,
  };

  process.stderr.write(
    `  ${corpus.name.padEnd(11)} ${fromCodec.padEnd(8)} → ${toCodec.padEnd(8)} ` +
      `chunks=${result.chunkCount.toString().padStart(4)}  ` +
      `payload ${(inputBytes / totalRecords).toFixed(2).padStart(5)} → ${(outputBytes / totalRecords).toFixed(2).padStart(5)} B/log ` +
      `(${((1 - outputBytes / inputBytes) * 100).toFixed(0).padStart(3)}% saved)  ` +
      `${result.totalCompactMs.toFixed(0).padStart(5)} ms total ` +
      `${result.meanCompactMsPerChunk.toFixed(1).padStart(4)} ms/chunk  ` +
      `roundTrip=${roundTripOk ? "✓" : "✗"}\n`
  );

  return result;
}

const PAIRS: Array<{ from: string; to: string }> = [
  { from: "zstd-3", to: "zstd-9" },
  { from: "zstd-3", to: "zstd-19" },
  { from: "zstd-9", to: "zstd-19" },
];

export default async function run() {
  const corpora = loadAllAvailable("2k");
  const targets = ["Apache", "OpenStack"]
    .map((n) => corpora.find((c) => c.name === n))
    .filter((c): c is Corpus => !!c);
  const results: CompactionResult[] = [];
  for (const corpus of targets) {
    for (const pair of PAIRS) {
      results.push(compactStore(corpus, pair.from, pair.to));
    }
  }
  return {
    module: "compaction",
    timestamp: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? null,
    node: process.version,
    results,
  };
}
