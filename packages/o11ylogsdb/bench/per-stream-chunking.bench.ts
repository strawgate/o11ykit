/**
 * Per-stream chunking benchmark.
 *
 * Quantifies the "VictoriaLogs insight" referenced in PLAN.md:
 * compressing logs with stream boundaries preserved (one chunk per
 * service / resource hash) should beat compressing a single
 * mixed-streams chunk, because each stream has its own small template
 * set and the LZ77 window doesn't get diluted by other streams' tokens.
 *
 * Method:
 *   Treat the six Loghub-2k corpora as six streams from six services.
 *   For each codec:
 *     1. `mixed` — concatenate all six corpora into one input, compress.
 *     2. `per-stream` — compress each corpus separately, sum the
 *        compressed sizes.
 *   The ratio (mixed_bytes / per-stream_total_bytes) is the
 *   "per-stream win." If the claim holds, per-stream is smaller — i.e.
 *   ratio > 1.0.
 *
 * Output: `mixed` vs `per-stream` codec rows in the standard
 * CompressionResult format, plus a derived "per-stream_win" metric
 * appended to the report.
 */

import { gzipSync, constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { loadAllAvailable } from "./corpora.js";
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
  fn: CodecFn;
}

const zstd =
  (level: number): CodecFn =>
  (b) =>
    zstdCompressSync(b, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: level },
    });

const CODECS: CodecSpec[] = [
  { name: "gzip-6", fn: (b) => gzipSync(b, { level: 6 }) },
  { name: "zstd-3", fn: zstd(3) },
  { name: "zstd-19", fn: zstd(19) },
];

/** Round-robin interleave several Buffers (line-by-line) into one. */
function interleaveLines(buffers: Buffer[]): Buffer {
  const lineSets = buffers.map((b) =>
    b
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0)
  );
  const maxLen = Math.max(...lineSets.map((s) => s.length));
  const out: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    for (const set of lineSets) {
      if (i < set.length) out.push(set[i] as string);
    }
  }
  return Buffer.from(`${out.join("\n")}\n`);
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length < 2) {
    throw new Error(
      `Need at least 2 corpora for per-stream chunking comparison; have ${corpora.length}.`
    );
  }

  const compression: CompressionResult[] = [];

  const totalLogs = corpora.reduce((s, c) => s + c.count, 0);
  const totalRawText = corpora.reduce((s, c) => s + c.text.length, 0);
  const totalRawNdjson = corpora.reduce((s, c) => s + c.ndjson.length, 0);

  // Mixed forms (resource attributes inline per row, all streams interleaved).
  const mixedText = interleaveLines(corpora.map((c) => c.text));
  const mixedNdjson = interleaveLines(corpora.map((c) => c.ndjson));

  // Per-stream forms — same shapes but contiguous within stream, compressed
  // per chunk and summed. Models a realistic per-(resource, scope) chunk
  // boundary in o11ylogsdb.
  type Form = "text" | "ndjson" | "text-hoisted";
  const forms: Array<{ form: Form; mixed: Buffer; perStream: Buffer[] }> = [
    { form: "text", mixed: mixedText, perStream: corpora.map((c) => c.text) },
    { form: "ndjson", mixed: mixedNdjson, perStream: corpora.map((c) => c.ndjson) },
    {
      // text-hoisted models per-stream chunks where resource attributes are
      // hoisted into the chunk header at zero per-row cost. Each chunk is
      // `<header>\n<body lines>` where `<header>` carries the service name
      // once. This isolates the "hoisting" component from the
      // template-locality component.
      form: "text-hoisted",
      mixed: mixedNdjson, // baseline: resource attributes per-row
      perStream: corpora.map((c) =>
        Buffer.from(`SERVICE=${c.name.toLowerCase()}\n${c.text.toString("utf8")}`)
      ),
    },
  ];

  for (const { form, mixed, perStream } of forms) {
    for (const codec of CODECS) {
      // Mixed: single chunk, all rows interleaved.
      const t0m = nowMillis();
      const mOut = codec.fn(mixed);
      const t1m = nowMillis();
      compression.push({
        corpus: `mixed_${form}`,
        codec: `mixed_${form}_${codec.name}`,
        inputBytes: mixed.length,
        outputBytes: mOut.length,
        logCount: totalLogs,
        bytesPerLog: bytesPerLog(mOut.length, totalLogs),
        ratioVsRaw: ratioFn(totalRawText, mOut.length),
        ratioVsNdjson: ratioFn(totalRawNdjson, mOut.length),
        encodeMillis: t1m - t0m,
      });

      // Per-stream: compress each contiguous stream chunk separately, sum.
      let totalOut = 0;
      let totalEncodeMs = 0;
      let totalIn = 0;
      for (const buf of perStream) {
        totalIn += buf.length;
        const t0 = nowMillis();
        const out = codec.fn(buf);
        const t1 = nowMillis();
        totalOut += out.length;
        totalEncodeMs += t1 - t0;
      }
      compression.push({
        corpus: `per-stream_${form}`,
        codec: `per-stream_${form}_${codec.name}`,
        inputBytes: totalIn,
        outputBytes: totalOut,
        logCount: totalLogs,
        bytesPerLog: bytesPerLog(totalOut, totalLogs),
        ratioVsRaw: ratioFn(totalRawText, totalOut),
        ratioVsNdjson: ratioFn(totalRawNdjson, totalOut),
        encodeMillis: totalEncodeMs,
      });
    }
  }

  return buildReport("per-stream-chunking", compression);
}
