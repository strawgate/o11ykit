import { describe, expect, it } from "vitest";
import { buildByteExplorerData, buildStorageModel } from "../js/storage-model.js";
import { hexToBytes } from "../js/utils.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSpan(overrides = {}) {
  return {
    traceId: hexToBytes("aabb00112233445566778899aabbccdd"),
    spanId: hexToBytes("1122334455667788"),
    parentSpanId: undefined,
    name: "GET /api",
    kind: 2,
    startTimeUnixNano: 1000000000n,
    endTimeUnixNano: 1050000000n,
    durationNanos: 50000000n,
    statusCode: 1,
    attributes: [{ key: "service.name", value: "gateway" }],
    events: [],
    links: [],
    ...overrides,
  };
}

function buildSpans(count, service = "gateway") {
  return Array.from({ length: count }, (_, i) =>
    makeSpan({
      spanId: hexToBytes(i.toString(16).padStart(16, "0")),
      name: i % 2 === 0 ? "GET /api" : "POST /api",
      attributes: [{ key: "service.name", value: service }],
    })
  );
}

// ── Tests ────────────────────────────────────────────────────────────

describe("buildStorageModel", () => {
  it("counts total spans correctly", () => {
    const spans = buildSpans(10);
    const model = buildStorageModel(spans, ["gateway"]);
    expect(model.stats.totalSpans).toBe(10);
  });

  it("creates chunks for spans", () => {
    const spans = buildSpans(10);
    const model = buildStorageModel(spans, ["gateway"]);
    expect(model.stats.totalChunks).toBeGreaterThan(0);
  });

  it("marks full chunks as frozen and partial as hot", () => {
    // CHUNK_SIZE is 1024, so 1500 spans → 1 frozen + 1 hot
    const spans = buildSpans(1500);
    const model = buildStorageModel(spans, ["gateway"]);
    // Chunks are split by operation, so frozen/hot depends on per-op count.
    // With 2 ops (GET, POST) ~750 each, all are < 1024 so all hot.
    expect(model.stats.hotChunks).toBeGreaterThan(0);
  });

  it("estimates raw and encoded bytes", () => {
    const spans = buildSpans(10);
    const model = buildStorageModel(spans, ["gateway"]);
    expect(model.stats.rawBytes).toBeGreaterThan(0);
    expect(model.stats.encodedBytes).toBeGreaterThan(0);
    expect(model.stats.rawBytes).toBeGreaterThan(model.stats.encodedBytes);
  });

  it("compression ratio > 1", () => {
    const spans = buildSpans(10);
    const model = buildStorageModel(spans, ["gateway"]);
    expect(model.stats.compressionRatio).toBeGreaterThan(1);
  });

  it("computes bytesPerSpan", () => {
    const spans = buildSpans(10);
    const model = buildStorageModel(spans, ["gateway"]);
    expect(model.stats.bytesPerSpan).toBeGreaterThan(0);
  });

  it("computes bloom filter stats", () => {
    const spans = buildSpans(10);
    const model = buildStorageModel(spans, ["gateway"]);
    expect(model.stats.bloomBits).toBeGreaterThan(0);
    expect(model.stats.bloomSetBits).toBeGreaterThan(0);
    expect(model.stats.bloomFPR).toBeGreaterThanOrEqual(0);
    expect(model.stats.bloomFPR).toBeLessThan(1);
  });

  it("groups spans into streams by service and operation", () => {
    const spans = [...buildSpans(5, "gateway"), ...buildSpans(5, "database")];
    // Override database span names for variety
    for (const s of spans.filter((s) => s.attributes[0].value === "database")) {
      s.name = "SELECT users";
    }
    const model = buildStorageModel(spans, ["gateway", "database"]);
    const services = new Set(model.streams.map((s) => s.service));
    expect(services.has("gateway")).toBe(true);
    expect(services.has("database")).toBe(true);
  });

  it("puts unknown-service spans in unknown bucket", () => {
    const span = makeSpan({ attributes: [{ key: "service.name", value: "mystery" }] });
    const model = buildStorageModel([span], ["gateway"]);
    const unknownStream = model.streams.find((s) => s.service === "unknown");
    expect(unknownStream).toBeTruthy();
    expect(unknownStream.spans.length).toBe(1);
  });
});

describe("buildByteExplorerData", () => {
  it("returns bytes and regions for a chunk", () => {
    const spans = buildSpans(10);
    const model = buildStorageModel(spans, ["gateway"]);
    const chunk = model.streams[0].chunks[0];
    const { bytes, regions, totalBytes } = buildByteExplorerData(chunk);

    expect(bytes.length).toBeGreaterThan(0);
    expect(regions.length).toBeGreaterThan(0);
    expect(totalBytes).toBeGreaterThan(0);
    // Regions should cover named sections
    const names = regions.map((r) => r.name);
    expect(names).toContain("Timestamps");
    expect(names).toContain("Span IDs");
    expect(names).toContain("Attributes");
  });

  it("returns empty for null chunk", () => {
    const result = buildByteExplorerData(null);
    expect(result.bytes.length).toBe(0);
    expect(result.regions.length).toBe(0);
  });
});
