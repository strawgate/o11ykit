/**
 * Bytes-per-log benchmark — the o11ylogsdb merge gate.
 *
 * For each Loghub corpus and each baseline codec, computes:
 *   - input bytes (raw text vs OTLP NDJSON)
 *   - compressed output bytes
 *   - bytes-per-log
 *   - ratio vs raw text and vs raw NDJSON
 *
 * The 20× target is measured against raw OTLP/JSON (NDJSON form).
 *
 * Codecs implemented in this baseline benchmark (Node built-ins):
 *   - raw_text                  (input as-is)
 *   - raw_ndjson                (OTLP-shaped JSON, input as-is)
 *   - text_gzip-6, text_gzip-9
 *   - text_zstd-3, text_zstd-19
 *   - ndjson_gzip-6, ndjson_zstd-19
 *
 * Per-engine codecs (FSST, Drain+ZSTD, ALP, the o11ylogsdb stack)
 * land in this file as M-series milestones complete.
 */

import { gzipSync, constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { type Corpus, loadAllAvailable } from "./corpora.js";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

type CodecFn = (input: Buffer) => Buffer;

interface CodecSpec {
  name: string;
  /** Which input form: raw text, OTLP-NDJSON, or Drain-templated. */
  input: "text" | "ndjson" | "drain";
  fn: CodecFn;
}

const zstd =
  (level: number): CodecFn =>
  (b) =>
    zstdCompressSync(b, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: level },
    });

const CODECS: CodecSpec[] = [
  { name: "raw_text", input: "text", fn: (b) => b },
  { name: "raw_ndjson", input: "ndjson", fn: (b) => b },
  { name: "text_gzip-6", input: "text", fn: (b) => gzipSync(b, { level: 6 }) },
  { name: "text_gzip-9", input: "text", fn: (b) => gzipSync(b, { level: 9 }) },
  { name: "text_zstd-3", input: "text", fn: zstd(3) },
  { name: "text_zstd-19", input: "text", fn: zstd(19) },
  { name: "ndjson_gzip-6", input: "ndjson", fn: (b) => gzipSync(b, { level: 6 }) },
  { name: "ndjson_zstd-19", input: "ndjson", fn: zstd(19) },
  // Drain-templated input: produced by `bench/scripts/generate-drain-fixtures.py`.
  // Skipped if the fixture isn't present.
  { name: "drain_gzip-6", input: "drain", fn: (b) => gzipSync(b, { level: 6 }) },
  { name: "drain_zstd-19", input: "drain", fn: zstd(19) },
];

function inputBuffer(corpus: Corpus, kind: CodecSpec["input"]): Buffer | undefined {
  switch (kind) {
    case "text":
      return corpus.text;
    case "ndjson":
      return corpus.ndjson;
    case "drain":
      return corpus.drainText;
  }
}

function measureOne(corpus: Corpus, codec: CodecSpec): CompressionResult | undefined {
  const input = inputBuffer(corpus, codec.input);
  if (!input) return undefined; // fixture absent (e.g. no drain fixture yet)
  const t0 = nowMillis();
  const output = codec.fn(input);
  const t1 = nowMillis();
  return {
    corpus: corpus.name,
    codec: codec.name,
    inputBytes: input.length,
    outputBytes: output.length,
    logCount: corpus.count,
    bytesPerLog: bytesPerLog(output.length, corpus.count),
    ratioVsRaw: ratioFn(corpus.text.length, output.length),
    ratioVsNdjson: ratioFn(corpus.ndjson.length, output.length),
    encodeMillis: t1 - t0,
  };
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) {
    throw new Error(
      "No corpora present at bench/corpora/loghub-2k/. " +
        "Run `bash bench/scripts/download-loghub.sh` to fetch."
    );
  }
  const compression: CompressionResult[] = [];
  for (const corpus of corpora) {
    for (const codec of CODECS) {
      const r = measureOne(corpus, codec);
      if (r) compression.push(r);
    }
  }
  return buildReport("bytes-per-log", compression);
}
