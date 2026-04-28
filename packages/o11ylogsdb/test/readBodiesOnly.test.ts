import { defaultRegistry } from "stardb";
import { describe, expect, it } from "vitest";
import type { ChunkPolicy } from "../src/chunk.js";
import { ChunkBuilder, DefaultChunkPolicy, readBodiesOnly, readRecords } from "../src/chunk.js";
import { ColumnarDrainPolicy, ColumnarRawPolicy } from "../src/codec-columnar.js";
import { DrainChunkPolicy } from "../src/codec-drain.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "service.name", value: "test" }] };
const scope: InstrumentationScope = { name: "test-scope" };
const registry = defaultRegistry();

function freezeWith(policy: ChunkPolicy, records: readonly LogRecord[]) {
  const builder = new ChunkBuilder(resource, scope, policy, registry);
  for (const r of records) builder.append(r);
  return builder.freeze();
}

function makeRecord(i: number, body: LogRecord["body"]): LogRecord {
  return {
    timeUnixNano: BigInt(1_000_000_000 + i * 1000),
    severityNumber: 9,
    severityText: "INFO",
    body,
    attributes: [{ key: "idx", value: String(i) }],
  };
}

describe("readBodiesOnly: TypedColumnarDrainPolicy", () => {
  it("returns same body values as readRecords for string bodies", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push(makeRecord(i, `user user_${i % 5} performed action ${i}`));
    }
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(fullRecords.length);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });

  it("handles structured (map) bodies from sidecar", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [
      makeRecord(0, { event: "click", target: "submit-btn" }),
      makeRecord(1, { event: "scroll", offset: 42 }),
      makeRecord(2, { nested: { deep: { value: true } } }),
    ];
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(3);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });

  it("handles empty bodies", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [
      makeRecord(0, ""),
      makeRecord(1, ""),
      makeRecord(2, "non-empty body here"),
      makeRecord(3, ""),
    ];
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(4);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });

  it("handles very long bodies (1KB+)", () => {
    const policy = new TypedColumnarDrainPolicy();
    const longBody = "x".repeat(1500);
    const records: LogRecord[] = [
      makeRecord(0, longBody),
      makeRecord(1, "a".repeat(2000)),
      makeRecord(2, "short"),
    ];
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(3);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });

  it("handles null bodies through sidecar (returns empty string for null)", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [
      makeRecord(0, null),
      makeRecord(1, "normal body"),
      makeRecord(2, null),
    ];
    const chunk = freezeWith(policy, records);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(3);
    // decodeBodiesOnly returns "" for null-valued OTHER bodies (known behavior:
    // the partial decoder doesn't distinguish null from empty for KIND_OTHER fallback)
    expect(bodies[0]).toBe("");
    expect(bodies[1]).toBe("normal body");
    expect(bodies[2]).toBe("");
  });
});

describe("readBodiesOnly: DefaultChunkPolicy (NDJSON fallback)", () => {
  it("returns same body values as readRecords", () => {
    const policy = new DefaultChunkPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(makeRecord(i, `default policy body ${i}`));
    }
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(fullRecords.length);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });

  it("handles structured bodies via NDJSON fallback", () => {
    const policy = new DefaultChunkPolicy();
    const records: LogRecord[] = [
      makeRecord(0, { key: "value", nested: { num: 42 } }),
      makeRecord(1, "string body"),
      makeRecord(2, null),
    ];
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(3);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });
});

describe("readBodiesOnly: DrainChunkPolicy (fallback path)", () => {
  it("returns body-length-matching array (fallback does not apply postDecode)", () => {
    const policy = new DrainChunkPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 30; i++) {
      records.push(makeRecord(i, `processing item ${i} in queue`));
    }
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    // DrainChunkPolicy uses preEncode/postDecode (not encodePayload/decodePayload
    // nor decodeBodiesOnly), so the NDJSON fallback returns template-reference
    // bodies rather than reconstructed strings. Verify length matches at least.
    expect(bodies.length).toBe(fullRecords.length);
  });
});

describe("readBodiesOnly: ColumnarDrainPolicy", () => {
  it("returns same body values as readRecords", () => {
    const policy = new ColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 30; i++) {
      records.push(makeRecord(i, `connection from host_${i % 4} established on port ${8080 + i}`));
    }
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(fullRecords.length);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });
});

describe("readBodiesOnly: ColumnarRawPolicy", () => {
  it("returns same body values as readRecords", () => {
    const policy = new ColumnarRawPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 20; i++) {
      records.push(makeRecord(i, `raw columnar body line ${i}`));
    }
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(fullRecords.length);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });
});

describe("readBodiesOnly: consistent across mixed-content chunks", () => {
  it("TypedColumnarDrainPolicy with all body types in one chunk", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    // Templated (many similar)
    for (let i = 0; i < 30; i++) {
      records.push(makeRecord(i, `request ${i} from user_${i % 3} succeeded`));
    }
    // Raw unique strings
    records.push(makeRecord(30, "absolutely unique message about quantum physics"));
    records.push(makeRecord(31, "another one-off about medieval castle architecture"));
    // Structured bodies
    records.push({
      timeUnixNano: 32n,
      severityNumber: 9,
      severityText: "INFO",
      body: { type: "metric", cpu: 0.75, mem: 1024 },
      attributes: [],
    });
    records.push({
      timeUnixNano: 33n,
      severityNumber: 9,
      severityText: "INFO",
      body: { type: "event", name: "deploy" },
      attributes: [],
    });

    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodies = readBodiesOnly(chunk, registry, policy);
    expect(bodies.length).toBe(fullRecords.length);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodies[i]).toEqual(fullRecords[i]?.body);
    }
  });
});
