import { describe, expect, it } from "vitest";
import { computeStats } from "../src/stats.js";

describe("computeStats", () => {
  it("throws on empty array", () => {
    expect(() => computeStats(new Float64Array())).toThrow("at least one sample");
  });

  it("computes correct stats for single value", () => {
    const values = new Float64Array([42]);
    const stats = computeStats(values);
    expect(stats.minV).toBe(42);
    expect(stats.maxV).toBe(42);
    expect(stats.sum).toBe(42);
    expect(stats.count).toBe(1);
    expect(stats.firstV).toBe(42);
    expect(stats.lastV).toBe(42);
    expect(stats.sumOfSquares).toBe(1764);
    expect(stats.resetCount).toBe(0);
  });

  it("computes correct stats for multiple values", () => {
    const values = new Float64Array([5, 3, 2, 8, 4]);
    const stats = computeStats(values);
    expect(stats.minV).toBe(2);
    expect(stats.maxV).toBe(8);
    expect(stats.sum).toBe(22);
    expect(stats.count).toBe(5);
    expect(stats.firstV).toBe(5);
    expect(stats.lastV).toBe(4);
    expect(stats.resetCount).toBe(3); // 3 < 5 (reset), 2 < 3 (reset), 8 < 2 (false), 4 < 8 (reset)
  });
});
