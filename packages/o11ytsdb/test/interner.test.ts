import { describe, expect, it } from "vitest";

import { Interner } from "../src/interner.js";

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
    expect(interner.resolve(ids[1]!)).toBe("b");
    expect(interner.resolve(ids[3]!)).toBe("🌊");
  });
});
