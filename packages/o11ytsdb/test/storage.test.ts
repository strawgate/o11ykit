import { describe, expect, it } from "vitest";
import { ChunkedStore } from "../src/chunked-store.js";
import { decodeChunk, encodeChunk } from "../src/codec.js";
import { ColumnStore } from "../src/column-store.js";
import { FlatStore } from "../src/flat-store.js";
import { LaneRowGroupStore } from "../src/lane-row-group-store.js";
import type { Codec, Labels, StorageBackend, ValuesCodec } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

const tsCodec: Codec = {
  name: "ts-xor-delta",
  encode: encodeChunk,
  decode: decodeChunk,
};

const tsValuesCodec: ValuesCodec = {
  name: "identity",
  encodeValues(values: Float64Array): Uint8Array {
    return new Uint8Array(values.buffer.slice(0));
  },
  decodeValues(buf: Uint8Array): Float64Array {
    return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  },
};

function makeLabels(name: string, extra?: Record<string, string>): Labels {
  const m = new Map<string, string>();
  m.set("__name__", name);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) m.set(k, v);
  }
  return m;
}

function insertSamples(
  store: StorageBackend,
  labels: Labels,
  count: number,
  t0 = 1_000_000n,
  interval = 15_000n
) {
  const id = store.getOrCreateSeries(labels);
  for (let i = 0; i < count; i++) {
    store.append(id, t0 + BigInt(i) * interval, i * 1.5);
  }
  return id;
}

function insertBatch(
  store: StorageBackend,
  labels: Labels,
  count: number,
  t0 = 1_000_000n,
  interval = 15_000n
) {
  const id = store.getOrCreateSeries(labels);
  const ts = new BigInt64Array(count);
  const vals = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    ts[i] = t0 + BigInt(i) * interval;
    vals[i] = i * 1.5;
  }
  store.appendBatch(id, ts, vals);
  return id;
}

// ── Generic storage backend contract tests ───────────────────────────

function describeStorageBackend(name: string, create: () => StorageBackend) {
  describe(name, () => {
    it("creates and retrieves series by labels", () => {
      const store = create();
      const labels = makeLabels("cpu", { host: "a" });
      const id1 = store.getOrCreateSeries(labels);
      const id2 = store.getOrCreateSeries(labels);
      expect(id1).toBe(id2); // same labels → same id

      const id3 = store.getOrCreateSeries(makeLabels("cpu", { host: "b" }));
      expect(id3).not.toBe(id1); // different labels → different id
    });

    it("appends and reads samples", () => {
      const store = create();
      const id = insertSamples(store, makeLabels("metric_a"), 10);
      expect(store.sampleCount).toBe(10);

      const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
      expect(data.timestamps.length).toBe(10);
      expect(data.values[0]).toBe(0);
      expect(data.values[9]).toBe(9 * 1.5);
    });

    it("reads with time range filter", () => {
      const store = create();
      const t0 = 1_000_000n;
      const interval = 15_000n;
      const id = insertSamples(store, makeLabels("metric_b"), 100, t0, interval);

      // Read middle third
      const start = t0 + 33n * interval;
      const end = t0 + 66n * interval;
      const data = store.read(id, start, end);
      expect(data.timestamps.length).toBeGreaterThanOrEqual(30);
      expect(data.timestamps.length).toBeLessThanOrEqual(40);
      for (const ts of data.timestamps) {
        expect(ts).toBeGreaterThanOrEqual(start);
        expect(ts).toBeLessThanOrEqual(end);
      }
    });

    it("appendBatch inserts all samples", () => {
      const store = create();
      const id = insertBatch(store, makeLabels("batch_metric"), 200);
      expect(store.sampleCount).toBe(200);
      const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
      expect(data.timestamps.length).toBe(200);
    });

    it("matchLabel finds correct series", () => {
      const store = create();
      insertSamples(store, makeLabels("cpu", { host: "a" }), 5);
      insertSamples(store, makeLabels("cpu", { host: "b" }), 5);
      insertSamples(store, makeLabels("mem", { host: "a" }), 5);

      const cpuIds = store.matchLabel("__name__", "cpu");
      expect(cpuIds.length).toBe(2);

      const hostAIds = store.matchLabel("host", "a");
      expect(hostAIds.length).toBe(2);

      const memIds = store.matchLabel("__name__", "mem");
      expect(memIds.length).toBe(1);
    });

    it("labels() returns correct label map", () => {
      const store = create();
      const labels = makeLabels("test_metric", { env: "prod", region: "us-east" });
      const id = store.getOrCreateSeries(labels);
      const retrieved = store.labels(id);
      expect(retrieved).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: test code
      expect(retrieved!.get("__name__")).toBe("test_metric");
      // biome-ignore lint/style/noNonNullAssertion: test code
      expect(retrieved!.get("env")).toBe("prod");
      // biome-ignore lint/style/noNonNullAssertion: test code
      expect(retrieved!.get("region")).toBe("us-east");
    });

    it("labels() returns undefined for invalid id", () => {
      const store = create();
      expect(store.labels(999)).toBeUndefined();
    });

    it("seriesCount and sampleCount track correctly", () => {
      const store = create();
      expect(store.seriesCount).toBe(0);
      expect(store.sampleCount).toBe(0);

      insertSamples(store, makeLabels("m1"), 10);
      expect(store.seriesCount).toBe(1);
      expect(store.sampleCount).toBe(10);

      insertSamples(store, makeLabels("m2"), 20);
      expect(store.seriesCount).toBe(2);
      expect(store.sampleCount).toBe(30);
    });

    it("memoryBytes returns positive value", () => {
      const store = create();
      insertSamples(store, makeLabels("m1"), 100);
      expect(store.memoryBytes()).toBeGreaterThan(0);
    });

    it("handles large batch spanning multiple chunks", () => {
      const store = create();
      const id = insertBatch(store, makeLabels("big_metric"), 5000);
      expect(store.sampleCount).toBe(5000);
      const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
      expect(data.timestamps.length).toBe(5000);
      // Verify first and last values are correct
      expect(data.values[0]).toBe(0);
      expect(data.values[4999]).toBeCloseTo(4999 * 1.5);
    });
  });
}

