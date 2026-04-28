import { defaultRegistry } from "stardb";
import { describe, expect, it } from "vitest";
import {
  CHUNK_VERSION,
  ChunkBuilder,
  type ChunkPolicy,
  chunkWireSize,
  DefaultChunkPolicy,
  deserializeChunk,
  readRecords,
  serializeChunk,
} from "../src/chunk.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "service.name", value: "test" }] };
const scope: InstrumentationScope = { name: "test-scope" };
const registry = defaultRegistry();

function rec(partial: Partial<LogRecord> & { timeUnixNano: bigint }): LogRecord {
  return {
    severityNumber: 9,
    severityText: "INFO",
    body: "hello",
    attributes: [],
    ...partial,
  };
}

describe("ChunkBuilder", () => {
  it("freezes an empty chunk with sentinel severity range and zero time", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    const chunk = builder.freeze();
    expect(chunk.header.nLogs).toBe(0);
    expect(chunk.header.severityRange).toEqual({ min: 1, max: 24 });
    expect(chunk.header.timeRange).toEqual({ minNano: "0", maxNano: "0" });
  });

  it("computes time range from first/last record", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    builder.append(rec({ timeUnixNano: 100n }));
    builder.append(rec({ timeUnixNano: 200n }));
    builder.append(rec({ timeUnixNano: 300n }));
    const chunk = builder.freeze();
    expect(chunk.header.timeRange).toEqual({ minNano: "100", maxNano: "300" });
  });

  it("computes severity range across all records", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    builder.append(rec({ timeUnixNano: 1n, severityNumber: 17 })); // ERROR
    builder.append(rec({ timeUnixNano: 2n, severityNumber: 5 })); // DEBUG
    builder.append(rec({ timeUnixNano: 3n, severityNumber: 9 })); // INFO
    const chunk = builder.freeze();
    expect(chunk.header.severityRange).toEqual({ min: 5, max: 17 });
  });

  it("hoists resource and scope into the header", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    builder.append(rec({ timeUnixNano: 1n }));
    const chunk = builder.freeze();
    expect(chunk.header.resource).toEqual(resource);
    expect(chunk.header.scope).toEqual(scope);
  });

  it("size() reflects appended records and reset() clears them", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    expect(builder.size()).toBe(0);
    builder.append(rec({ timeUnixNano: 1n }));
    builder.append(rec({ timeUnixNano: 2n }));
    expect(builder.size()).toBe(2);
    builder.reset();
    expect(builder.size()).toBe(0);
  });
});

describe("chunk wire format", () => {
  it("round-trips a chunk through serialize/deserialize", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    builder.append(rec({ timeUnixNano: 1n, body: "first" }));
    builder.append(rec({ timeUnixNano: 2n, body: "second" }));
    const chunk = builder.freeze();
    const bytes = serializeChunk(chunk);
    const parsed = deserializeChunk(bytes);
    expect(parsed.header).toEqual(chunk.header);
    expect(Array.from(parsed.payload)).toEqual(Array.from(chunk.payload));
  });

  it("rejects chunks with bad magic bytes", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
    expect(() => deserializeChunk(bytes)).toThrow(/invalid chunk magic/);
  });

  it("schemaVersion in the header equals CHUNK_VERSION", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    const chunk = builder.freeze();
    expect(chunk.header.schemaVersion).toBe(CHUNK_VERSION);
  });
});

describe("chunkWireSize", () => {
  it("matches serializeChunk(c).length without materializing the buffer", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    for (let i = 0; i < 10; i++) {
      builder.append(rec({ timeUnixNano: BigInt(i), body: `record-${i}` }));
    }
    const chunk = builder.freeze();
    expect(chunkWireSize(chunk)).toBe(serializeChunk(chunk).length);
  });
});

describe("readRecords with default policy", () => {
  it("round-trips records through NDJSON encode/decode", () => {
    const builder = new ChunkBuilder(resource, scope, new DefaultChunkPolicy(), registry);
    const inputs = [
      rec({ timeUnixNano: 100n, body: "alpha", severityNumber: 9 }),
      rec({ timeUnixNano: 200n, body: "beta", severityNumber: 13 }),
    ];
    for (const r of inputs) builder.append(r);
    const chunk = builder.freeze();
    const records = readRecords(chunk, registry);
    expect(records.length).toBe(2);
    expect(records[0]?.body).toBe("alpha");
    expect(records[0]?.timeUnixNano).toBe(100n);
    expect(records[1]?.body).toBe("beta");
    expect(records[1]?.severityNumber).toBe(13);
  });
});

describe("ChunkPolicy hooks", () => {
  it("preEncode/postDecode round-trips a meta blob", () => {
    const seenMeta: unknown[] = [];
    const policy: ChunkPolicy = {
      bodyCodec: () => "zstd-19",
      preEncode: (records) => ({ records, meta: { tag: "preEncodeMeta" } }),
      postDecode: (records, meta) => {
        seenMeta.push(meta);
        return records;
      },
    };
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append(rec({ timeUnixNano: 1n }));
    const chunk = builder.freeze();
    expect(chunk.header.codecMeta).toEqual({ tag: "preEncodeMeta" });
    readRecords(chunk, registry, policy);
    expect(seenMeta).toEqual([{ tag: "preEncodeMeta" }]);
  });

  it("encodePayload/decodePayload bypasses NDJSON entirely", () => {
    let encodeCalls = 0;
    let decodeCalls = 0;
    const policy: ChunkPolicy = {
      bodyCodec: () => "raw",
      encodePayload: (records) => {
        encodeCalls++;
        const json = JSON.stringify(records.map((r) => r.body));
        return { payload: new TextEncoder().encode(json), meta: { kind: "binary" } };
      },
      decodePayload: (buf, _n, meta) => {
        decodeCalls++;
        expect(meta).toEqual({ kind: "binary" });
        const bodies = JSON.parse(new TextDecoder().decode(buf)) as string[];
        return bodies.map((body, i) => ({
          timeUnixNano: BigInt(i),
          severityNumber: 9,
          severityText: "INFO",
          body,
          attributes: [],
        }));
      },
    };
    const builder = new ChunkBuilder(resource, scope, policy, registry);
    builder.append(rec({ timeUnixNano: 1n, body: "x" }));
    builder.append(rec({ timeUnixNano: 2n, body: "y" }));
    const chunk = builder.freeze();
    expect(encodeCalls).toBe(1);
    const records = readRecords(chunk, registry, policy);
    expect(decodeCalls).toBe(1);
    expect(records.map((r) => r.body)).toEqual(["x", "y"]);
  });
});
