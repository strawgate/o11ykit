import { describe, expect, it } from "vitest";

import { ColumnStore } from "../src/column-store.js";
import { FlatStore } from "../src/flat-store.js";
import { ScanEngine } from "../src/query.js";
// biome-ignore lint/correctness/noUnusedImports: test code
import type { Labels, StorageBackend, ValuesCodec } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeLabels(name: string, extra?: Record<string, string>): Labels {
  const m = new Map<string, string>();
  m.set("__name__", name);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) m.set(k, v);
  }
  return m;
}

function populateStore(): FlatStore {
  const store = new FlatStore();
  // 3 CPU series for hosts a, b, c — each with 100 points
  for (const host of ["a", "b", "c"]) {
    const id = store.getOrCreateSeries(makeLabels("cpu", { host, region: "us-east" }));
    for (let i = 0; i < 100; i++) {
      store.append(
        id,
        1_000_000n + BigInt(i) * 15_000n,
        10 + (host.charCodeAt(0) - 97) * 10 + i * 0.1
      );
    }
  }
  // 1 memory series
  const memId = store.getOrCreateSeries(makeLabels("mem", { host: "a" }));
  for (let i = 0; i < 50; i++) {
    store.append(memId, 1_000_000n + BigInt(i) * 15_000n, 8192 + i);
  }
  return store;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ScanEngine", () => {
  const engine = new ScanEngine();

  it("queries single metric without aggregation", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(result.series.length).toBe(3);
    expect(result.scannedSeries).toBe(3);
    expect(result.scannedSamples).toBe(300);
  });

  it("filters by label matcher", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      matchers: [{ label: "host", value: "b" }],
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(result.series.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.labels.get("host")).toBe("b");
  });

  it("filters by time range", () => {
    const store = populateStore();
    const start = 1_000_000n + 50n * 15_000n;
    const end = 1_000_000n + 70n * 15_000n;
    const result = engine.query(store, {
      metric: "cpu",
      matchers: [{ label: "host", value: "a" }],
      start,
      end,
    });
    expect(result.series.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBeGreaterThanOrEqual(15);
    expect(s.timestamps.length).toBeLessThanOrEqual(25);
  });

  it("returns empty for non-existent metric", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "nonexistent",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(result.series.length).toBe(0);
    expect(result.scannedSeries).toBe(0);
  });

  it("aggregates with sum", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "sum",
    });
    expect(result.series.length).toBe(1);
    // Sum of 3 series at each point
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(100);
    // First point: 10 + 20 + 30 = 60
    expect(s.values[0]).toBeCloseTo(60);
  });

  it("aggregates with avg", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "avg",
    });
    expect(result.series.length).toBe(1);
    // Avg of 10, 20, 30 = 20
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.values[0]).toBeCloseTo(20);
  });

  it("aggregates with min", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "min",
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.values[0]).toBeCloseTo(10);
  });

  it("aggregates with max", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "max",
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.values[0]).toBeCloseTo(30);
  });

  it("aggregates with count", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "count",
    });
    // 3 series contribute to each point
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.values[0]).toBe(3);
  });

  it("aggregates with rate", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("counter"));
    // Counter: 0, 100, 200, 300 at 1-second intervals (1e9 ns)
    for (let i = 0; i < 4; i++) {
      store.append(id, BigInt(i) * 1_000_000_000n, i * 100);
    }
    const result = engine.query(store, {
      metric: "counter",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "rate",
    });
    // rate = delta_v / delta_t (in seconds, but delta is in ms)
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(4);
    // First rate is 0 (no previous)
    expect(s.values[0]).toBe(0);
    // Subsequent: 100 / (1e9/1000) = 100 / 1e6 = 0.0001
    expect(s.values[1]).toBeCloseTo(0.0001);
  });

  // ── stepAggregate value-correctness tests ────────────────────────

  /**
   * Helper: creates a store with deterministic values for step-agg testing.
   * 2 series, 6 points each at 1s intervals (0, 1000, 2000, 3000, 4000, 5000).
   *   series A: values [10, 20, 30, 40, 50, 60]
   *   series B: values [1,  2,  3,  4,  5,  6]
   * With step=2000, buckets are:
   *   bucket 0 (t=0):    A:10,20  B:1,2
   *   bucket 1 (t=2000): A:30,40  B:3,4
   *   bucket 2 (t=4000): A:50,60  B:5,6
   */
  function makeStepStore(): FlatStore {
    const store = new FlatStore();
    const idA = store.getOrCreateSeries(makeLabels("m", { host: "a", region: "us" }));
    const idB = store.getOrCreateSeries(makeLabels("m", { host: "b", region: "eu" }));
    for (let i = 0; i < 6; i++) {
      store.append(idA, BigInt(i) * 1_000n, (i + 1) * 10);
      store.append(idB, BigInt(i) * 1_000n, i + 1);
    }
    return store;
  }

  it("step aggregation sum computes correct values", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "sum",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    // bucket 0: 10+20+1+2 = 33
    expect(s.values[0]).toBeCloseTo(33);
    // bucket 1: 30+40+3+4 = 77
    expect(s.values[1]).toBeCloseTo(77);
    // bucket 2: 50+60+5+6 = 121
    expect(s.values[2]).toBeCloseTo(121);
  });

  it("step aggregation min computes correct values", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "min",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    // bucket 0: min(10,20,1,2) = 1
    expect(s.values[0]).toBe(1);
    // bucket 1: min(30,40,3,4) = 3
    expect(s.values[1]).toBe(3);
    // bucket 2: min(50,60,5,6) = 5
    expect(s.values[2]).toBe(5);
  });

  it("step aggregation max computes correct values", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "max",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    // bucket 0: max(10,20,1,2) = 20
    expect(s.values[0]).toBe(20);
    // bucket 1: max(30,40,3,4) = 40
    expect(s.values[1]).toBe(40);
    // bucket 2: max(50,60,5,6) = 60
    expect(s.values[2]).toBe(60);
  });

  it("step aggregation avg computes correct values", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "avg",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    // bucket 0: (10+20+1+2)/4 = 8.25
    expect(s.values[0]).toBeCloseTo(8.25);
    // bucket 1: (30+40+3+4)/4 = 19.25
    expect(s.values[1]).toBeCloseTo(19.25);
    // bucket 2: (50+60+5+6)/4 = 30.25
    expect(s.values[2]).toBeCloseTo(30.25);
  });

  it("step aggregation count computes correct values", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "count",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    // Each bucket: 2 samples from A + 2 from B = 4
    expect(s.values[0]).toBe(4);
    expect(s.values[1]).toBe(4);
    expect(s.values[2]).toBe(4);
  });

  it("step aggregation last computes correct values", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "last",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    // last overwrites in insertion order: A then B processed sequentially
    // bucket 0: A writes 10,20 → B writes 1,2 → last value seen = 2
    expect(s.values[0]).toBe(2);
    // bucket 1: last = 4
    expect(s.values[1]).toBe(4);
    // bucket 2: last = 6
    expect(s.values[2]).toBe(6);
  });

  it("step aggregation bucket timestamps are aligned to step", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "sum",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const ts = result.series[0]!.timestamps;
    expect(ts[0]).toBe(0n);
    expect(ts[1]).toBe(2_000n);
    expect(ts[2]).toBe(4_000n);
  });

  // ── stepAggregate rate ─────────────────────────────────────────────

  it("step aggregation rate computes per-bucket derivative", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("counter"));
    // Counter: 0, 100, 200, 300, 400, 500 at 1s intervals
    for (let i = 0; i < 6; i++) {
      store.append(id, BigInt(i) * 1_000n, i * 100);
    }
    // step=2000 → 3 buckets:
    //   bucket 0 (t=0):    values 0,100   → rate = (100-0)/(1000-0)/1000 = 100/1 = 100/s
    //   bucket 1 (t=2000): values 200,300 → rate = (300-200)/(3000-2000)/1000 = 100/1 = 100/s
    //   bucket 2 (t=4000): values 400,500 → rate = (500-400)/(5000-4000)/1000 = 100/1 = 100/s
    const result = engine.query(store, {
      metric: "counter",
      start: 0n,
      end: 6_000n,
      agg: "rate",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    // (100 - 0) / ((1000 - 0) / 1000) = 100 / 1 = 100
    expect(s.values[0]).toBeCloseTo(100);
    expect(s.values[1]).toBeCloseTo(100);
    expect(s.values[2]).toBeCloseTo(100);
  });

  it("step aggregation rate with varying rate", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("counter"));
    // bucket 0: t=0 v=0, t=1000 v=50  → rate = 50/s
    // bucket 1: t=2000 v=50, t=3000 v=250 → rate = 200/s
    store.append(id, 0n, 0);
    store.append(id, 1_000n, 50);
    store.append(id, 2_000n, 50);
    store.append(id, 3_000n, 250);
    const result = engine.query(store, {
      metric: "counter",
      start: 0n,
      end: 4_000n,
      agg: "rate",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(2);
    expect(s.values[0]).toBeCloseTo(50);
    expect(s.values[1]).toBeCloseTo(200);
  });

  it("step aggregation rate with single point per bucket produces 0", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("counter"));
    // One point per bucket → dt=0 → rate=0
    store.append(id, 0n, 100);
    store.append(id, 5_000n, 200);
    const result = engine.query(store, {
      metric: "counter",
      start: 0n,
      end: 6_000n,
      agg: "rate",
      step: 3_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(2);
    // Each bucket has only one point: dt=0 → rate=0
    expect(s.values[0]).toBe(0);
    expect(s.values[1]).toBe(0);
  });

  it("step aggregation rate with empty bucket produces NaN", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("counter"));
    store.append(id, 0n, 100);
    store.append(id, 4_000n, 200);
    const result = engine.query(store, {
      metric: "counter",
      start: 0n,
      end: 5_000n,
      agg: "rate",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    expect(s.values[0]).toBe(0); // single point → rate=0
    expect(s.values[1]).toBeNaN(); // empty bucket → NaN
    expect(s.values[2]).toBe(0); // single point → rate=0
  });

  // ── stepAggregate edge cases ───────────────────────────────────────

  it("step aggregation with single point produces one bucket", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("single"));
    store.append(id, 5_000n, 42);
    const result = engine.query(store, {
      metric: "single",
      start: 0n,
      end: 10_000n,
      agg: "sum",
      step: 3_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.timestamps.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.values[0]).toBe(42);
  });

  it("step aggregation with step larger than data span produces one bucket", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "sum",
      step: 100_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(1);
    // All 12 values: (10+20+30+40+50+60) + (1+2+3+4+5+6) = 210 + 21 = 231
    expect(s.values[0]).toBeCloseTo(231);
  });

  it("step aggregation with empty buckets produces NaN", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("sparse"));
    // Points at t=0 and t=4000 → bucket at t=2000 has no data
    store.append(id, 0n, 10);
    store.append(id, 4_000n, 50);
    const result = engine.query(store, {
      metric: "sparse",
      start: 0n,
      end: 5_000n,
      agg: "min",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(3);
    expect(s.values[0]).toBe(10); // bucket 0: has data
    expect(s.values[1]).toBeNaN(); // bucket 1: empty → NaN
    expect(s.values[2]).toBe(50); // bucket 2: has data
  });

  it("step aggregation empty buckets NaN for max", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("sparse"));
    store.append(id, 0n, 10);
    store.append(id, 4_000n, 50);
    const result = engine.query(store, {
      metric: "sparse",
      start: 0n,
      end: 5_000n,
      agg: "max",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.values[0]).toBe(10);
    expect(s.values[1]).toBeNaN();
    expect(s.values[2]).toBe(50);
  });

  it("step aggregation empty buckets NaN for avg", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("sparse"));
    store.append(id, 0n, 10);
    store.append(id, 4_000n, 50);
    const result = engine.query(store, {
      metric: "sparse",
      start: 0n,
      end: 5_000n,
      agg: "avg",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.values[0]).toBe(10);
    expect(s.values[1]).toBeNaN();
    expect(s.values[2]).toBe(50);
  });

  it("step aggregation empty buckets are 0 for sum and count", () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels("sparse"));
    store.append(id, 0n, 10);
    store.append(id, 4_000n, 50);
    // sum: empty bucket stays 0
    const sumResult = engine.query(store, {
      metric: "sparse",
      start: 0n,
      end: 5_000n,
      agg: "sum",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(sumResult.series[0]!.values[1]).toBe(0);
    // count: empty bucket stays 0
    const countResult = engine.query(store, {
      metric: "sparse",
      start: 0n,
      end: 5_000n,
      agg: "count",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(countResult.series[0]!.values[1]).toBe(0);
  });

  // ── groupBy + step combined ────────────────────────────────────────

  it("groupBy + step produces correct per-group values", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "sum",
      step: 2_000n,
      groupBy: ["region"],
    });
    // 2 regions: 'us' (host a) and 'eu' (host b)
    expect(result.series.length).toBe(2);

    // biome-ignore lint/style/noNonNullAssertion: test code
    const us = result.series.find((s) => s.labels.get("region") === "us")!;
    // biome-ignore lint/style/noNonNullAssertion: test code
    const eu = result.series.find((s) => s.labels.get("region") === "eu")!;
    expect(us).toBeDefined();
    expect(eu).toBeDefined();

    // US (series A only): bucket 0: 10+20=30, bucket 1: 30+40=70, bucket 2: 50+60=110
    expect(us.values[0]).toBeCloseTo(30);
    expect(us.values[1]).toBeCloseTo(70);
    expect(us.values[2]).toBeCloseTo(110);

    // EU (series B only): bucket 0: 1+2=3, bucket 1: 3+4=7, bucket 2: 5+6=11
    expect(eu.values[0]).toBeCloseTo(3);
    expect(eu.values[1]).toBeCloseTo(7);
    expect(eu.values[2]).toBeCloseTo(11);
  });

  it("groupBy + step min produces correct per-group values", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "min",
      step: 2_000n,
      groupBy: ["host"],
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const a = result.series.find((s) => s.labels.get("host") === "a")!;
    // biome-ignore lint/style/noNonNullAssertion: test code
    const b = result.series.find((s) => s.labels.get("host") === "b")!;
    // Host a: bucket 0: min(10,20)=10, bucket 1: min(30,40)=30, bucket 2: min(50,60)=50
    expect(a.values[0]).toBe(10);
    expect(a.values[1]).toBe(30);
    expect(a.values[2]).toBe(50);
    // Host b: bucket 0: min(1,2)=1, bucket 1: min(3,4)=3, bucket 2: min(5,6)=5
    expect(b.values[0]).toBe(1);
    expect(b.values[1]).toBe(3);
    expect(b.values[2]).toBe(5);
  });

  it("groupBy with no groupBy key returns single group", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "sum",
    });
    // No groupBy → all series aggregated into one
    expect(result.series.length).toBe(1);
    // First point: 10 + 20 + 30 = 60
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.values[0]).toBeCloseTo(60);
  });

  // ── pointAggregate coverage ────────────────────────────────────────

  it("aggregates with last (pointAggregate)", () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: "cpu",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "last",
    });
    expect(result.series.length).toBe(1);
    // last overwrites sequentially: a=10, b=20, c=30 → last = 30
    // biome-ignore lint/style/noNonNullAssertion: test code
    expect(result.series[0]!.values[0]).toBe(30);
  });

  it("pointAggregate handles unequal-length series", () => {
    const store = new FlatStore();
    const idA = store.getOrCreateSeries(makeLabels("m", { host: "x" }));
    const idB = store.getOrCreateSeries(makeLabels("m", { host: "y" }));
    // A has 5 points, B has 3
    for (let i = 0; i < 5; i++) store.append(idA, BigInt(i) * 1_000n, 10);
    for (let i = 0; i < 3; i++) store.append(idB, BigInt(i) * 1_000n, 20);

    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 10_000n,
      agg: "sum",
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    // Longest series (A) has 5 points, so output has 5 timestamps
    expect(s.timestamps.length).toBe(5);
    // First 3 points: 10+20 = 30
    expect(s.values[0]).toBeCloseTo(30);
    expect(s.values[2]).toBeCloseTo(30);
    // Last 2 points: only A contributes → 10
    expect(s.values[3]).toBeCloseTo(10);
    expect(s.values[4]).toBeCloseTo(10);
  });

  // ── scannedSamples tracking ────────────────────────────────────────

  it("scannedSamples is correct with step aggregation", () => {
    const store = makeStepStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 6_000n,
      agg: "sum",
      step: 2_000n,
    });
    // 2 series × 6 points = 12
    expect(result.scannedSamples).toBe(12);
    expect(result.scannedSeries).toBe(2);
  });

  it("handles empty store gracefully", () => {
    const store = new FlatStore();
    const result = engine.query(store, {
      metric: "anything",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(result.series.length).toBe(0);
  });

  it("handles aggregation on empty result", () => {
    const store = new FlatStore();
    const result = engine.query(store, {
      metric: "nothing",
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: "sum",
    });
    expect(result.series.length).toBe(0);
    expect(result.scannedSamples).toBe(0);
  });

  // ── ChunkStats-skip tests (ColumnStore with frozen chunks) ─────────

  /**
   * Identity values codec — stores raw Float64Array bytes.
   * ColumnStore computes ChunkStats via computeStats() when codec
   * doesn't provide encodeValuesWithStats.
   */
  const identityValuesCodec: ValuesCodec = {
    name: "identity",
    encodeValues(values: Float64Array): Uint8Array {
      return new Uint8Array(values.buffer.slice(0));
    },
    decodeValues(buf: Uint8Array): Float64Array {
      return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    },
  };

  /**
   * Helper: creates a ColumnStore (chunk=4) with 1 series, 8 points at 1s intervals.
   * Values: [10, 20, 30, 40, 50, 60, 70, 80]
   * This produces 2 frozen chunks (4 samples each) so stats-skip can be exercised.
   * Chunk 0: t=[0,1000,2000,3000], v=[10,20,30,40] → min=10, max=40, sum=100, count=4
   * Chunk 1: t=[4000,5000,6000,7000], v=[50,60,70,80] → min=50, max=80, sum=260, count=4
   */
  function makeStatsStore(): ColumnStore {
    const store = new ColumnStore(identityValuesCodec, 4);
    const id = store.getOrCreateSeries(makeLabels("m"));
    for (let i = 0; i < 8; i++) {
      store.append(id, BigInt(i) * 1_000n, (i + 1) * 10);
    }
    return store;
  }

  it("stats-skip: sum with large step uses chunk stats", () => {
    const store = makeStatsStore();
    // step=4000 → 2 buckets, each chunk fits exactly in one bucket
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "sum",
      step: 4_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(2);
    // Chunk 0: sum(10,20,30,40) = 100
    expect(s.values[0]).toBeCloseTo(100);
    // Chunk 1: sum(50,60,70,80) = 260
    expect(s.values[1]).toBeCloseTo(260);
  });

  it("stats-skip: min with large step uses chunk stats", () => {
    const store = makeStatsStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "min",
      step: 4_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.values[0]).toBe(10);
    expect(s.values[1]).toBe(50);
  });

  it("stats-skip: max with large step uses chunk stats", () => {
    const store = makeStatsStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "max",
      step: 4_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.values[0]).toBe(40);
    expect(s.values[1]).toBe(80);
  });

  it("stats-skip: avg with large step uses chunk stats", () => {
    const store = makeStatsStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "avg",
      step: 4_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    // Chunk 0: avg(10,20,30,40) = 25
    expect(s.values[0]).toBeCloseTo(25);
    // Chunk 1: avg(50,60,70,80) = 65
    expect(s.values[1]).toBeCloseTo(65);
  });

  it("stats-skip: count with large step uses chunk stats", () => {
    const store = makeStatsStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "count",
      step: 4_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.values[0]).toBe(4);
    expect(s.values[1]).toBe(4);
  });

  it("stats-skip: last with large step uses chunk stats", () => {
    const store = makeStatsStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "last",
      step: 4_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.values[0]).toBe(40); // last of chunk 0
    expect(s.values[1]).toBe(80); // last of chunk 1
  });

  it("stats-skip: single big bucket (step > data span) uses stats", () => {
    const store = makeStatsStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 10_000n,
      agg: "sum",
      step: 100_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(1);
    // sum(10..80) = 360
    expect(s.values[0]).toBeCloseTo(360);
  });

  it("stats-skip: scannedSamples counts stats-only parts", () => {
    const store = makeStatsStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "sum",
      step: 4_000n,
    });
    // 8 samples total (2 chunks × 4)
    expect(result.scannedSamples).toBe(8);
  });

  it("stats-skip: small step lazy-decodes chunks spanning multiple buckets", () => {
    const store = makeStatsStore();
    // step=2000 → 4 buckets; each 4-sample chunk spans 2 buckets → lazy decode
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "sum",
      step: 2_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(4);
    // Bucket 0 [0,2000): t=0→10, t=1000→20 → sum=30
    expect(s.values[0]).toBeCloseTo(30);
    // Bucket 1 [2000,4000): t=2000→30, t=3000→40 → sum=70
    expect(s.values[1]).toBeCloseTo(70);
    // Bucket 2 [4000,6000): t=4000→50, t=5000→60 → sum=110
    expect(s.values[2]).toBeCloseTo(110);
    // Bucket 3 [6000,8000): t=6000→70, t=7000→80 → sum=150
    expect(s.values[3]).toBeCloseTo(150);
  });

  it("stats-skip: rate with ColumnStore lazy-decodes correctly", () => {
    const store = makeStatsStore();
    const result = engine.query(store, {
      metric: "m",
      start: 0n,
      end: 8_000n,
      agg: "rate",
      step: 4_000n,
    });
    // biome-ignore lint/style/noNonNullAssertion: test code
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(2);
    // Each bucket has 4 points at 1s intervals, values increase by 10 each
    // rate = (last - first) / (lastT - firstT) * 1000 = (40-10)/(3000) * 1000 = 10
    expect(s.values[0]).toBeCloseTo(10);
    expect(s.values[1]).toBeCloseTo(10);
  });
});
