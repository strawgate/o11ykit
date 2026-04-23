import { describe, expect, it } from "vitest";
import { ScanEngine } from "../js/query.js";
import { FlatStore } from "../js/stores.js";

// ── Helpers ──────────────────────────────────────────────────────────

function buildStore(seriesData) {
  const store = new FlatStore();
  for (const { labels, timestamps, values } of seriesData) {
    const id = store.getOrCreateSeries(labels);
    store.appendBatch(id, new BigInt64Array(timestamps), new Float64Array(values));
  }
  return store;
}

const SEC = 1_000_000_000n; // 1 second in nanoseconds

function makeLabels(name, extra = {}) {
  const m = new Map([["__name__", name]]);
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return m;
}

// ── Aggregation tests ────────────────────────────────────────────────

describe("ScanEngine", () => {
  const engine = new ScanEngine();

  describe("no aggregation", () => {
    it("returns raw series data", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [10, 20],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
      });
      expect(result.series.length).toBe(1);
      expect(result.series[0].timestamps.length).toBe(2);
      expect(result.series[0].values[0]).toBeCloseTo(10);
      expect(result.series[0].values[1]).toBeCloseTo(20);
      expect(result.scannedSeries).toBe(1);
      expect(result.scannedSamples).toBe(2);
    });
  });

  describe("sum aggregation", () => {
    it("sums values across series", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [10, 20],
        },
        {
          labels: makeLabels("cpu", { host: "b" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [5, 15],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "sum",
        groupBy: [],
      });
      expect(result.series.length).toBe(1);
      expect(result.series[0].values[0]).toBeCloseTo(15); // 10 + 5
      expect(result.series[0].values[1]).toBeCloseTo(35); // 20 + 15
    });
  });

  describe("avg aggregation", () => {
    it("averages values across series", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [10, 20],
        },
        {
          labels: makeLabels("cpu", { host: "b" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [30, 40],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "avg",
        groupBy: [],
      });
      expect(result.series[0].values[0]).toBeCloseTo(20); // (10+30)/2
      expect(result.series[0].values[1]).toBeCloseTo(30); // (20+40)/2
    });

    it("emits avg partials from a single scan", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [10, 20],
        },
        {
          labels: makeLabels("cpu", { host: "b" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [30, 40],
        },
      ]);
      const partials = engine.queryAveragePartials(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "avg",
        groupBy: [],
      });
      expect(partials.sum.series).toHaveLength(1);
      expect(partials.count.series).toHaveLength(1);
      expect(partials.sum.series[0].values[0]).toBeCloseTo(40);
      expect(partials.sum.series[0].values[1]).toBeCloseTo(60);
      expect(partials.count.series[0].values[0]).toBeCloseTo(2);
      expect(partials.count.series[0].values[1]).toBeCloseTo(2);
      expect(partials.sum.scannedSamples).toBe(4);
      expect(partials.count.scannedSamples).toBe(4);
    });
  });

  describe("min aggregation", () => {
    it("finds minimum across series", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [10, 40],
        },
        {
          labels: makeLabels("cpu", { host: "b" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [5, 50],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "min",
        groupBy: [],
      });
      expect(result.series[0].values[0]).toBeCloseTo(5);
      expect(result.series[0].values[1]).toBeCloseTo(40);
    });
  });

  describe("max aggregation", () => {
    it("finds maximum across series", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [10, 40],
        },
        {
          labels: makeLabels("cpu", { host: "b" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [5, 50],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "max",
        groupBy: [],
      });
      expect(result.series[0].values[0]).toBeCloseTo(10);
      expect(result.series[0].values[1]).toBeCloseTo(50);
    });
  });

  describe("count aggregation", () => {
    it("counts contributions across series", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [10, 20],
        },
        {
          labels: makeLabels("cpu", { host: "b" }),
          timestamps: [1n * SEC, 2n * SEC],
          values: [5, 15],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "count",
        groupBy: [],
      });
      expect(result.series[0].values[0]).toBeCloseTo(2); // 2 series contribute
      expect(result.series[0].values[1]).toBeCloseTo(2);
    });
  });

  describe("rate aggregation", () => {
    it("calculates per-second rate", () => {
      const store = buildStore([
        {
          labels: makeLabels("requests", { host: "a" }),
          timestamps: [0n, 1n * SEC, 2n * SEC, 3n * SEC],
          values: [0, 100, 250, 500],
        },
      ]);
      const result = engine.query(store, {
        metric: "requests",
        start: 0n,
        end: 10n * SEC,
        agg: "rate",
        groupBy: [],
      });
      // rate[0] = 0 (first point has no previous)
      expect(result.series[0].values[0]).toBeCloseTo(0);
      // rate[1] = (100-0) / 1s = 100/s
      expect(result.series[0].values[1]).toBeCloseTo(100);
      // rate[2] = (250-100) / 1s = 150/s
      expect(result.series[0].values[2]).toBeCloseTo(150);
      // rate[3] = (500-250) / 1s = 250/s
      expect(result.series[0].values[3]).toBeCloseTo(250);
    });

    it("handles varying time gaps in rate", () => {
      const store = buildStore([
        {
          labels: makeLabels("bytes"),
          timestamps: [0n, 2n * SEC, 5n * SEC], // 2s gap, then 3s gap
          values: [0, 200, 500],
        },
      ]);
      const result = engine.query(store, {
        metric: "bytes",
        start: 0n,
        end: 10n * SEC,
        agg: "rate",
        groupBy: [],
      });
      // rate[1] = 200/2s = 100/s
      expect(result.series[0].values[1]).toBeCloseTo(100);
      // rate[2] = 300/3s = 100/s
      expect(result.series[0].values[2]).toBeCloseTo(100);
    });
  });

  describe("step-based downsampling", () => {
    it("buckets data into step intervals", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps: [0n, 1n * SEC, 2n * SEC, 3n * SEC, 4n * SEC, 5n * SEC],
          values: [10, 20, 30, 40, 50, 60],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "sum",
        step: 2n * SEC, // 2-second buckets
        groupBy: [],
      });
      // Buckets: [0,2s) [2s,4s) [4s,6s)
      // bucket 0: ts 0, 1 → values 10, 20 → sum 30
      // bucket 1: ts 2, 3 → values 30, 40 → sum 70
      // bucket 2: ts 4, 5 → values 50, 60 → sum 110
      expect(result.series[0].timestamps.length).toBe(3);
      expect(result.series[0].values[0]).toBeCloseTo(30);
      expect(result.series[0].values[1]).toBeCloseTo(70);
      expect(result.series[0].values[2]).toBeCloseTo(110);
    });

    it("output timestamps align to step boundaries", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu"),
          timestamps: [0n, 3n * SEC, 6n * SEC, 9n * SEC],
          values: [1, 2, 3, 4],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 20n * SEC,
        agg: "sum",
        step: 3n * SEC,
        groupBy: [],
      });
      // Check timestamps are evenly spaced at step intervals
      for (let i = 1; i < result.series[0].timestamps.length; i++) {
        const diff = result.series[0].timestamps[i] - result.series[0].timestamps[i - 1];
        expect(diff).toBe(3n * SEC);
      }
    });

    it("avg downsampling computes correct averages", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu"),
          timestamps: [0n, 1n * SEC, 2n * SEC, 3n * SEC],
          values: [10, 20, 30, 40],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "avg",
        step: 2n * SEC,
        groupBy: [],
      });
      // bucket 0: (10+20)/2 = 15
      // bucket 1: (30+40)/2 = 35
      expect(result.series[0].values[0]).toBeCloseTo(15);
      expect(result.series[0].values[1]).toBeCloseTo(35);
    });

    it("widens step automatically when maxPoints is lower than requested resolution", () => {
      const timestamps = [];
      const values = [];
      for (let i = 0; i < 100; i++) {
        timestamps.push(BigInt(i) * SEC);
        values.push(i);
      }
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a" }),
          timestamps,
          values,
        },
      ]);

      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 99n * SEC,
        agg: "sum",
        step: 1n * SEC,
        maxPoints: 10,
        groupBy: [],
      });

      expect(result.requestedStep).toBe(1n * SEC);
      expect(result.effectiveStep).toBeGreaterThan(1n * SEC);
      expect(result.series[0].timestamps.length).toBeLessThanOrEqual(10);
    });
  });

  describe("empty query result", () => {
    it("returns empty series for non-existent metric", () => {
      const store = buildStore([
        { labels: makeLabels("cpu"), timestamps: [1n * SEC], values: [42] },
      ]);
      const result = engine.query(store, {
        metric: "nonexistent",
        start: 0n,
        end: 10n * SEC,
      });
      expect(result.series.length).toBe(0);
      expect(result.scannedSeries).toBe(0);
      expect(result.scannedSamples).toBe(0);
    });

    it("returns empty series for non-existent metric with aggregation", () => {
      const store = buildStore([
        { labels: makeLabels("cpu"), timestamps: [1n * SEC], values: [42] },
      ]);
      const result = engine.query(store, {
        metric: "nonexistent",
        start: 0n,
        end: 10n * SEC,
        agg: "sum",
        groupBy: [],
      });
      expect(result.series.length).toBe(0);
    });
  });

  describe("label matchers", () => {
    it("filters by additional label matcher", () => {
      const store = buildStore([
        { labels: makeLabels("cpu", { host: "a" }), timestamps: [1n * SEC], values: [10] },
        { labels: makeLabels("cpu", { host: "b" }), timestamps: [1n * SEC], values: [20] },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        matchers: [{ label: "host", value: "a" }],
      });
      expect(result.series.length).toBe(1);
      expect(result.series[0].values[0]).toBeCloseTo(10);
      expect(result.scannedSeries).toBe(1);
    });
  });

  describe("groupBy", () => {
    it("groups aggregation by label", () => {
      const store = buildStore([
        {
          labels: makeLabels("cpu", { host: "a", dc: "us" }),
          timestamps: [1n * SEC],
          values: [10],
        },
        {
          labels: makeLabels("cpu", { host: "b", dc: "us" }),
          timestamps: [1n * SEC],
          values: [20],
        },
        {
          labels: makeLabels("cpu", { host: "c", dc: "eu" }),
          timestamps: [1n * SEC],
          values: [30],
        },
      ]);
      const result = engine.query(store, {
        metric: "cpu",
        start: 0n,
        end: 10n * SEC,
        agg: "sum",
        groupBy: ["dc"],
      });
      expect(result.series.length).toBe(2);
      // Find each group
      const us = result.series.find((s) => s.labels.get("dc") === "us");
      const eu = result.series.find((s) => s.labels.get("dc") === "eu");
      expect(us.values[0]).toBeCloseTo(30); // 10+20
      expect(eu.values[0]).toBeCloseTo(30);
    });
  });
});
