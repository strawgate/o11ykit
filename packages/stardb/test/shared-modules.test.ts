import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackpressureController,
  ByteBuf,
  ByteReader,
  bloomFromBase64,
  bloomMayContain,
  bloomToBase64,
  buildDictWithIndex,
  createBloomFilter,
  decodeAnyValue,
  encodeAnyValue,
  Interner,
  lowerBound,
  uint8IndexOf,
  upperBound,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Interner ────────────────────────────────────────────────────────

describe("Interner", () => {
  it("interns and resolves strings", () => {
    const interner = new Interner();
    const id1 = interner.intern("hello");
    const id2 = interner.intern("world");
    const id3 = interner.intern("hello");
    expect(id1).toBe(id3);
    expect(id1).not.toBe(id2);
    expect(interner.resolve(id1)).toBe("hello");
    expect(interner.resolve(id2)).toBe("world");
  });

  it("reports size and memoryBytes", () => {
    const interner = new Interner();
    expect(interner.size).toBe(0);
    interner.intern("a");
    interner.intern("b");
    expect(interner.size).toBe(2);
    expect(interner.memoryBytes()).toBeGreaterThan(0);
  });

  it("bulkIntern returns ids for all strings", () => {
    const interner = new Interner();
    const ids = interner.bulkIntern(["x", "y", "x", "z"]);
    expect(ids.length).toBe(4);
    expect(ids[0]).toBe(ids[2]); // "x" same id
    expect(interner.size).toBe(3);
  });

  it("throws on cardinality limit", () => {
    const interner = new Interner(2);
    interner.intern("a");
    interner.intern("b");
    expect(() => interner.intern("c")).toThrow(/cardinality limit/);
  });

  it("throws on invalid resolve id", () => {
    const interner = new Interner();
    expect(() => interner.resolve(99)).toThrow(/invalid intern id/);
  });

  it("grows backing storage and preserves existing ids", () => {
    const interner = new Interner(2_000);
    const longValue = "x".repeat(1_500);
    const longId = interner.intern(longValue);

    for (let i = 0; i < 1_500; i++) {
      expect(interner.intern(`value-${i}`)).toBe(i + 1);
    }

    expect(interner.resolve(longId)).toBe(longValue);
    expect(interner.resolve(interner.intern("value-1499"))).toBe("value-1499");
    expect(interner.size).toBe(1_501);
  });
});

// ─── BackpressureController ──────────────────────────────────────────

describe("BackpressureController", () => {
  it("allows up to maxConcurrency acquisitions", async () => {
    const bp = new BackpressureController(2);
    await bp.acquire();
    await bp.acquire();
    expect(bp.pending).toBe(2);
    expect(bp.waiting).toBe(0);
  });

  it("queues beyond maxConcurrency and wakes on release", async () => {
    const bp = new BackpressureController(1);
    await bp.acquire();
    let resolved = false;
    const pending = bp.acquire().then(() => {
      resolved = true;
    });
    expect(bp.waiting).toBe(1);
    expect(resolved).toBe(false);
    bp.release();
    await pending;
    expect(resolved).toBe(true);
  });

  it("dispose rejects queued waiters", async () => {
    const bp = new BackpressureController(1);
    await bp.acquire();
    const pending = bp.acquire();
    bp.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
  });

  it("throws on invalid maxConcurrency", () => {
    expect(() => new BackpressureController(0)).toThrow();
    expect(() => new BackpressureController(-1)).toThrow();
  });
});

// ─── Binary search ───────────────────────────────────────────────────

describe("lowerBound / upperBound", () => {
  const arr = new BigInt64Array([10n, 20n, 30n, 40n, 50n]);

  it("lowerBound finds first element >= target", () => {
    expect(lowerBound(arr, 25n, 0, arr.length)).toBe(2); // first ≥25 is 30 at index 2
    expect(lowerBound(arr, 30n, 0, arr.length)).toBe(2); // exact match
    expect(lowerBound(arr, 5n, 0, arr.length)).toBe(0); // before all
    expect(lowerBound(arr, 55n, 0, arr.length)).toBe(5); // past end
  });

  it("upperBound finds first element > target", () => {
    expect(upperBound(arr, 30n, 0, arr.length)).toBe(3); // first >30 is 40 at index 3
    expect(upperBound(arr, 50n, 0, arr.length)).toBe(5); // past end
    expect(upperBound(arr, 5n, 0, arr.length)).toBe(0); // before all
  });
});

// ─── Bloom filter ────────────────────────────────────────────────────

