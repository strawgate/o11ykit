/**
 * Competitive compression benchmark.
 *
 * Compares our XOR-delta codec against practical alternatives a browser
 * developer would actually reach for. Same test vectors, same machine,
 * fair fight.
 *
 * Competitors:
 *   1. raw       — Float64Array (16 bytes/pt), the do-nothing baseline
 *   2. json      — JSON.stringify, what most people actually do
 *   3. gzip-raw  — gzip on raw Float64Array bytes (free via Node zlib)
 *   4. xor-delta — our codec
 *   5. xor+gzip  — our codec output + gzip (the VM strategy)
 *
 * This is NOT a TSDB comparison — it's a codec/storage-format comparison.
 * We're answering: "what compression options exist in JS/browser, and
 * where does our specialized codec sit?"
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
  constants as zlibConstants,
} from "node:zlib";
import type { BenchReport } from "./harness.js";
import { printReport, Suite } from "./harness.js";
import type { ChunkData } from "./vectors.js";
import { allGenerators } from "./vectors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load our codec ───────────────────────────────────────────────────

const codecPath = join(__dirname, "..", "..", "dist", "codec.js");
const { encodeChunk, decodeChunk } = await import(codecPath);

// ── Competitor implementations ───────────────────────────────────────

/** 1. Raw: just the typed arrays, no compression. */
function rawEncode(data: ChunkData): Uint8Array {
  // Interleave ts (as float64 for simplicity) + values into one buffer.
  const buf = new ArrayBuffer(data.timestamps.length * 16);
  const f64 = new Float64Array(buf);
  for (let i = 0; i < data.timestamps.length; i++) {
    f64[i * 2] = Number(data.timestamps[i]!);
    f64[i * 2 + 1] = data.values[i]!;
  }
  return new Uint8Array(buf);
}

function rawDecode(
  buf: Uint8Array,
  n: number
): { timestamps: BigInt64Array; values: Float64Array } {
  const f64 = new Float64Array(buf.buffer, buf.byteOffset, n * 2);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    timestamps[i] = BigInt(Math.round(f64[i * 2]!));
    values[i] = f64[i * 2 + 1]!;
  }
  return { timestamps, values };
}

/** 2. JSON: what people actually do. */
function jsonEncode(data: ChunkData): Uint8Array {
  const obj = {
    timestamps: Array.from(data.timestamps, (t) => Number(t)),
    values: Array.from(data.values),
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

function jsonDecode(buf: Uint8Array): { timestamps: BigInt64Array; values: Float64Array } {
  const obj = JSON.parse(new TextDecoder().decode(buf));
  return {
    timestamps: BigInt64Array.from(obj.timestamps, (t: number) => BigInt(t)),
    values: Float64Array.from(obj.values),
  };
}

/** 3. Gzip on raw bytes. */
function gzipRawEncode(data: ChunkData): Uint8Array {
  const raw = rawEncode(data);
  return gzipSync(raw, { level: 6 });
}

function gzipRawDecode(
  buf: Uint8Array,
  n: number
): { timestamps: BigInt64Array; values: Float64Array } {
  const raw = gunzipSync(buf);
  return rawDecode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), n);
}

/** 3b. Brotli on raw bytes (available in Node 12+ natively). */
function brotliRawEncode(data: ChunkData): Uint8Array {
  const raw = rawEncode(data);
  return brotliCompressSync(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
}

function brotliRawDecode(
  buf: Uint8Array,
  n: number
): { timestamps: BigInt64Array; values: Float64Array } {
  const raw = brotliDecompressSync(buf);
  return rawDecode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), n);
}

