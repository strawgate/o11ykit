import { Interner } from "stardb";
import { describe, expect, it } from "vitest";

describe("Interner", () => {
  it("round-trips utf8 strings and deduplicates ids", () => {
    const interner = new Interner();
    const a = interner.intern("service.name");
    const b = interner.intern("service.name");
    const c = interner.intern("東京");
    expect(a).toBe(b);
    expect(interner.resolve(c)).toBe("東京");
  });

  it("handles hash collisions by byte equality checks", () => {
    const interner = new Interner();
    const ids = new Set<number>();
    // enough inserts to force collisions/probes in the open-address table
    for (let i = 0; i < 5000; i++) {
      ids.add(interner.intern(`k=${i}|v=${i * 17}`));
    }
    expect(ids.size).toBe(5000);
    expect(interner.resolve(interner.intern("k=1024|v=17408"))).toBe("k=1024|v=17408");
  });

  it("bulkIntern returns stable ids in order", () => {
    const interner = new Interner();
    const ids = interner.bulkIntern(["a", "b", "a", "🌊"]);
    expect(ids[0]).toBe(ids[2]);
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(interner.resolve(ids[1]!)).toBe("b");
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(interner.resolve(ids[3]!)).toBe("🌊");
  });

  it("enforces cardinality limit", () => {
    const interner = new Interner(100);
    for (let i = 0; i < 100; i++) {
      interner.intern(`key_${i}`);
    }
    expect(() => interner.intern("one_too_many")).toThrow("cardinality limit");
    // Existing strings still resolve fine
    expect(interner.resolve(interner.intern("key_0"))).toBe("key_0");
  });

  it("throws on resolve with invalid id", () => {
    const interner = new Interner();
    interner.intern("hello");
    expect(() => interner.resolve(999)).toThrow("invalid intern id");
  });

  it("reports correct size", () => {
    const interner = new Interner();
    expect(interner.size).toBe(0);
    interner.intern("a");
    expect(interner.size).toBe(1);
    interner.intern("b");
    expect(interner.size).toBe(2);
    interner.intern("a"); // dedup
    expect(interner.size).toBe(2);
  });
});
