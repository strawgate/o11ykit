import { describe, expect, it } from "vitest";

import { MemPostings } from "../src/postings.js";

describe("MemPostings", () => {
  it("indexes label/value to sorted series ids", () => {
    const p = new MemPostings();
    p.add(1, new Map([["job", "api"]]));
    p.add(3, new Map([["job", "api"]]));
    p.add(2, new Map([["job", "worker"]]));
    expect(p.get("job", "api")).toEqual([1, 3]);
    expect(p.get("job", "worker")).toEqual([2]);
  });

  it("galloping intersect handles edge cases", () => {
    const p = new MemPostings();
    expect(p.intersect([], [1, 2, 3])).toEqual([]);
    expect(p.intersect([1, 5, 9, 100], [5, 9, 10, 100])).toEqual([5, 9, 100]);
    expect(p.intersect([1, 2, 3], [4, 5, 6])).toEqual([]);
  });

  it("regex matcher unions all matching postings", () => {
    const p = new MemPostings();
    p.add(1, new Map([["env", "prod-eu"]]));
    p.add(2, new Map([["env", "prod-us"]]));
    p.add(3, new Map([["env", "dev"]]));
    expect(p.matchRegex("env", /^prod-/)).toEqual([1, 2]);
  });

  it("union merges sorted postings", () => {
    const p = new MemPostings();
    expect(p.union([1, 3, 5], [2, 3, 6])).toEqual([1, 2, 3, 5, 6]);
  });

  it("union handles overlapping elements", () => {
    const p = new MemPostings();
    expect(p.union([1, 2, 3], [2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it("union handles empty arrays", () => {
    const p = new MemPostings();
    expect(p.union([], [1, 2])).toEqual([1, 2]);
    expect(p.union([1, 2], [])).toEqual([1, 2]);
  });
});
