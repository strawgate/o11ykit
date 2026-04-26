import { describe, expect, it } from "vitest";

import * as o11ylogsdb from "../src/index.js";

// Smoke test: the public API exports the symbols downstream code expects.
// If a refactor accidentally drops or renames an export, this fails fast.
describe("public API surface", () => {
  it("exports the engine, codec stack, and query primitives", () => {
    const expected = [
      // Engine
      "LogStore",
      "StreamRegistry",
      // Chunk
      "CHUNK_VERSION",
      "ChunkBuilder",
      "DefaultChunkPolicy",
      "deserializeChunk",
      "readRecords",
      "serializeChunk",
      // Codec registry + baseline
      "CodecRegistry",
      "defaultRegistry",
      "GzipCodec",
      "ZstdCodec",
      "lengthPrefixStringCodec",
      "rawCodec",
      "rawInt64Codec",
      // Policies
      "ColumnarDrainPolicy",
      "ColumnarRawPolicy",
      "DrainChunkPolicy",
      "TypedColumnarDrainPolicy",
      // Compaction
      "compactChunk",
      // Drain
      "Drain",
      "DRAIN_DEFAULT_CONFIG",
      "PARAM_STR",
      "mergeTemplate",
      "similarity",
      "tokenize",
      // Classify
      "TemplatedClassifier",
      "defaultClassifier",
      // Query
      "query",
      "queryStream",
      // Version
      "VERSION",
    ] as const;
    for (const name of expected) {
      expect(o11ylogsdb).toHaveProperty(name);
    }
  });

  it("VERSION is a string (the package version constant)", () => {
    expect(typeof o11ylogsdb.VERSION).toBe("string");
  });
});