/** 3c. Brotli on XOR-delta output. */
function xorBrotliEncode(data: ChunkData): Uint8Array {
  const xor = encodeChunk(data.timestamps, data.values);
  return brotliCompressSync(xor, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
}

function xorBrotliDecode(buf: Uint8Array): { timestamps: BigInt64Array; values: Float64Array } {
  const xor = brotliDecompressSync(buf);
  return decodeChunk(new Uint8Array(xor.buffer, xor.byteOffset, xor.byteLength));
}

/** 4. Our XOR-delta codec (already imported). */
function xorEncode(data: ChunkData): Uint8Array {
  return encodeChunk(data.timestamps, data.values);
}

function xorDecode(buf: Uint8Array): { timestamps: BigInt64Array; values: Float64Array } {
  return decodeChunk(buf);
}

/** 5. XOR-delta + gzip (the VictoriaMetrics strategy). */
function xorGzipEncode(data: ChunkData): Uint8Array {
  const xor = encodeChunk(data.timestamps, data.values);
  return gzipSync(xor, { level: 6 });
}

function xorGzipDecode(buf: Uint8Array): { timestamps: BigInt64Array; values: Float64Array } {
  const xor = gunzipSync(buf);
  return decodeChunk(new Uint8Array(xor.buffer, xor.byteOffset, xor.byteLength));
}

// ── Competitor registry ──────────────────────────────────────────────

interface Competitor {
  name: string;
  encode: (data: ChunkData) => Uint8Array;
  decode: (buf: Uint8Array, n: number) => { timestamps: BigInt64Array; values: Float64Array };
  /** Does decode need the sample count? (raw/gzip-raw do, xor doesn't) */
  needsCount: boolean;
}

const competitors: Competitor[] = [
  { name: "raw", encode: rawEncode, decode: rawDecode, needsCount: true },
  { name: "json", encode: jsonEncode, decode: (buf) => jsonDecode(buf), needsCount: false },
  {
    name: "gzip-raw",
    encode: gzipRawEncode,
    decode: (buf, n) => gzipRawDecode(buf, n),
    needsCount: true,
  },
  {
    name: "brotli-raw",
    encode: brotliRawEncode,
    decode: (buf, n) => brotliRawDecode(buf, n),
    needsCount: true,
  },
  { name: "xor-delta", encode: xorEncode, decode: (buf) => xorDecode(buf), needsCount: false },
  {
    name: "xor+gzip",
    encode: xorGzipEncode,
    decode: (buf) => xorGzipDecode(buf),
    needsCount: false,
  },
  {
    name: "xor+brotli",
    encode: xorBrotliEncode,
    decode: (buf) => xorBrotliDecode(buf),
    needsCount: false,
  },
];

// ── Main ─────────────────────────────────────────────────────────────

export default async function (): Promise<BenchReport> {
  const suite = new Suite("competitive");
  const generators = allGenerators(1024);

  console.log("  Competitors:", competitors.map((c) => c.name).join(", "));
  console.log();

  // ── Compression comparison table (custom, not the suite's) ──
  console.log("  ── Compression comparison ──\n");

  // Header.
  let hdr = "    Vector".padEnd(24);
  for (const c of competitors) hdr += c.name.padStart(12);
  console.log(`${hdr}  (bytes/point)`);
  console.log(`    ${"─".repeat(hdr.length - 4 + 16)}`);

  for (const gen of generators) {
    let line = `    ${gen.name}`.padEnd(24);
    for (const c of competitors) {
      const encoded = c.encode(gen);
      const bpp = encoded.length / gen.timestamps.length;
      line += bpp.toFixed(2).padStart(12);
      // Also register in the suite for JSON output.
      suite.addCompression(
        gen.name,
        c.name,
        gen.timestamps.length,
        gen.timestamps.length * 16,
        encoded.length
      );
    }
    console.log(line);
  }
  console.log();

  // Ratio table.
  hdr = "    Vector".padEnd(24);
  for (const c of competitors) hdr += c.name.padStart(12);
  console.log(`${hdr}  (compression ratio)`);
  console.log(`    ${"─".repeat(hdr.length - 4 + 20)}`);

  for (const gen of generators) {
    let line = `    ${gen.name}`.padEnd(24);
    const rawSize = gen.timestamps.length * 16;
    for (const c of competitors) {
      const encoded = c.encode(gen);
      const ratio = rawSize / encoded.length;
      line += `${ratio.toFixed(1)}x`.padStart(12);
    }
    console.log(line);
  }
  console.log();

  // ── Encode throughput ──
  for (const c of competitors) {
    for (const gen of generators) {
      suite.add(
        `encode_${gen.name}`,
        c.name,
        () => {
          c.encode(gen);
        },
        {
          unit: "samples/sec",
          itemsPerCall: gen.timestamps.length,
          iterations: 200,
          warmup: 50,
        }
      );
    }
  }

  // ── Decode throughput ──
  for (const c of competitors) {
    for (const gen of generators) {
      const encoded = c.encode(gen);
      const n = gen.timestamps.length;
      suite.add(
        `decode_${gen.name}`,
        c.name,
        () => {
          c.decode(encoded, n);
        },
        {
          unit: "samples/sec",
          itemsPerCall: n,
          iterations: 200,
          warmup: 50,
        }
      );
    }
  }

  const report = suite.run();
  printReport(report);
  return report;
}
