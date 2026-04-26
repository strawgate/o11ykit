/**
 * Cross-chunk shared ZSTD dictionary benchmark.
 *
 * Validation question: can a per-stream ZSTD dictionary, built from
 * the *raw bytes* of chunk 0, be reused across subsequent chunks to
 * recover the compression that a single-large-corpus ZSTD-19 would
 * achieve? PLAN.md's M5 currently rejects this on streaming-decode
 * complexity grounds, but the empirical win-size has never been
 * measured.
 *
 * Distinction from Experiments A and C: those measured *trained*
 * dictionaries (`zstd --train` style entropy/symbol training). This
 * experiment uses the raw bytes of chunk 0 as the dict, which the
 * `zstd` CLI's `-D <file>` flag treats as a prepended LZ77 history
 * window. The hypothesis is that the LZ77 window matters for
 * cross-chunk reuse; the entropy training does not.
 *
 * Three configurations per corpus:
 *
 *   1. `per_chunk_zstd-19`     — each chunk compressed independently,
 *                                 sum of compressed bytes. The current
 *                                 default in o11ylogsdb.
 *   2. `shared_dict_zstd-19`   — chunk 0 raw bytes used as the dict
 *                                 for chunks 1..N-1. Chunk 0 itself
 *                                 is compressed plainly. Sum of
 *                                 compressed bytes. The proposed M5
 *                                 lever.
 *   3. `single_zstd-19_all`    — concatenate all chunks' bytes,
 *                                 compress as one input. Lower bound:
 *                                 what ZSTD-19's LZ77 would do given
 *                                 the whole corpus.
 *
 * Implementation note: we use the `zstd` CLI via subprocess. Node 24
 * before 24.6.0 silently ignores the `dictionary` option to
 * `zstdCompressSync` (PR nodejs/node#59240, merged 2025-08-04, ships
 * in 24.6.0). The packaged `zstd` CLI v1.5.7 honors `-D <file>` for
 * raw-content dictionaries, which is what we need. Per-chunk and
 * single configs go through the same CLI for apples-to-apples timing.
 *
 * Round-trip verification: every chunk is decompressed back through
 * the matching codec config and verified byte-equal to the input.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CorpusName, loadAllAvailable } from "./corpora.js";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

const ZSTD_LEVEL = "19";

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

/** Spawn `zstd` to compress `input`, optionally with a raw-content dict. */
function zstdCompress(workDir: string, input: Buffer, dictPath?: string): Buffer {
  const inPath = join(workDir, `in_${Math.random().toString(36).slice(2)}.bin`);
  const outPath = `${inPath}.zst`;
  writeFileSync(inPath, input);
  const args = ["-q", `-${ZSTD_LEVEL}`, "-f"];
  if (dictPath) args.push("-D", dictPath);
  args.push("-o", outPath, inPath);
  const r = spawnSync("zstd", args, { encoding: "buffer" });
  if (r.status !== 0) {
    throw new Error(`zstd compress failed: ${r.stderr?.toString() ?? "(no stderr)"}`);
  }
  const out = readFileSync(outPath);
  rmSync(inPath, { force: true });
  rmSync(outPath, { force: true });
  return out;
}

function zstdDecompress(workDir: string, input: Buffer, dictPath?: string): Buffer {
  const inPath = join(workDir, `dec_${Math.random().toString(36).slice(2)}.zst`);
  const outPath = inPath.replace(/\.zst$/, ".out");
  writeFileSync(inPath, input);
  const args = ["-q", "-d", "-f"];
  if (dictPath) args.push("-D", dictPath);
  args.push("-o", outPath, inPath);
  const r = spawnSync("zstd", args, { encoding: "buffer" });
  if (r.status !== 0) {
    throw new Error(`zstd decompress failed: ${r.stderr?.toString() ?? "(no stderr)"}`);
  }
  const out = readFileSync(outPath);
  rmSync(inPath, { force: true });
  rmSync(outPath, { force: true });
  return out;
}

/** Split a Buffer of newline-delimited lines into N contiguous chunks
 *  of `recordsPerChunk` records each. Trailing remainder dropped. */
function splitChunks(text: Buffer, recordsPerChunk: number, nChunks: number): Buffer[] {
  const lines = text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const chunks: Buffer[] = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * recordsPerChunk;
    const end = start + recordsPerChunk;
    if (end > lines.length) break;
    const slice = `${lines.slice(start, end).join("\n")}\n`;
    chunks.push(Buffer.from(slice));
  }
  return chunks;
}

interface CorpusInput {
  label: string;
  text: Buffer;
  recordsPerChunk: number;
  nChunks: number;
}

function loadPinoText(): Buffer {
  const path = join(findPackageRoot(), "bench", "corpora", "synthetic", "pino_5k.ndjson");
  if (!existsSync(path)) {
    throw new Error(`Pino corpus not found at ${path}.`);
  }
  return readFileSync(path);
}

function buildInputs(): CorpusInput[] {
  const inputs: CorpusInput[] = [];
  inputs.push({
    label: "pino_5k",
    text: loadPinoText(),
    recordsPerChunk: 1000,
    nChunks: 5,
  });
  for (const c of loadAllAvailable("2k")) {
    inputs.push({
      label: c.name as CorpusName,
      text: c.text,
      recordsPerChunk: 1000,
      nChunks: 2,
    });
  }
  return inputs;
}

