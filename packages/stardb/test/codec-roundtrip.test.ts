/**
 * Deterministic property-style round-trip tests.
 *
 * No `fast-check` dep — a small LCG drives the corpus so the failure
 * mode is the same on every machine. Each iteration exercises a
 * different shape (random length, random bytes, mix of empty / huge
 * strings, random i64 values incl. negatives and boundaries) and the
 * test fails on the first non-round-tripping input.
 */

import { describe, expect, it } from "vitest";

import {
  defaultRegistry,
  GzipCodec,
  lengthPrefixStringCodec,
  rawCodec,
  rawInt64Codec,
  ZstdCodec,
} from "../src/index.js";

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    // Numerical Recipes LCG — fine for property-test corpus generation.
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  range(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }
  bytes(len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.next() & 0xff;
    return out;
  }
  bigint(): bigint {
    const hi = BigInt(this.next() | 0);
    const lo = BigInt(this.next() | 0);
    return (hi << 32n) | (lo & 0xffffffffn);
  }
  /** Random unicode string up to `maxLen` codepoints. */
  string(maxLen: number): string {
    const len = this.range(maxLen);
    let s = "";
    for (let i = 0; i < len; i++) {
      // BMP only (avoid surrogate pair mid-construction); skip surrogates.
      let cp = this.range(0xfffe);
      if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x20;
      s += String.fromCodePoint(cp);
    }
    return s;
  }
}

const ITERATIONS = 64;

describe("byte codec round-trip (deterministic property test)", () => {
  it.each([
    ["raw", rawCodec],
    ["gzip-1", new GzipCodec(1)],
    ["gzip-9", new GzipCodec(9)],
    ["zstd-3", new ZstdCodec(3)],
    ["zstd-19", new ZstdCodec(19)],
  ])("%s round-trips %i random byte buffers", (_label, codec) => {
    const rng = new Lcg(0xc0ffee);
    for (let i = 0; i < ITERATIONS; i++) {
      const len = rng.range(2048);
      const input = rng.bytes(len);
      const decoded = codec.decode(codec.encode(input));
      expect(decoded.length, `iter ${i} len mismatch`).toBe(input.length);
      // Cheap content check that doesn't quadratic-blow on large arrays.
      expect(Buffer.from(decoded).equals(Buffer.from(input)), `iter ${i} content mismatch`).toBe(
        true
      );
    }
  });

  it("handles zero-length input", () => {
    for (const codec of [rawCodec, new GzipCodec(6), new ZstdCodec(3)]) {
      const decoded = codec.decode(codec.encode(new Uint8Array(0)));
      expect(decoded.length).toBe(0);
    }
  });
});

describe("string codec round-trip (deterministic property test)", () => {
  it("length-prefix round-trips random unicode batches", () => {
    const rng = new Lcg(0xfee1ed);
    for (let i = 0; i < ITERATIONS; i++) {
      const n = rng.range(32);
      const batch: string[] = [];
      for (let j = 0; j < n; j++) batch.push(rng.string(64));
      const decoded = lengthPrefixStringCodec.decodeBatch(
        lengthPrefixStringCodec.encodeBatch(batch)
      );
      expect(decoded, `iter ${i}`).toEqual(batch);
    }
  });

  it("handles a single huge string (>64 KiB)", () => {
    const huge = "x".repeat(70_000);
    const decoded = lengthPrefixStringCodec.decodeBatch(
      lengthPrefixStringCodec.encodeBatch([huge])
    );
    expect(decoded).toEqual([huge]);
  });
});

describe("int codec round-trip (deterministic property test)", () => {
  it("raw-i64-le round-trips random i64 batches", () => {
    const rng = new Lcg(0xdeadbeef);
    for (let i = 0; i < ITERATIONS; i++) {
      const n = rng.range(256);
      const input = new BigInt64Array(n);
      for (let j = 0; j < n; j++) input[j] = BigInt.asIntN(64, rng.bigint());
      const decoded = rawInt64Codec.decode(rawInt64Codec.encode(input));
      expect(Array.from(decoded), `iter ${i}`).toEqual(Array.from(input));
    }
  });
});

describe("default registry round-trip", () => {
  it("every registered byte codec round-trips a shared corpus", () => {
    const r = defaultRegistry();
    const rng = new Lcg(0x1234abcd);
    const corpus: Uint8Array[] = Array.from({ length: 16 }, () => rng.bytes(rng.range(4096)));
    for (const name of r.list().bytes) {
      const codec = r.get(name);
      for (const input of corpus) {
        const decoded = codec.decode(codec.encode(input));
        expect(Buffer.from(decoded).equals(Buffer.from(input)), `codec ${name}`).toBe(true);
      }
    }
  });
});
