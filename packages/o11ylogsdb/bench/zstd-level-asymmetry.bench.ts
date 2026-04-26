/**
 * zstd-level-asymmetry — Experiment T (per-research/production-engine-techniques.md
 * proposal). Tests whether running the body column at a lower ZSTD
 * level (faster encode) hurts ratio meaningfully when the surrounding
 * column-frame structure (timestamps, severities, kinds, template
 * dict) stays at level 19.
 *
 * Hypothesis: the body column dominates encode time but its ratio
 * plateaus at level ~3–5; body @ z3 with rest @ z19 should land
 * within ~2% of fully-z19 storage at 5–10× faster encode.
 *
 * Method: takes the existing 3-column form from per-column-zstd.bench
 * (timestamps u64 LE × N, severities u8 × N, bodies length-prefixed
 * utf-8). For each Loghub-2k corpus, runs four configurations:
 *
 *   - all_z19         baseline; everything at zstd-19
 *   - body_z3         body at zstd-3; timestamps + severities at z19
 *   - body_z5         body at zstd-5; rest at z19
 *   - body_z9         body at zstd-9; rest at z19
 *
 * Reports the storage delta (vs all_z19) and total encode time.
 *
 * If body_z3 lands within 2% of all_z19 at >5× faster encode, the
 * recommendation is: ship body at zstd-3 by default, leave the
 * structural columns at zstd-19. Saves substantial ingest CPU on the
 * hot path; almost no storage cost.
 */

import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { type Corpus, loadAllAvailable } from "./corpora.js";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

const zstd =
  (level: number) =>
  (b: Uint8Array): Buffer =>
    zstdCompressSync(b, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: level },
    });

function buildColumns(corpus: Corpus): {
  timestamps: Uint8Array;
  severities: Uint8Array;
  bodies: Uint8Array;
  totalRawBytes: number;
} {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const n = lines.length;
  const timestamps = new Uint8Array(n * 8);
  const tsView = new DataView(timestamps.buffer);
  for (let i = 0; i < n; i++) {
    tsView.setBigUint64(i * 8, BigInt(i) * 1_000_000_000n, true);
  }
  const severities = new Uint8Array(n).fill(9);
  const enc = new TextEncoder();
  const bodyParts: Uint8Array[] = [];
  let bodyTotal = 0;
  for (const line of lines) {
    const bytes = enc.encode(line);
    const lenVar = encodeVarint(bytes.length);
    bodyParts.push(lenVar, bytes);
    bodyTotal += lenVar.length + bytes.length;
  }
  const bodies = concatBytes(bodyParts, bodyTotal);
  return {
    timestamps,
    severities,
    bodies,
    totalRawBytes: timestamps.length + severities.length + bodies.length,
  };
}

function encodeVarint(n: number): Uint8Array {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n & 0x7f);
  return new Uint8Array(out);
}

function concatBytes(parts: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let cur = 0;
  for (const p of parts) {
    out.set(p, cur);
    cur += p.length;
  }
  return out;
}

interface Variant {
  name: string;
  bodyLevel: number;
  structureLevel: number;
}

const VARIANTS: Variant[] = [
  { name: "all_zstd-19", bodyLevel: 19, structureLevel: 19 },
  { name: "body_zstd-3_other_zstd-19", bodyLevel: 3, structureLevel: 19 },
  { name: "body_zstd-5_other_zstd-19", bodyLevel: 5, structureLevel: 19 },
  { name: "body_zstd-9_other_zstd-19", bodyLevel: 9, structureLevel: 19 },
  { name: "body_zstd-19_other_zstd-3", bodyLevel: 19, structureLevel: 3 },
];

function frameMultiStream(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  const lengths = parts.map((p) => {
    const lp = encodeVarint(p.length);
    total += lp.length + p.length;
    return lp;
  });
  const out = new Uint8Array(total);
  let cur = 0;
  for (let i = 0; i < parts.length; i++) {
    const lp = lengths[i] as Uint8Array;
    out.set(lp, cur);
    cur += lp.length;
    out.set(parts[i] as Uint8Array, cur);
    cur += (parts[i] as Uint8Array).length;
  }
  return out;
}

function runOne(corpus: Corpus, variant: Variant): CompressionResult {
  const cols = buildColumns(corpus);
  const bodyZ = zstd(variant.bodyLevel);
  const structZ = zstd(variant.structureLevel);
  const t0 = nowMillis();
  const tsZ = structZ(cols.timestamps);
  const sevZ = structZ(cols.severities);
  const bodyZb = bodyZ(cols.bodies);
  const out = frameMultiStream([tsZ, sevZ, bodyZb]);
  const t1 = nowMillis();

  // Round-trip verify.
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let cur = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = view.getUint8(cur++);
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return v;
  };
  for (let i = 0; i < 3; i++) {
    const len = readVar();
    const slice = out.subarray(cur, cur + len);
    zstdDecompressSync(slice);
    cur += len;
  }
  if (cur !== out.length) throw new Error(`${variant.name}: round-trip length mismatch`);

  return {
    corpus: corpus.name,
    codec: variant.name,
    inputBytes: cols.totalRawBytes,
    outputBytes: out.length,
    logCount: corpus.count,
    bytesPerLog: bytesPerLog(out.length, corpus.count),
    ratioVsRaw: ratioFn(corpus.text.length, out.length),
    ratioVsNdjson: ratioFn(corpus.ndjson.length, out.length),
    encodeMillis: t1 - t0,
  };
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) throw new Error("No corpora present.");
  const compression: CompressionResult[] = [];
  for (const corpus of corpora) {
    for (const variant of VARIANTS) {
      compression.push(runOne(corpus, variant));
    }
  }
  return buildReport("zstd-level-asymmetry", compression);
}
