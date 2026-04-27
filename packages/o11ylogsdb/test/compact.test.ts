import { defaultRegistry } from "stardb";
import { describe, expect, it } from "vitest";
import { ChunkBuilder, DefaultChunkPolicy, readRecords } from "../src/chunk.js";
import { compactChunk } from "../src/compact.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "service.name", value: "test" }] };
const scope: InstrumentationScope = { name: "test-scope" };
const registry = defaultRegistry();

function buildZ19Chunk(n: number) {
  const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy("zstd-19"), registry);
  for (let i = 0; i < n; i++) {
    const r: LogRecord = {
      timeUnixNano: BigInt(i),
      severityNumber: 9,
      severityText: "INFO",
      body: `record ${i} payload-payload-payload-payload`,
      attributes: [],
    };
    builder.append(r);
  }
  return builder.freeze();
}

describe("compactChunk", () => {
  it("re-encodes the payload under a new codec and preserves records", () => {
    const z19 = buildZ19Chunk(50);
    const { chunk: z3 } = compactChunk(z19, registry, "zstd-3");
    expect(z3.header.codecName).toBe("zstd-3");
    expect(z3.header.payloadBytes).toBe(z3.payload.length);
    // Round-trip equivalence — same record sequence.
    const before = readRecords(z19, registry);
    const after = readRecords(z3, registry);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]?.body).toBe(before[i]?.body);
      expect(after[i]?.timeUnixNano).toBe(before[i]?.timeUnixNano);
    }
  });

  it("reports stats matching the new and old payload sizes", () => {
    const z19 = buildZ19Chunk(50);
    const { chunk: z3, stats } = compactChunk(z19, registry, "zstd-3");
    expect(stats.inputBytes).toBe(z19.payload.length);
    expect(stats.outputBytes).toBe(z3.payload.length);
    expect(stats.decodeMillis).toBeGreaterThanOrEqual(0);
    expect(stats.encodeMillis).toBeGreaterThanOrEqual(0);
  });

  it("is a no-op when target codec equals current codec", () => {
    const z19 = buildZ19Chunk(10);
    const { chunk, stats } = compactChunk(z19, registry, "zstd-19");
    expect(chunk).toBe(z19);
    expect(stats.decodeMillis).toBe(0);
    expect(stats.encodeMillis).toBe(0);
  });

  it("does not mutate the input chunk", () => {
    const z19 = buildZ19Chunk(10);
    const originalCodec = z19.header.codecName;
    const originalPayloadLen = z19.payload.length;
    compactChunk(z19, registry, "zstd-3");
    expect(z19.header.codecName).toBe(originalCodec);
    expect(z19.payload.length).toBe(originalPayloadLen);
  });
});