interface ConfigOutcome {
  outputBytes: number;
  inputBytes: number;
  encodeMillis: number;
  roundtripOk: boolean;
}

function runPerChunk(workDir: string, chunks: Buffer[]): ConfigOutcome {
  let outputBytes = 0;
  let inputBytes = 0;
  let encodeMillis = 0;
  let ok = true;
  for (const chunk of chunks) {
    inputBytes += chunk.length;
    const t0 = nowMillis();
    const out = zstdCompress(workDir, chunk);
    const t1 = nowMillis();
    encodeMillis += t1 - t0;
    outputBytes += out.length;
    const back = zstdDecompress(workDir, out);
    if (!back.equals(chunk)) ok = false;
  }
  return { outputBytes, inputBytes, encodeMillis, roundtripOk: ok };
}

function runSharedDict(workDir: string, chunks: Buffer[]): ConfigOutcome {
  if (chunks.length === 0) {
    return { outputBytes: 0, inputBytes: 0, encodeMillis: 0, roundtripOk: true };
  }
  // Persist chunk 0 as the dict file (used as raw LZ77-history bytes
  // by `zstd -D`). Chunk 0 itself is compressed plainly — it has to
  // be on the wire before any decoder can use it as a dict for later
  // chunks.
  const dictPath = join(workDir, "shared_dict_chunk0.bin");
  const dict = chunks[0] as Buffer;
  writeFileSync(dictPath, dict);

  let outputBytes = 0;
  let inputBytes = 0;
  let encodeMillis = 0;
  let ok = true;

  // Chunk 0: plain (no dict).
  inputBytes += dict.length;
  const t0a = nowMillis();
  const out0 = zstdCompress(workDir, dict);
  const t1a = nowMillis();
  encodeMillis += t1a - t0a;
  outputBytes += out0.length;
  const back0 = zstdDecompress(workDir, out0);
  if (!back0.equals(dict)) ok = false;

  // Chunks 1..N-1 with chunk 0 as dict.
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] as Buffer;
    inputBytes += chunk.length;
    const t0 = nowMillis();
    const out = zstdCompress(workDir, chunk, dictPath);
    const t1 = nowMillis();
    encodeMillis += t1 - t0;
    outputBytes += out.length;
    const back = zstdDecompress(workDir, out, dictPath);
    if (!back.equals(chunk)) ok = false;
  }

  rmSync(dictPath, { force: true });
  return { outputBytes, inputBytes, encodeMillis, roundtripOk: ok };
}

function runSingle(workDir: string, chunks: Buffer[]): ConfigOutcome {
  const all = Buffer.concat(chunks);
  const t0 = nowMillis();
  const out = zstdCompress(workDir, all);
  const t1 = nowMillis();
  const back = zstdDecompress(workDir, out);
  return {
    outputBytes: out.length,
    inputBytes: all.length,
    encodeMillis: t1 - t0,
    roundtripOk: back.equals(all),
  };
}

export default async function run() {
  // Verify zstd CLI is available.
  const probe = spawnSync("zstd", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error("zstd CLI not found on PATH. Install it (e.g. `brew install zstd`).");
  }

  const workDir = mkdtempSync(join(tmpdir(), "o11y-cross-chunk-dict-"));
  try {
    const inputs = buildInputs();
    const compression: CompressionResult[] = [];

    for (const inp of inputs) {
      const chunks = splitChunks(inp.text, inp.recordsPerChunk, inp.nChunks);
      if (chunks.length < inp.nChunks) continue;
      const totalLogs = chunks.length * inp.recordsPerChunk;
      const totalRaw = chunks.reduce((s, c) => s + c.length, 0);

      const perChunk = runPerChunk(workDir, chunks);
      const sharedDict = runSharedDict(workDir, chunks);
      const single = runSingle(workDir, chunks);

      if (!perChunk.roundtripOk) throw new Error(`per_chunk roundtrip failed on ${inp.label}`);
      if (!sharedDict.roundtripOk) throw new Error(`shared_dict roundtrip failed on ${inp.label}`);
      if (!single.roundtripOk) throw new Error(`single roundtrip failed on ${inp.label}`);

      const mkRow = (codec: string, o: ConfigOutcome): CompressionResult => ({
        corpus: inp.label,
        codec,
        inputBytes: o.inputBytes,
        outputBytes: o.outputBytes,
        logCount: totalLogs,
        bytesPerLog: bytesPerLog(o.outputBytes, totalLogs),
        ratioVsRaw: ratioFn(totalRaw, o.outputBytes),
        ratioVsNdjson: ratioFn(totalRaw, o.outputBytes),
        encodeMillis: o.encodeMillis,
      });

      compression.push(mkRow("per_chunk_zstd-19", perChunk));
      compression.push(mkRow("shared_dict_zstd-19", sharedDict));
      compression.push(mkRow("single_zstd-19_all", single));
    }

    return buildReport("cross-chunk-dict", compression);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
