/**
 * Baseline codec implementations — Node built-ins, no external deps.
 *
 * These are *correctness-first*, not performance-first. They give the
 * engine a working pipeline so experiments can plug in real codecs
 * (FSST, Drain-templated, ALP) and measure relative wins. The defaults
 * are also what the bench harness measures as a reference floor.
 *
 * For environments without `node:zlib` (e.g. browsers), wire in
 * `pako`/`fflate` and a JS zstd port behind the same `Codec` interface.
 */

import {
  gunzipSync,
  gzipSync,
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import { type Codec, CodecRegistry, type IntCodec, type StringCodec } from "./codec.js";

// ── Bytes codecs ─────────────────────────────────────────────────────

export const rawCodec: Codec = {
  name: "raw",
  encode: (b) => b,
  decode: (b) => b,
};

export class GzipCodec implements Codec {
  readonly name: string;
  readonly meta: Readonly<{ level: number }>;
  constructor(level = 6) {
    this.name = `gzip-${level}`;
    this.meta = { level };
  }
  encode(b: Uint8Array): Uint8Array {
    return gzipSync(b, { level: this.meta.level });
  }
  decode(b: Uint8Array): Uint8Array {
    return gunzipSync(b);
  }
}

export class ZstdCodec implements Codec {
  readonly name: string;
  readonly meta: Readonly<{ level: number }>;
  constructor(level = 3) {
    this.name = `zstd-${level}`;
    this.meta = { level };
  }
  encode(b: Uint8Array): Uint8Array {
    return zstdCompressSync(b, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: this.meta.level },
    });
  }
  decode(b: Uint8Array): Uint8Array {
    return zstdDecompressSync(b);
  }
}

// ── String codecs ────────────────────────────────────────────────────

/**
 * Length-prefixed concatenation: `[u32 LE length][bytes]` per string.
 * Round-trip safe; no compression. Reference baseline for the per-row
 * decode path that FSST will eventually own.
 */
export const lengthPrefixStringCodec: StringCodec = {
  name: "length-prefix",
  randomAccess: false,
  encodeBatch(strings) {
    const enc = new TextEncoder();
    const parts = strings.map((s) => enc.encode(s));
    const totalLen = parts.reduce((s, p) => s + 4 + p.length, 0);
    const out = new Uint8Array(totalLen);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let cursor = 0;
    for (const p of parts) {
      view.setUint32(cursor, p.length, true);
      cursor += 4;
      out.set(p, cursor);
      cursor += p.length;
    }
    return out;
  },
  decodeBatch(input) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const dec = new TextDecoder();
    const out: string[] = [];
    let cursor = 0;
    while (cursor < input.length) {
      // Codec input may come from on-disk / network state. Validate
      // boundaries so truncation throws a descriptive error rather than
      // an opaque DataView RangeError.
      if (cursor + 4 > input.length) {
        throw new RangeError(`length-prefix: truncated length prefix at offset ${cursor}`);
      }
      const len = view.getUint32(cursor, true);
      cursor += 4;
      if (cursor + len > input.length) {
        throw new RangeError(
          `length-prefix: truncated string payload at offset ${cursor} (need ${len} bytes, have ${input.length - cursor})`
        );
      }
      out.push(dec.decode(input.subarray(cursor, cursor + len)));
      cursor += len;
    }
    return out;
  },
};

// ── Int codecs ───────────────────────────────────────────────────────

/**
 * Raw little-endian i64 per value. 8 B/value. Reference floor.
 * Real implementation: delta-of-delta + ZigZag + FastLanes BP via
 * the shared codec workspace, when M0 lands.
 */
export const rawInt64Codec: IntCodec = {
  name: "raw-i64-le",
  encode(values) {
    const out = new Uint8Array(values.length * 8);
    const view = new DataView(out.buffer);
    for (let i = 0; i < values.length; i++) {
      view.setBigInt64(i * 8, values[i] ?? 0n, true);
    }
    return out;
  },
  decode(input) {
    if (input.length % 8 !== 0) {
      throw new RangeError(`raw-i64-le: input length ${input.length} is not a multiple of 8`);
    }
    const n = input.length / 8;
    const out = new BigInt64Array(n);
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    for (let i = 0; i < n; i++) {
      out[i] = view.getBigInt64(i * 8, true);
    }
    return out;
  },
};

/**
 * Build a registry pre-populated with the baseline codecs above.
 * Tests and benches start from this, then may register additional
 * (experimental) codecs on top.
 */
export function defaultRegistry(): CodecRegistry {
  return new CodecRegistry()
    .register(rawCodec)
    .register(new GzipCodec(6))
    .register(new GzipCodec(9))
    .register(new ZstdCodec(3))
    .register(new ZstdCodec(19))
    .registerString(lengthPrefixStringCodec)
    .registerInt(rawInt64Codec);
}
