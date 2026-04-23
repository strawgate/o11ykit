import { describe, expect, it } from "vitest";
import {
  buildAlpByteSegments,
  buildTimestampByteSegments,
  buildXorByteSegments,
  pickRandomChunk,
} from "../js/storage-explorer-model.js";

describe("storage-explorer-model", () => {
  it("prefers frozen chunks over hot chunks when picking randomly", () => {
    const frozenSeries = {
      info: {
        frozen: [{}, {}],
        hot: { count: 1 },
      },
    };
    const hotOnlySeries = {
      info: {
        frozen: [],
        hot: { count: 1 },
      },
    };

    const pick = pickRandomChunk([frozenSeries, hotOnlySeries], () => 0.9);
    expect(pick.type).toBe("frozen");
    expect(pick.chunkIndex).toBe(1);
  });

  it("falls back to hot chunks when no frozen chunks exist", () => {
    const hotOnlySeries = {
      info: {
        frozen: [],
        hot: { count: 2 },
      },
    };

    const pick = pickRandomChunk([hotOnlySeries], () => 0.1);
    expect(pick.type).toBe("hot");
    expect(pick.chunkIndex).toBe(-1);
  });

  it("builds xor byte segments from compressed payload size", () => {
    const { totalBytes, segments } = buildXorByteSegments(new Uint8Array(100));
    expect(totalBytes).toBe(100);
    expect(segments.map((segment) => segment.label)).toEqual([
      "Header",
      "Timestamps",
      "XOR Values",
    ]);
    expect(segments.reduce((sum, segment) => sum + segment.bytes, 0)).toBe(100);
  });

  it("builds alp byte segments with optional exceptions", () => {
    const bytes = new Uint8Array(40);
    bytes[0] = 0;
    bytes[1] = 10; // count
    bytes[3] = 5; // bit width
    bytes[12] = 0;
    bytes[13] = 2; // two exceptions

    const { totalBytes, segments } = buildAlpByteSegments(bytes);
    expect(totalBytes).toBe(40);
    expect(segments.map((segment) => segment.label)).toEqual(["Header", "Offsets", "Exceptions"]);
    expect(segments.reduce((sum, segment) => sum + segment.bytes, 0)).toBe(40);
  });

  it("builds timestamp byte segments with fixed header and body", () => {
    const { totalBytes, segments } = buildTimestampByteSegments(new Uint8Array(27));
    expect(totalBytes).toBe(27);
    expect(segments).toEqual([
      { label: "Header", bytes: 10, cls: "timestamps" },
      { label: "Δ² Body", bytes: 17, cls: "timestamps" },
    ]);
  });
});
