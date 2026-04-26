/**
 * Pino-shaped KVList corpus roundtrip benchmark — Experiment G.
 *
 * Loads the synthetic Pino corpus at
 * `bench/corpora/synthetic/pino_5k.ndjson` (5 000 OTLP-shaped
 * LogRecords whose `body` is a Pino-style KVList). Compresses through
 * baseline codecs and reports bytes-per-log:
 *
 *   - `raw_ndjson`              (uncompressed; the 20× gate baseline)
 *   - `ndjson_gzip-6`
 *   - `ndjson_zstd-3`, `ndjson_zstd-19`
 *   - `body_only_zstd-19`        body JSON only, ZSTD-19 over the whole
 *                                body stream — models what the KVList
 *                                recursive-flatten path would aspire
 *                                to with a generic compressor.
 *   - `flatten_columns_zstd-19`  flatten body KVList into per-leaf-key
 *                                columns, ZSTD-19 each independently,
 *                                sum total bytes. Closest baseline
 *                                analog to PLAN.md's M4 KVList row.
 *
 * The PLAN.md target for `body/KVList — recursive flatten → per-key
 * columns` is 1.4 B/log. `flatten_columns_zstd-19` is the validating
 * measurement; if it lands much higher than 1.4 the budget needs
 * revision.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, constants as zlibConstants, zstdCompressSync } from "node:zlib";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

type CodecFn = (input: Buffer) => Buffer;

const zstd =
  (level: number): CodecFn =>
  (b) =>
    zstdCompressSync(b, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: level },
    });

const CORPUS_NAME = "pino_5k";

interface LoadedCorpus {
  /** Full OTLP-NDJSON, one envelope per line. */
  ndjson: Buffer;
  /** JSON-serialized body objects, one per line. */
  bodyNdjson: Buffer;
  /** Per-leaf-key columns (key path → newline-joined values). */
  columns: Map<string, Buffer>;
  /** Number of records. */
  count: number;
}

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

function corpusPath(): string {
  return join(findPackageRoot(), "bench", "corpora", "synthetic", "pino_5k.ndjson");
}

/**
 * Recursively walk a JSON object and append leaf values to per-path
 * column buckets. `null` becomes the literal string `null`; absent
 * keys produce an empty string for that row so column lengths line
 * up by row index.
 *
 * Object containers carry no leaf value. Arrays — not used by the
 * Pino corpus — would be flattened by index; left unimplemented.
 */
function flattenInto(
  obj: unknown,
  prefix: string,
  rowIndex: number,
  columns: Map<string, string[]>,
  observedKeysThisRow: Set<string>
): void {
  if (obj === null || obj === undefined) {
    push(columns, prefix, rowIndex, "null");
    observedKeysThisRow.add(prefix);
    return;
  }
  if (typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      flattenInto(v, key, rowIndex, columns, observedKeysThisRow);
    }
    return;
  }
  // Primitive leaf.
  push(columns, prefix, rowIndex, String(obj));
  observedKeysThisRow.add(prefix);
}

function push(columns: Map<string, string[]>, key: string, rowIndex: number, value: string): void {
  let bucket = columns.get(key);
  if (!bucket) {
    bucket = [];
    columns.set(key, bucket);
  }
  // Pad with empty strings if this column is seeing its first row late
  // (i.e. a key appeared mid-corpus). Pino bodies are uniform-shape so
  // this branch is mostly cold.
  while (bucket.length < rowIndex) bucket.push("");
  bucket.push(value);
}