describe("Bloom filter", () => {
  const ids = Array.from({ length: 10 }, (_, i) => {
    const buf = new Uint8Array(16);
    buf[0] = i;
    return buf;
  });

  it("inserted elements are always found", () => {
    const filter = createBloomFilter(ids);
    for (const id of ids) {
      expect(bloomMayContain(filter, id)).toBe(true);
    }
  });

  it("non-inserted elements usually not found (probabilistic)", () => {
    const filter = createBloomFilter(ids);
    let fp = 0;
    for (let i = 100; i < 200; i++) {
      const probe = new Uint8Array(16);
      probe[0] = i;
      if (bloomMayContain(filter, probe)) fp++;
    }
    expect(fp).toBeLessThan(10); // expect <10% FPR
  });

  it("roundtrips through base64", () => {
    const filter = createBloomFilter(ids);
    const b64 = bloomToBase64(filter);
    const restored = bloomFromBase64(b64);
    expect(restored).toEqual(filter);
  });

  it("empty filter matches everything", () => {
    const filter = createBloomFilter([]);
    expect(bloomMayContain(filter, new Uint8Array(16))).toBe(true);
  });

  it("throws on invalid bitsPerElement", () => {
    expect(() => createBloomFilter(ids, 0)).toThrow();
    expect(() => createBloomFilter(ids, -5)).toThrow();
  });

  it("deduplicates input keys", () => {
    const dup = [ids[0]!, ids[0]!, ids[1]!];
    const filter = createBloomFilter(dup);
    expect(filter.length).toBeGreaterThan(0);
    expect(bloomMayContain(filter, ids[0]!)).toBe(true);
    expect(bloomMayContain(filter, ids[1]!)).toBe(true);
  });
});

// ─── uint8IndexOf ────────────────────────────────────────────────────

describe("uint8IndexOf", () => {
  const enc = new TextEncoder();

  it("finds a substring", () => {
    const haystack = enc.encode("hello world");
    const needle = enc.encode("world");
    expect(uint8IndexOf(haystack, needle)).toBe(6);
  });

  it("returns -1 when not found", () => {
    const haystack = enc.encode("hello world");
    const needle = enc.encode("xyz");
    expect(uint8IndexOf(haystack, needle)).toBe(-1);
  });

  it("handles empty needle", () => {
    const haystack = enc.encode("hello");
    expect(uint8IndexOf(haystack, new Uint8Array(0))).toBe(0);
  });

  it("handles needle longer than haystack", () => {
    const haystack = enc.encode("hi");
    const needle = enc.encode("hello world");
    expect(uint8IndexOf(haystack, needle)).toBe(-1);
  });

  it("falls back to browser-style byte scanning when Buffer is unavailable", () => {
    vi.stubGlobal("Buffer", undefined);

    const haystack = enc.encode("ababa");
    expect(uint8IndexOf(haystack, enc.encode("aba"))).toBe(0);
    expect(uint8IndexOf(haystack, enc.encode("bab"))).toBe(1);
    expect(uint8IndexOf(haystack, enc.encode("ac"))).toBe(-1);
    expect(uint8IndexOf(haystack, new Uint8Array(0))).toBe(0);
    expect(uint8IndexOf(enc.encode("hi"), enc.encode("hello"))).toBe(-1);
  });
});

// ─── buildDictWithIndex ──────────────────────────────────────────────

describe("buildDictWithIndex", () => {
  it("returns frequency-sorted dictionary", () => {
    const { dict, index } = buildDictWithIndex(["a", "b", "a", "c", "b", "a"]);
    expect(dict[0]).toBe("a"); // most frequent
    expect(dict[1]).toBe("b");
    expect(dict[2]).toBe("c");
    expect(index.get("a")).toBe(0);
    expect(index.get("b")).toBe(1);
    expect(index.get("c")).toBe(2);
  });

  it("handles empty input", () => {
    const { dict, index } = buildDictWithIndex([]);
    expect(dict).toEqual([]);
    expect(index.size).toBe(0);
  });
});

// ─── AnyValue binary codec ──────────────────────────────────────────

describe("encodeAnyValue / decodeAnyValue", () => {
  function roundtrip(value: unknown, valDict: string[] = []) {
    const buf = new ByteBuf();
    const valIndex = new Map<string, number>();
    for (let i = 0; i < valDict.length; i++) {
      const v = valDict[i];
      if (v !== undefined) valIndex.set(v, i);
    }
    encodeAnyValue(buf, value as never, valIndex);
    const reader = new ByteReader(buf.finish());
    return decodeAnyValue(reader, valDict);
  }

  it("roundtrips null", () => {
    expect(roundtrip(null)).toBe(null);
  });

  it("roundtrips string (raw)", () => {
    expect(roundtrip("hello")).toBe("hello");
  });

  it("roundtrips string (dict)", () => {
    expect(roundtrip("hello", ["hello"])).toBe("hello");
  });

  it("roundtrips bigint", () => {
    expect(roundtrip(42n)).toBe(42n);
    expect(roundtrip(-1000n)).toBe(-1000n);
  });

  it("roundtrips number (double)", () => {
    expect(roundtrip(3.14)).toBeCloseTo(3.14);
  });

  it("roundtrips boolean", () => {
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(false)).toBe(false);
  });

  it("roundtrips bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(roundtrip(bytes)).toEqual(bytes);
  });

  it("roundtrips array", () => {
    expect(roundtrip(["a", 1n, true])).toEqual(["a", 1n, true]);
  });

  it("roundtrips map", () => {
    const obj = { key: "value", num: 42n };
    expect(roundtrip(obj)).toEqual(obj);
  });

  it("roundtrips nested structures", () => {
    const value = { arr: [1n, "two", { three: true }], nil: null };
    expect(roundtrip(value)).toEqual(value);
  });
});
