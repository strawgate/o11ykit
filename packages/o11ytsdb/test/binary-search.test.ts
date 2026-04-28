import { lowerBound, upperBound } from "stardb";
import { describe, expect, it } from "vitest";
import { concatRanges } from "../src/binary-search.js";
import type { TimeRange } from "../src/types.js";

describe("binary-search", () => {
  describe("lowerBound", () => {
    it("finds lower bound in sorted array", () => {
      const arr = new BigInt64Array([1n, 3n, 5n, 7n]);
      expect(lowerBound(arr, 5n, 0, 4)).toBe(2);
    });

    it("returns hi when target is past all elements", () => {
      const arr = new BigInt64Array([1n, 3n, 5n]);
      expect(lowerBound(arr, 10n, 0, 3)).toBe(3);
    });

    it("returns lo when target is before all elements", () => {
      const arr = new BigInt64Array([5n, 7n, 9n]);
      expect(lowerBound(arr, 1n, 0, 3)).toBe(0);
    });

    it("finds lower bound with duplicates", () => {
      const arr = new BigInt64Array([1n, 3n, 3n, 3n, 5n]);
      expect(lowerBound(arr, 3n, 0, 5)).toBe(1);
    });

    it("respects windowed range", () => {
      const arr = new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
      expect(lowerBound(arr, 5n, 2, 6)).toBe(4);
    });

    it("returns hi when target is past windowed range", () => {
      const arr = new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
      expect(lowerBound(arr, 9n, 2, 6)).toBe(6);
    });
  });

  describe("upperBound", () => {
    it("finds upper bound in sorted array", () => {
      const arr = new BigInt64Array([1n, 3n, 5n, 7n]);
      expect(upperBound(arr, 5n, 0, 4)).toBe(3);
    });

    it("returns hi when target equals last element", () => {
      const arr = new BigInt64Array([1n, 3n, 5n]);
      expect(upperBound(arr, 5n, 0, 3)).toBe(3);
    });

    it("finds upper bound with duplicates", () => {
      const arr = new BigInt64Array([1n, 3n, 3n, 3n, 5n]);
      expect(upperBound(arr, 3n, 0, 5)).toBe(4);
    });

    it("respects windowed range", () => {
      const arr = new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
      expect(upperBound(arr, 5n, 2, 6)).toBe(5);
    });

    it("returns hi when target is past windowed range", () => {
      const arr = new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
      expect(upperBound(arr, 9n, 2, 6)).toBe(6);
    });
  });
});

describe("concatRanges", () => {
  it("returns empty TimeRange for empty array", () => {
    const result = concatRanges([]);
    expect(result.timestamps).toEqual(new BigInt64Array(0));
    expect(result.values).toEqual(new Float64Array(0));
  });

  it("returns single non-empty part as-is", () => {
    const part: TimeRange = {
      timestamps: new BigInt64Array([1n, 2n]),
      values: new Float64Array([10, 20]),
    };
    const result = concatRanges([part]);
    expect(result.timestamps).toEqual(new BigInt64Array([1n, 2n]));
    expect(result.values).toEqual(new Float64Array([10, 20]));
  });

  it("concatenates multiple parts", () => {
    const part1: TimeRange = {
      timestamps: new BigInt64Array([1n, 2n]),
      values: new Float64Array([10, 20]),
    };
    const part2: TimeRange = {
      timestamps: new BigInt64Array([3n, 4n]),
      values: new Float64Array([30, 40]),
    };
    const result = concatRanges([part1, part2]);
    expect(result.timestamps).toEqual(new BigInt64Array([1n, 2n, 3n, 4n]));
    expect(result.values).toEqual(new Float64Array([10, 20, 30, 40]));
  });

  it("single part with empty arrays and decodeView decodes and copies", () => {
    const part: TimeRange & { decodeView?: () => TimeRange } = {
      timestamps: new BigInt64Array(0),
      values: new Float64Array(0),
      decodeView: () => ({
        timestamps: new BigInt64Array([1n, 2n]),
        values: new Float64Array([10, 20]),
      }),
    };
    const result = concatRanges([part as TimeRange]);
    expect(result.timestamps).toEqual(new BigInt64Array([1n, 2n]));
    expect(result.values).toEqual(new Float64Array([10, 20]));
  });

  it("single part with empty arrays and decode returns decoded", () => {
    const part: TimeRange & { decode?: () => TimeRange } = {
      timestamps: new BigInt64Array(0),
      values: new Float64Array(0),
      decode: () => ({
        timestamps: new BigInt64Array([5n, 6n]),
        values: new Float64Array([50, 60]),
      }),
    };
    const result = concatRanges([part as TimeRange]);
    expect(result.timestamps).toEqual(new BigInt64Array([5n, 6n]));
    expect(result.values).toEqual(new Float64Array([50, 60]));
  });

  it("multiple parts with empty arrays and decode", () => {
    const part1: TimeRange & { decode: () => TimeRange } = {
      timestamps: new BigInt64Array(0),
      values: new Float64Array(0),
      decode: () => ({
        timestamps: new BigInt64Array([1n]),
        values: new Float64Array([10]),
      }),
    };
    const part2: TimeRange & { decode: () => TimeRange } = {
      timestamps: new BigInt64Array(0),
      values: new Float64Array(0),
      decode: () => ({
        timestamps: new BigInt64Array([2n]),
        values: new Float64Array([20]),
      }),
    };
    const result = concatRanges([part1 as TimeRange, part2 as TimeRange]);
    expect(result.timestamps).toEqual(new BigInt64Array([1n, 2n]));
    expect(result.values).toEqual(new Float64Array([10, 20]));
  });

  it("multiple parts with empty arrays and decodeView", () => {
    const result = concatRanges([
      {
        timestamps: new BigInt64Array(0),
        values: new Float64Array(0),
        decodeView() {
          return {
            timestamps: new BigInt64Array([1n]),
            values: new Float64Array([10]),
          };
        },
      },
      {
        timestamps: new BigInt64Array(0),
        values: new Float64Array(0),
        decodeView() {
          return {
            timestamps: new BigInt64Array([2n]),
            values: new Float64Array([20]),
          };
        },
      },
    ]);
    expect(result.timestamps).toEqual(new BigInt64Array([1n, 2n]));
    expect(result.values).toEqual(new Float64Array([10, 20]));
  });
});