function loadCorpus(): LoadedCorpus {
  const path = corpusPath();
  if (!existsSync(path)) {
    throw new Error(
      `Pino corpus not found at ${path}. ` +
        `Generate it with: python3 bench/scripts/generate-pino-corpus.py`
    );
  }
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);

  const bodies: string[] = [];
  const columns = new Map<string, string[]>();

  for (let i = 0; i < lines.length; i++) {
    const env = JSON.parse(lines[i] as string) as { body: unknown };
    bodies.push(JSON.stringify(env.body));
    const seen = new Set<string>();
    flattenInto(env.body, "", i, columns, seen);
  }

  // Pad any short columns to the row count so column-length is uniform.
  for (const bucket of columns.values()) {
    while (bucket.length < lines.length) bucket.push("");
  }

  const ndjson = Buffer.from(`${lines.join("\n")}\n`);
  const bodyNdjson = Buffer.from(`${bodies.join("\n")}\n`);
  const cols = new Map<string, Buffer>();
  for (const [k, v] of columns.entries()) {
    cols.set(k, Buffer.from(`${v.join("\n")}\n`));
  }

  return { ndjson, bodyNdjson, columns: cols, count: lines.length };
}

function record(
  codec: string,
  inputBytes: number,
  outputBytes: number,
  count: number,
  rawNdjsonBytes: number,
  encodeMillis: number
): CompressionResult {
  return {
    corpus: CORPUS_NAME,
    codec,
    inputBytes,
    outputBytes,
    logCount: count,
    bytesPerLog: bytesPerLog(outputBytes, count),
    // No "raw text" form for this corpus — bodies are JSON, not log
    // lines. Use NDJSON as the both numerator slots so the harness
    // table renders consistently.
    ratioVsRaw: ratioFn(rawNdjsonBytes, outputBytes),
    ratioVsNdjson: ratioFn(rawNdjsonBytes, outputBytes),
    encodeMillis,
  };
}

export default async function run() {
  const corpus = loadCorpus();
  const compression: CompressionResult[] = [];
  const ndjsonBytes = corpus.ndjson.length;

  // 1. raw_ndjson — the 20× gate baseline.
  compression.push(record("raw_ndjson", ndjsonBytes, ndjsonBytes, corpus.count, ndjsonBytes, 0));

  // 2. ndjson_gzip-6
  {
    const t0 = nowMillis();
    const out = gzipSync(corpus.ndjson, { level: 6 });
    const t1 = nowMillis();
    compression.push(
      record("ndjson_gzip-6", ndjsonBytes, out.length, corpus.count, ndjsonBytes, t1 - t0)
    );
  }

  // 3. ndjson_zstd-3
  {
    const t0 = nowMillis();
    const out = zstd(3)(corpus.ndjson);
    const t1 = nowMillis();
    compression.push(
      record("ndjson_zstd-3", ndjsonBytes, out.length, corpus.count, ndjsonBytes, t1 - t0)
    );
  }

  // 4. ndjson_zstd-19
  {
    const t0 = nowMillis();
    const out = zstd(19)(corpus.ndjson);
    const t1 = nowMillis();
    compression.push(
      record("ndjson_zstd-19", ndjsonBytes, out.length, corpus.count, ndjsonBytes, t1 - t0)
    );
  }

  // 5. body_only_zstd-19 — body field extracted, compressed alone.
  {
    const t0 = nowMillis();
    const out = zstd(19)(corpus.bodyNdjson);
    const t1 = nowMillis();
    compression.push(
      record(
        "body_only_zstd-19",
        corpus.bodyNdjson.length,
        out.length,
        corpus.count,
        ndjsonBytes,
        t1 - t0
      )
    );
  }

  // 6. flatten_columns_zstd-19 — per-leaf-key columns, ZSTD-19 each, summed.
  {
    let totalIn = 0;
    let totalOut = 0;
    let totalMs = 0;
    for (const buf of corpus.columns.values()) {
      totalIn += buf.length;
      const t0 = nowMillis();
      const out = zstd(19)(buf);
      const t1 = nowMillis();
      totalOut += out.length;
      totalMs += t1 - t0;
    }
    compression.push(
      record("flatten_columns_zstd-19", totalIn, totalOut, corpus.count, ndjsonBytes, totalMs)
    );
  }

  return buildReport("pino-roundtrip", compression);
}