// ── Run contract tests against each backend ──────────────────────────

describeStorageBackend("FlatStore", () => new FlatStore());
describeStorageBackend("ChunkedStore (chunk=64)", () => new ChunkedStore(tsCodec, 64));
describeStorageBackend("ChunkedStore (chunk=640)", () => new ChunkedStore(tsCodec, 640));
describeStorageBackend("ColumnStore (chunk=64)", () => new ColumnStore(tsValuesCodec, 64));
describeStorageBackend("LaneRowGroupStore (chunk=64 lane=2)", () => new LaneRowGroupStore(tsValuesCodec, 64, () => 0, 2));

// ── ChunkedStore-specific tests ──────────────────────────────────────

describe("ChunkedStore freeze behavior", () => {
  it("freezes chunks when reaching chunk size", () => {
    const store = new ChunkedStore(tsCodec, 16);
    const id = insertSamples(store, makeLabels("freeze_test"), 48);

    // 48 samples with chunk size 16 → 3 frozen chunks, hot chunk empty
    const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(data.timestamps.length).toBe(48);

    // Compressed should use less memory than flat
    const flat = new FlatStore();
    // biome-ignore lint/correctness/noUnusedVariables: test code
    const flatId = insertSamples(flat, makeLabels("freeze_test"), 48);
    expect(store.memoryBytes()).toBeLessThan(flat.memoryBytes());
  });

  it("correctly reads across frozen and hot chunks", () => {
    const store = new ChunkedStore(tsCodec, 10);
    const id = insertSamples(store, makeLabels("mixed"), 25);

    // 25 samples with chunk size 10 → 2 frozen chunks + 5 in hot
    const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(data.timestamps.length).toBe(25);

    // Verify continuity
    for (let i = 0; i < 25; i++) {
      expect(data.values[i]).toBeCloseTo(i * 1.5);
    }
  });
});

describe("LaneRowGroupStore freeze behavior", () => {
  it("freezes lanes independently within the same logical group", () => {
    const store = new LaneRowGroupStore(tsValuesCodec, 64, () => 0, 2);
    const labels = ["a", "b", "c", "d"].map((host) => makeLabels("lane_metric", { host }));
    const ids = labels.map((label) => store.getOrCreateSeries(label));

    const laggardTs = new BigInt64Array(32);
    const laggardVals = new Float64Array(32);
    for (let i = 0; i < 32; i++) {
      laggardTs[i] = 1_000_000n + BigInt(i) * 15_000n;
      laggardVals[i] = i;
    }

    const fullTs = new BigInt64Array(128);
    const fullVals = new Float64Array(128);
    for (let i = 0; i < 128; i++) {
      fullTs[i] = 1_000_000n + BigInt(i) * 15_000n;
      fullVals[i] = i;
    }

    store.appendBatch(ids[0]!, laggardTs, laggardVals);
    store.appendBatch(ids[1]!, laggardTs, laggardVals);
    store.appendBatch(ids[2]!, fullTs, fullVals);
    store.appendBatch(ids[3]!, fullTs, fullVals);

    const groups = Reflect.get(store, "groups");
    expect(Array.isArray(groups)).toBe(true);
    const group = groups[0];
    expect(group).toBeDefined();
    const lanes = Reflect.get(group, "lanes");
    expect(Array.isArray(lanes)).toBe(true);
    expect(lanes.length).toBe(2);

    const lane0 = lanes[0];
    const lane1 = lanes[1];
    const lane0Frozen = Reflect.get(lane0, "frozenTimestamps");
    const lane1Frozen = Reflect.get(lane1, "frozenTimestamps");
    const lane0HotCount = Reflect.get(lane0, "hotCount");
    const lane1HotCount = Reflect.get(lane1, "hotCount");

    expect(Array.isArray(lane0Frozen)).toBe(true);
    expect(Array.isArray(lane1Frozen)).toBe(true);
    expect(lane0Frozen.length).toBe(0);
    expect(lane1Frozen.length).toBe(2);
    expect(lane0HotCount).toBe(32);
    expect(lane1HotCount).toBe(0);
  });
});
