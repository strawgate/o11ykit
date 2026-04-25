import { describe, expect, it } from "vitest";
import { concatRanges } from "../src/binary-search.js";
import { FlatStore } from "../src/flat-store.js";
import { RowGroupStore } from "../src/row-group-store.js";
import { TieredRowGroupStore } from "../src/tiered-row-group-store.js";
import type { Labels, StorageBackend, ValuesCodec } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

const tsValuesCodec: ValuesCodec = {
  name: "identity",
  encodeValues(values: Float64Array): Uint8Array {
    return new Uint8Array(
      values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength)
    );
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

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
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
describeStorageBackend(
  "RowGroupStore (chunk=64 lane=2)",
  () => new RowGroupStore(tsValuesCodec, 64, () => 0, 2)
);
describeStorageBackend(
  "TieredRowGroupStore (hot=4 cold=8 lane=2)",
  () => new TieredRowGroupStore(tsValuesCodec, 4, 8, () => 0, 2)
);

// These tests intentionally use Reflect.get to inspect private lane state
// (groups, lanes, frozenTimestamps, hotCount). They are whitebox by design:
// the lane-based invariants are what this suite is guarding, and there is no
// equivalent public surface for them. Keep in sync with the layout refactor.
describe("RowGroupStore freeze behavior", () => {
  function makeBatch(
    startIndex: number,
    count: number,
    t0 = 1_000_000n,
    interval = 15_000n
  ): { timestamps: BigInt64Array; values: Float64Array } {
    const timestamps = new BigInt64Array(count);
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      timestamps[i] = t0 + BigInt(startIndex + i) * interval;
      values[i] = startIndex + i;
    }
    return { timestamps, values };
  }

  it("freezes lanes independently within the same logical group", () => {
    const store = new RowGroupStore(tsValuesCodec, 64, () => 0, 2);
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

    store.appendBatch(requireDefined(ids[0], "missing lane id 0"), laggardTs, laggardVals);
    store.appendBatch(requireDefined(ids[1], "missing lane id 1"), laggardTs, laggardVals);
    store.appendBatch(requireDefined(ids[2], "missing lane id 2"), fullTs, fullVals);
    store.appendBatch(requireDefined(ids[3], "missing lane id 3"), fullTs, fullVals);

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

  it("rolls a stalled fast series into a fresh lane instead of growing unbounded", () => {
    const store = new RowGroupStore(tsValuesCodec, 64, () => 0, 2);
    const fastId = store.getOrCreateSeries(makeLabels("lane_metric", { host: "fast" }));
    const slowId = store.getOrCreateSeries(makeLabels("lane_metric", { host: "slow" }));

    const slowTs = new BigInt64Array(32);
    const slowVals = new Float64Array(32);
    for (let i = 0; i < 32; i++) {
      slowTs[i] = 1_000_000n + BigInt(i) * 15_000n;
      slowVals[i] = i;
    }

    const fastTs = new BigInt64Array(256);
    const fastVals = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
      fastTs[i] = 1_000_000n + BigInt(i) * 15_000n;
      fastVals[i] = i;
    }

    store.appendBatch(slowId, slowTs, slowVals);
    store.appendBatch(fastId, fastTs, fastVals);

    const groups = Reflect.get(store, "groups");
    expect(Array.isArray(groups)).toBe(true);
    const group = groups[0];
    expect(group).toBeDefined();
    const lanes = Reflect.get(group, "lanes");
    expect(Array.isArray(lanes)).toBe(true);
    expect(lanes.length).toBeGreaterThanOrEqual(2);

    const stalledLane = lanes[0];
    expect(Reflect.get(stalledLane, "hotCount")).toBe(128);

    const fastSeries = Reflect.get(store, "allSeries")[fastId];
    const segments = Reflect.get(fastSeries, "segments");
    expect(Array.isArray(segments)).toBe(true);
    expect(segments.length).toBeGreaterThanOrEqual(2);

    const data = store.read(fastId, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(data.timestamps.length).toBe(256);
    expect(data.timestamps[0]).toBe(1_000_000n);
    expect(data.timestamps[255]).toBe(1_000_000n + 255n * 15_000n);
    for (let i = 1; i < data.timestamps.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by data.timestamps.length
      expect(data.timestamps[i]!).toBeGreaterThan(data.timestamps[i - 1]!);
    }
    expect(data.values[0]).toBe(0);
    expect(data.values[255]).toBe(255);
  });

  it("grows an exact-fit hot buffer after freeze before continuing appendBatch", () => {
    const store = new RowGroupStore(tsValuesCodec, 64, () => 0, 2);
    const fastId = store.getOrCreateSeries(makeLabels("lane_metric", { host: "fast" }));
    const slowId = store.getOrCreateSeries(makeLabels("lane_metric", { host: "slow" }));

    const slowFirst = makeBatch(0, 32);
    const slowSecond = makeBatch(32, 32);
    const fastFirst = makeBatch(0, 96);
    const fastSecond = makeBatch(96, 32);

    store.appendBatch(slowId, slowFirst.timestamps, slowFirst.values);
    store.appendBatch(fastId, fastFirst.timestamps, fastFirst.values);
    store.appendBatch(slowId, slowSecond.timestamps, slowSecond.values);

    const fastSeries = Reflect.get(store, "allSeries")[fastId];
    expect(fastSeries).toBeDefined();
    const fastSegment = Reflect.get(fastSeries, "segments")[0];
    expect(Reflect.get(fastSegment, "hot")).toBeDefined();
    expect(Reflect.get(Reflect.get(fastSegment, "hot"), "count")).toBe(32);
    expect(Reflect.get(Reflect.get(fastSegment, "hot"), "values").length).toBe(32);

    store.appendBatch(fastId, fastSecond.timestamps, fastSecond.values);

    const data = store.read(fastId, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(data.timestamps.length).toBe(128);
    expect(data.values.length).toBe(128);
    expect(data.values[0]).toBe(0);
    expect(data.values[127]).toBe(127);
  });

  it("uses decodeValuesRange for partial frozen reads when available", () => {
    const rangedCodec: ValuesCodec = {
      name: "range-only",
      encodeValues(values: Float64Array): Uint8Array {
        return new Uint8Array(
          values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength)
        );
      },
      decodeValues(): Float64Array {
        throw new Error("decodeValues should not be called for partial ranged read");
      },
      decodeValuesRange(buf: Uint8Array, startIndex: number, endIndex: number): Float64Array {
        const values = new Float64Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 8));
        return values.slice(startIndex, endIndex);
      },
    };
    const store = new RowGroupStore(rangedCodec, 4, () => 0, 1);
    const id = store.getOrCreateSeries(makeLabels("partial_metric"));
    const ts = new BigInt64Array([0n, 1_000n, 2_000n, 3_000n]);
    const values = new Float64Array([10, 20, 30, 40]);
    store.appendBatch(id, ts, values);

    const data = store.read(id, 1_000n, 2_000n);
    expect(Array.from(data.timestamps)).toEqual([1_000n, 2_000n]);
    expect(Array.from(data.values)).toEqual([20, 30]);
  });

  it("does not surface scratch-backed range views from partial frozen reads", () => {
    const rangedViewCodec: ValuesCodec = {
      name: "range-view-only",
      encodeValues(values: Float64Array): Uint8Array {
        return new Uint8Array(
          values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength)
        );
      },
      decodeValues(buf: Uint8Array): Float64Array {
        return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      },
      decodeValuesRangeView(buf: Uint8Array, startIndex: number, endIndex: number): Float64Array {
        const values = new Float64Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 8));
        return values.subarray(startIndex, endIndex);
      },
    };
    const store = new RowGroupStore(rangedViewCodec, 4, () => 0, 1);
    const id = store.getOrCreateSeries(makeLabels("partial_metric"));
    const ts = new BigInt64Array([0n, 1_000n, 2_000n, 3_000n]);
    const values = new Float64Array([10, 20, 30, 40]);
    store.appendBatch(id, ts, values);

    const parts = store.readParts(id, 1_000n, 2_000n);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.decodeView).toBeUndefined();

    const data = store.read(id, 1_000n, 2_000n);
    expect(Array.from(data.timestamps)).toEqual([1_000n, 2_000n]);
    expect(Array.from(data.values)).toEqual([20, 30]);
  });

  it("copies scratch-backed decodeView parts before concatenating multiple ranges", () => {
    const scratchTs = new BigInt64Array(2);
    const scratchVals = new Float64Array(2);
    const merged = concatRanges([
      {
        timestamps: new BigInt64Array(0),
        values: new Float64Array(0),
        decodeView() {
          scratchTs[0] = 1_000n;
          scratchTs[1] = 2_000n;
          scratchVals[0] = 10;
          scratchVals[1] = 20;
          return { timestamps: scratchTs.subarray(0, 2), values: scratchVals.subarray(0, 2) };
        },
      },
      {
        timestamps: new BigInt64Array(0),
        values: new Float64Array(0),
        decodeView() {
          scratchTs[0] = 3_000n;
          scratchTs[1] = 4_000n;
          scratchVals[0] = 30;
          scratchVals[1] = 40;
          return { timestamps: scratchTs.subarray(0, 2), values: scratchVals.subarray(0, 2) };
        },
      },
    ]);

    expect(Array.from(merged.timestamps)).toEqual([1_000n, 2_000n, 3_000n, 4_000n]);
    expect(Array.from(merged.values)).toEqual([10, 20, 30, 40]);
  });
});

