import { describe, expect, it } from "vitest";

import {
  CodecRegistry,
  defaultRegistry,
  GzipCodec,
  lengthPrefixStringCodec,
  rawCodec,
  rawInt64Codec,
  ZstdCodec,
} from "../src/index.js";

describe("rawCodec", () => {
  it("is the identity for both encode and decode", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    expect(rawCodec.encode(input)).toBe(input);
    expect(rawCodec.decode(input)).toBe(input);
  });
});

describe("GzipCodec", () => {
  it("round-trips arbitrary bytes", () => {
    const codec = new GzipCodec(6);
    const input = new TextEncoder().encode("hello world ".repeat(64));
    const encoded = codec.encode(input);
    const decoded = codec.decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(input));
  });

  it("name encodes the level", () => {
    expect(new GzipCodec(6).name).toBe("gzip-6");
    expect(new GzipCodec(9).name).toBe("gzip-9");
  });
});

describe("ZstdCodec", () => {
  it("round-trips arbitrary bytes", () => {
    const codec = new ZstdCodec(19);
    const input = new TextEncoder().encode("the quick brown fox ".repeat(32));
    const encoded = codec.encode(input);
    const decoded = codec.decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(input));
  });

  it("name encodes the level", () => {
    expect(new ZstdCodec(3).name).toBe("zstd-3");
    expect(new ZstdCodec(19).name).toBe("zstd-19");
  });
});

describe("lengthPrefixStringCodec", () => {
  it("round-trips an empty batch", () => {
    expect(lengthPrefixStringCodec.decodeBatch(lengthPrefixStringCodec.encodeBatch([]))).toEqual(
      []
    );
  });

  it("round-trips empty strings", () => {
    const input = ["", "", ""];
    const encoded = lengthPrefixStringCodec.encodeBatch(input);
    expect(lengthPrefixStringCodec.decodeBatch(encoded)).toEqual(input);
  });

  it("round-trips ascii and unicode mixes", () => {
    const input = ["hello", "world", "👋", "café", "日本語"];
    const encoded = lengthPrefixStringCodec.encodeBatch(input);
    expect(lengthPrefixStringCodec.decodeBatch(encoded)).toEqual(input);
  });

  it("rejects truncated length prefix with a descriptive error", () => {
    // Only 2 bytes — too short for the 4-byte length prefix.
    const truncated = new Uint8Array([0, 0]);
    expect(() => lengthPrefixStringCodec.decodeBatch(truncated)).toThrow(
      /length-prefix: truncated length prefix at offset 0/
    );
  });

  it("rejects truncated string payload with a descriptive error", () => {
    // Length prefix says 100 bytes, but only 5 follow.
    const buf = new Uint8Array(4 + 5);
    new DataView(buf.buffer).setUint32(0, 100, true);
    expect(() => lengthPrefixStringCodec.decodeBatch(buf)).toThrow(
      /truncated string payload at offset 4/
    );
  });
});

describe("rawInt64Codec", () => {
  it("round-trips a typical batch", () => {
    const input = new BigInt64Array([0n, 1n, -1n, 1_000_000n, -42n]);
    const encoded = rawInt64Codec.encode(input);
    const decoded = rawInt64Codec.decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(input));
  });

  it("round-trips i64 boundary values", () => {
    const input = new BigInt64Array([
      0n,
      1n,
      -1n,
      9_223_372_036_854_775_807n,
      -9_223_372_036_854_775_808n,
    ]);
    expect(Array.from(rawInt64Codec.decode(rawInt64Codec.encode(input)))).toEqual(
      Array.from(input)
    );
  });

  it("rejects input length not a multiple of 8", () => {
    const truncated = new Uint8Array(15);
    expect(() => rawInt64Codec.decode(truncated)).toThrow(/not a multiple of 8/);
  });
});

describe("CodecRegistry", () => {
  it("registers and retrieves codecs by name", () => {
    const registry = new CodecRegistry();
    registry.register(rawCodec);
    expect(registry.get("raw")).toBe(rawCodec);
    expect(registry.has("raw")).toBe(true);
  });

  it("throws with a list of known names on unknown lookup", () => {
    const registry = new CodecRegistry();
    registry.register(rawCodec);
    registry.register(new GzipCodec(6));
    expect(() => registry.get("missing")).toThrow(/Codec not registered: "missing".*raw.*gzip-6/);
  });

  it("list() returns names in each category", () => {
    const registry = new CodecRegistry();
    registry.register(rawCodec);
    registry.registerString(lengthPrefixStringCodec);
    registry.registerInt(rawInt64Codec);
    const list = registry.list();
    expect(list.bytes).toEqual(["raw"]);
    expect(list.strings).toEqual(["length-prefix"]);
    expect(list.ints).toEqual(["raw-i64-le"]);
  });

  it("getString / getInt resolve registered codecs", () => {
    const registry = new CodecRegistry();
    registry.registerString(lengthPrefixStringCodec);
    registry.registerInt(rawInt64Codec);
    expect(registry.getString("length-prefix")).toBe(lengthPrefixStringCodec);
    expect(registry.getInt("raw-i64-le")).toBe(rawInt64Codec);
  });

  it("getString / getInt throw with descriptive errors on miss", () => {
    const registry = new CodecRegistry();
    registry.registerString(lengthPrefixStringCodec);
    registry.registerInt(rawInt64Codec);
    expect(() => registry.getString("missing")).toThrow(
      /String codec not registered: "missing".*length-prefix/
    );
    expect(() => registry.getInt("missing")).toThrow(
      /Int codec not registered: "missing".*raw-i64-le/
    );
  });

  it("has() reports membership across all three namespaces", () => {
    const registry = new CodecRegistry();
    registry.register(rawCodec);
    registry.registerString(lengthPrefixStringCodec);
    registry.registerInt(rawInt64Codec);
    expect(registry.has("raw")).toBe(true);
    expect(registry.has("length-prefix")).toBe(true);
    expect(registry.has("raw-i64-le")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });
});

describe("defaultRegistry", () => {
  it("ships gzip / zstd / raw / length-prefix / raw-i64", () => {
    const r = defaultRegistry();
    expect(r.has("raw")).toBe(true);
    expect(r.has("gzip-6")).toBe(true);
    expect(r.has("gzip-9")).toBe(true);
    expect(r.has("zstd-3")).toBe(true);
    expect(r.has("zstd-19")).toBe(true);
    expect(r.has("length-prefix")).toBe(true);
    expect(r.has("raw-i64-le")).toBe(true);
  });

  it("each baseline codec round-trips through the registry", () => {
    const r = defaultRegistry();
    const input = new TextEncoder().encode("foo".repeat(100));
    for (const name of ["raw", "gzip-6", "gzip-9", "zstd-3", "zstd-19"]) {
      const codec = r.get(name);
      const decoded = codec.decode(codec.encode(input));
      expect(Array.from(decoded), `codec ${name}`).toEqual(Array.from(input));
    }
  });
});
