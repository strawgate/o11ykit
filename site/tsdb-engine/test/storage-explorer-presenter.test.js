import { describe, expect, it } from "vitest";
import {
  buildChunkEmptyState,
  buildFrozenChunkDetailHTML,
  buildHotChunkDetailHTML,
} from "../js/storage-explorer-presenter.js";

describe("storage-explorer-presenter", () => {
  it("builds the empty-state call to action", () => {
    const html = buildChunkEmptyState();
    expect(html).toContain("No chunk selected yet");
    expect(html).toContain("Pick a random chunk");
  });

  it("builds frozen chunk detail html for column chunks", () => {
    const chunk = {
      count: 1200,
      rawBytes: 9600,
      compressedBytes: 1200,
      ratio: 8.0,
      minT: 1_000_000_000n,
      maxT: 2_000_000_000n,
      valuesBytes: 800,
      timestampBytes: 300,
      amortizedTsBytes: 75,
      sharedTsSeries: 4,
    };

    const { html, sparkId } = buildFrozenChunkDetailHTML({
      chunk,
      isColumn: true,
      labelStr: 'k8s.namespace.name="payments"',
      metricName: "k8s.pod.cpu.usage",
      chunkIndex: 2,
      totalFrozen: 5,
    });

    expect(sparkId).toContain("sparkline-");
    expect(html).toContain("Chunk 2 of 5");
    expect(html).toContain("k8s.pod.cpu.usage");
    expect(html).toContain("ALP");
    expect(html).toContain('k8s.namespace.name="payments"');
    expect(html).toContain("TS amortized");
    expect(html).toContain("Gorilla Δ² · shared ÷ 4");
  });

  it("builds hot chunk detail html", () => {
    const hot = {
      count: 42,
      rawBytes: 1024,
      allocatedBytes: 2048,
      timestamps: [1_000_000_000n, 2_000_000_000n],
    };

    const { html, sparkId } = buildHotChunkDetailHTML({
      hot,
      labelStr: 'service.name="checkout"',
      metricName: "http.server.request.duration",
    });

    expect(sparkId).toContain("sparkline-");
    expect(html).toContain("Hot Buffer");
    expect(html).toContain('service.name="checkout"');
    expect(html).toContain("🔥 Active write");
    expect(html).toContain("None (raw)");
  });
});