describe("TieredRowGroupStore compaction", () => {
  it("rejects invalid background compaction lane budgets", () => {
    expect(
      () =>
        new TieredRowGroupStore(
          tsValuesCodec,
          4,
          8,
          () => 0,
          2,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { backgroundLanesPerRun: Number.NaN }
        )
    ).toThrow(/backgroundLanesPerRun/);

    const store = new TieredRowGroupStore(tsValuesCodec, 4, 8, () => 0, 2);
    expect(() => store.drainCompaction(0)).toThrow(/maxLanes/);
  });

  it("creates compacted cold-tier series lazily when enough promoted windows accumulate", () => {
    const store = new TieredRowGroupStore(tsValuesCodec, 4, 8, () => 0, 2);
    const slowId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "slow" }));
    const fastId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "fast" }));

    const promotedStore = Reflect.get(store, "promotedStore");
    const compactedStore = Reflect.get(store, "compactedStore");
    expect(promotedStore.seriesCount).toBe(0);
    expect(compactedStore.seriesCount).toBe(0);

    const timestamps = new BigInt64Array(4);
    const slowValues = new Float64Array(4);
    const fastValues = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      timestamps[i] = 1_000_000n + BigInt(i) * 15_000n;
      slowValues[i] = i;
      fastValues[i] = i * 10;
    }

    for (let offset = 0; offset < timestamps.length; offset += 4) {
      store.appendBatch(
        slowId,
        timestamps.subarray(offset, offset + 4),
        slowValues.subarray(offset, offset + 4)
      );
      store.appendBatch(
        fastId,
        timestamps.subarray(offset, offset + 4),
        fastValues.subarray(offset, offset + 4)
      );
    }

    expect(promotedStore.seriesCount).toBe(2);
    expect(compactedStore.seriesCount).toBe(0);

    const nextTimestamps = new BigInt64Array(4);
    const nextSlowValues = new Float64Array(4);
    const nextFastValues = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      nextTimestamps[i] = 1_000_000n + BigInt(i + 4) * 15_000n;
      nextSlowValues[i] = i + 4;
      nextFastValues[i] = (i + 4) * 10;
    }

    store.appendBatch(slowId, nextTimestamps, nextSlowValues);
    store.appendBatch(fastId, nextTimestamps, nextFastValues);

    expect(compactedStore.seriesCount).toBe(0);
    store.drainCompaction();
    expect(compactedStore.seriesCount).toBe(2);
  });

  it("compacts older promoted windows into larger cold chunks and preserves read order", () => {
    const store = new TieredRowGroupStore(tsValuesCodec, 4, 8, () => 0, 2);
    const slowId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "slow" }));
    const fastId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "fast" }));

    const timestamps = new BigInt64Array(12);
    const slowValues = new Float64Array(12);
    const fastValues = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      timestamps[i] = 1_000_000n + BigInt(i) * 15_000n;
      slowValues[i] = i;
      fastValues[i] = i * 10;
    }

    store.appendBatch(slowId, timestamps, slowValues);
    store.appendBatch(fastId, timestamps, fastValues);
    store.drainCompaction();

    const hotStore = Reflect.get(store, "hotStore");
    const promotedStore = Reflect.get(store, "promotedStore");
    const compactedStore = Reflect.get(store, "compactedStore");

    const hotGroups = Reflect.get(hotStore, "groups");
    expect(Array.isArray(hotGroups)).toBe(true);

    const hotLane = hotGroups[0].lanes[0];
    expect(hotLane.rowGroups.length).toBe(0);
    expect(hotLane.frozenTimestamps.length).toBe(0);
    expect(Reflect.get(hotLane, "hotCount")).toBe(4);
    expect(promotedStore.sampleCount).toBeGreaterThan(0);
    expect(compactedStore.seriesCount).toBe(2);
    expect(compactedStore.sampleCount).toBeGreaterThan(0);

    const data = store.read(fastId, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(Array.from(data.timestamps)).toEqual(Array.from(timestamps));
    expect(Array.from(data.values)).toEqual(Array.from(fastValues));
  });

  it("yields cold parts before live hot remainder in timestamp order", () => {
    const store = new TieredRowGroupStore(tsValuesCodec, 4, 8, () => 0, 2);
    const id = store.getOrCreateSeries(makeLabels("tier_metric", { host: "solo" }));

    const timestamps = new BigInt64Array(12);
    const values = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      timestamps[i] = 1_000_000n + BigInt(i) * 15_000n;
      values[i] = i;
    }

    store.appendBatch(id, timestamps, values);

    const parts = store.readParts(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(parts.length).toBe(3);
    expect(parts[0].chunkMinT).toBe(timestamps[0]);
    expect(parts[0].chunkMaxT).toBe(timestamps[3]);
    const decodedCold = parts[0].decode?.();
    expect(decodedCold).toBeDefined();
    expect(Array.from(decodedCold?.timestamps ?? [])).toEqual(Array.from(timestamps.slice(0, 4)));
    expect(parts[1].chunkMinT).toBe(timestamps[4]);
    expect(parts[1].chunkMaxT).toBe(timestamps[7]);
    const decodedWarm = parts[1].decode?.();
    expect(decodedWarm).toBeDefined();
    expect(Array.from(decodedWarm?.timestamps ?? [])).toEqual(Array.from(timestamps.slice(4, 8)));
    expect(parts[2].chunkMinT).toBe(timestamps[8]);
    expect(parts[2].chunkMaxT).toBe(timestamps[11]);
    const decodedHot = parts[2].decode?.();
    expect(decodedHot).toBeDefined();
    expect(Array.from(decodedHot?.timestamps ?? [])).toEqual(Array.from(timestamps.slice(8, 12)));
  });

  it("merges promoted and hot parts in timestamp order before background drain", () => {
    const store = new TieredRowGroupStore(tsValuesCodec, 4, 8, () => 0, 2);
    const id = store.getOrCreateSeries(makeLabels("tier_metric", { host: "solo" }));

    for (let i = 0; i < 14; i++) {
      store.append(id, BigInt(i) * 1_000n, i);
    }

    const parts = store.readParts(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(parts.length).toBe(4);

    const decoded = parts.map((part) => part.decode?.() ?? part);
    expect(Array.from(decoded[0]?.timestamps ?? [])).toEqual([0n, 1_000n, 2_000n, 3_000n]);
    expect(Array.from(decoded[1]?.timestamps ?? [])).toEqual([4_000n, 5_000n, 6_000n, 7_000n]);
    expect(Array.from(decoded[2]?.timestamps ?? [])).toEqual([8_000n, 9_000n, 10_000n, 11_000n]);
    expect(Array.from(decoded[3]?.timestamps ?? [])).toEqual([12_000n, 13_000n]);

    const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(Array.from(data.timestamps)).toEqual([
      0n,
      1_000n,
      2_000n,
      3_000n,
      4_000n,
      5_000n,
      6_000n,
      7_000n,
      8_000n,
      9_000n,
      10_000n,
      11_000n,
      12_000n,
      13_000n,
    ]);
    expect(Array.from(data.values)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("preserves read order for a series that spans multiple promoted lanes", () => {
    const store = new TieredRowGroupStore(tsValuesCodec, 4, 8, () => 0, 2);
    const slowId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "slow" }));
    const fastId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "fast" }));

    const slowTs = new BigInt64Array([0n, 1_000n]);
    const slowVals = new Float64Array([10, 11]);
    const fastTs = new BigInt64Array(12);
    const fastVals = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      fastTs[i] = BigInt(i) * 1_000n;
      fastVals[i] = i;
    }

    store.appendBatch(slowId, slowTs, slowVals);
    store.appendBatch(fastId, fastTs, fastVals);

    const hotStore = Reflect.get(store, "hotStore");
    const hotIds = Reflect.get(store, "hotIds");
    const allSeries = Reflect.get(hotStore, "allSeries");
    const fastHotId = hotIds[fastId];
    const fastSeries = allSeries[fastHotId];
    const segments = Reflect.get(fastSeries, "segments");
    expect(Array.isArray(segments)).toBe(true);
    expect(segments.length).toBeGreaterThanOrEqual(2);

    const beforeDrain = store.read(fastId, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(Array.from(beforeDrain.timestamps)).toEqual(Array.from(fastTs));
    expect(Array.from(beforeDrain.values)).toEqual(Array.from(fastVals));

    store.drainCompaction();

    const afterDrain = store.read(fastId, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(Array.from(afterDrain.timestamps)).toEqual(Array.from(fastTs));
    expect(Array.from(afterDrain.values)).toEqual(Array.from(fastVals));
  });

  it("re-encodes promoted windows into larger compacted cold chunks", () => {
    let encodeCount = 0;
    let decodeCount = 0;
    const countingCodec: ValuesCodec = {
      name: "counting-identity",
      encodeValues(values: Float64Array): Uint8Array {
        encodeCount++;
        return new Uint8Array(
          values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength)
        );
      },
      decodeValues(buf: Uint8Array): Float64Array {
        decodeCount++;
        return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      },
    };
    const store = new TieredRowGroupStore(countingCodec, 4, 8, () => 0, 2);
    const aId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "a" }));
    const bId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "b" }));

    const timestamps = new BigInt64Array(8);
    const aValues = new Float64Array(8);
    const bValues = new Float64Array(8);
    for (let i = 0; i < 8; i++) {
      timestamps[i] = BigInt(i) * 1_000n;
      aValues[i] = i;
      bValues[i] = 100 + i;
    }

    store.appendBatch(aId, timestamps, aValues);
    store.appendBatch(bId, timestamps, bValues);
    store.drainCompaction();

    const promotedStore = Reflect.get(store, "promotedStore");
    const compactedStore = Reflect.get(store, "compactedStore");
    expect(promotedStore.sampleCount).toBe(0);
    expect(compactedStore.sampleCount).toBe(16);
    expect(encodeCount).toBe(6);
    expect(decodeCount).toBe(4);

    const hotStore = Reflect.get(store, "hotStore");
    const hotGroups = Reflect.get(hotStore, "groups");
    const hotLane = hotGroups[0].lanes[0];
    expect(hotLane.rowGroups.length).toBe(0);
    expect(hotLane.frozenTimestamps.length).toBe(0);

    const aData = store.read(aId, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(Array.from(aData.timestamps)).toEqual(Array.from(timestamps));
    expect(Array.from(aData.values)).toEqual(Array.from(aValues));

    const bData = store.read(bId, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(Array.from(bData.timestamps)).toEqual(Array.from(timestamps));
    expect(Array.from(bData.values)).toEqual(Array.from(bValues));
  });

  it("keeps failed compaction lanes retryable while promoted data remains readable", () => {
    let failNextEncode = false;
    const flakyCodec: ValuesCodec = {
      name: "flaky-identity",
      encodeValues(values: Float64Array): Uint8Array {
        if (failNextEncode) {
          failNextEncode = false;
          throw new Error("transient encode failure");
        }
        return new Uint8Array(
          values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength)
        );
      },
      decodeValues(buf: Uint8Array): Float64Array {
        return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      },
    };
    const store = new TieredRowGroupStore(flakyCodec, 4, 8, () => 0, 2);
    const aId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "a" }));
    const bId = store.getOrCreateSeries(makeLabels("tier_metric", { host: "b" }));

    const timestamps = new BigInt64Array(8);
    const aValues = new Float64Array(8);
    const bValues = new Float64Array(8);
    for (let i = 0; i < 8; i++) {
      timestamps[i] = BigInt(i) * 1_000n;
      aValues[i] = i;
      bValues[i] = 100 + i;
    }

    store.appendBatch(aId, timestamps, aValues);
    store.appendBatch(bId, timestamps, bValues);

    failNextEncode = true;
    expect(store.drainCompaction()).toBe(1);
    const promotedStore = Reflect.get(store, "promotedStore");
    const compactedStore = Reflect.get(store, "compactedStore");
    expect(promotedStore.sampleCount).toBe(16);
    expect(compactedStore.sampleCount).toBe(0);
    expect(Array.from(store.read(aId, 0n, BigInt(Number.MAX_SAFE_INTEGER)).values)).toEqual(
      Array.from(aValues)
    );

    expect(store.drainCompaction()).toBe(1);
    expect(promotedStore.sampleCount).toBe(0);
    expect(compactedStore.sampleCount).toBe(16);
    expect(Array.from(store.read(bId, 0n, BigInt(Number.MAX_SAFE_INTEGER)).values)).toEqual(
      Array.from(bValues)
    );
  });
});
