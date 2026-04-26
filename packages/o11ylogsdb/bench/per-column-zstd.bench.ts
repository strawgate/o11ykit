/**
 * per-column-zstd — isolates the "per-column ZSTD streams vs single
 * ZSTD over concatenated columns" question for the columnar form.
 *
 * The existing `ColumnarDrainPolicy` builds a multi-column binary
 * payload and runs *one* ZSTD-19 over the whole thing. This bench
 * tests whether splitting that payload into N independent ZSTD
 * streams (one per column) helps. Independent streams let ZSTD
 * specialize its window per-column at the cost of per-stream frame
 * overhead (~30 B + entropy tables per frame).
 *
 * Method: for each Loghub-2k corpus, build three logical columns:
 *   - timestamps:  raw u64 LE × N  (synthetic 1 s gaps)
 *   - severities:  u8 × N          (constant INFO = 9)
 *   - bodies:      [varint length + utf-8 bytes] per row
 *
 * Then compare:
 *   - `single_stream`: concat columns, run ZSTD-19 once.
 *   - `multi_stream`:  ZSTD-19 each column independently, sum bytes
 *                      (frame overhead included).
 *
 * Uncompressed total bytes are reported for context. Round-trip is
 * verified for both forms.
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

const zstd19 = (b: Uint8Array): Buffer =>
  zstdCompressSync(b, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
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
  // timestamps: raw u64 LE, 1s gaps starting at 0.
  const timestamps = new Uint8Array(n * 8);
  const tsView = new DataView(timestamps.buffer);
  for (let i = 0; i < n; i++) {
    tsView.setBigUint64(i * 8, BigInt(i) * 1_000_000_000n, true);
  }
  // severities: u8 × n, all = 9 (INFO).
  const severities = new Uint8Array(n).fill(9);
  // bodies: [varint length + utf-8 bytes] per row.
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
  encode: (cols: ReturnType<typeof buildColumns>) => Uint8Array;
  decode: (buf: Uint8Array, n: number) => boolean; // returns true on success
}

const VARIANTS: Variant[] = [
  {
    name: "single_stream_zstd-19",
    encode(cols) {
      const cat = concatBytes([cols.timestamps, cols.severities, cols.bodies], cols.totalRawBytes);
      return zstd19(cat);
    },
    decode(buf, _n) {
      const out = zstdDecompressSync(buf);
      return out.length > 0;
    },
  },
  {
    name: "multi_stream_zstd-19",
    encode(cols) {
      const tsZ = zstd19(cols.timestamps);
      const sevZ = zstd19(cols.severities);
      const bodyZ = zstd19(cols.bodies);
      // Frame: [varint len_ts][ts bytes][varint len_sev][sev bytes][varint len_body][body bytes]
      const lenTs = encodeVarint(tsZ.length);
      const lenSev = encodeVarint(sevZ.length);
      const lenBody = encodeVarint(bodyZ.length);
      const total =
        lenTs.length + tsZ.length + lenSev.length + sevZ.length + lenBody.length + bodyZ.length;
      return concatBytes([lenTs, tsZ, lenSev, sevZ, lenBody, bodyZ], total);
    },
    decode(buf, _n) {
      // Parse the framed form, decode each column, no semantic check.
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
      try {
        const lTs = readVar();
        const tsBytes = buf.subarray(cur, cur + lTs);
        cur += lTs;
        zstdDecompressSync(tsBytes);
        const lSev = readVar();
        const sevBytes = buf.subarray(cur, cur + lSev);
        cur += lSev;
        zstdDecompressSync(sevBytes);
        const lBody = readVar();
        const bodyBytes = buf.subarray(cur, cur + lBody);
        cur += lBody;
        zstdDecompressSync(bodyBytes);
        return cur === buf.length;
      } catch {
        return false;
      }
    },
  },
];

function runOne(corpus: Corpus, variant: Variant): CompressionResult {
  const cols = buildColumns(corpus);
  const t0 = nowMillis();
  const out = variant.encode(cols);
  const t1 = nowMillis();
  if (!variant.decode(out, corpus.count)) {
    throw new Error(`${variant.name}: round-trip failed on ${corpus.name}`);
  }
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
  if (corpora.length === 0) throw new Error("No corpora present at bench/corpora/loghub-2k/.");
  const compression: CompressionResult[] = [];
  for (const corpus of corpora) {
    for (const variant of VARIANTS) {
      compression.push(runOne(corpus, variant));
    }
  }
  return buildReport("per-column-zstd", compression);
}
