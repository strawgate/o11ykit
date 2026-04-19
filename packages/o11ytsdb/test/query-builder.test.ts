import { describe, expect, it } from "vitest";

import { FlatStore } from "../src/flat-store.js";
import type { PlanNode } from "../src/plan.js";
import { query } from "../src/query-builder.js";
import type { Labels } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeLabels(name: string, extra?: Record<string, string>): Labels {
  const m = new Map<string, string>();
  m.set("__name__", name);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) m.set(k, v);
  }
  return m;
}

/** 3 CPU series (hosts a, b, c) × 100 pts + 1 mem series × 50 pts. */
function populateStore(): FlatStore {
  const store = new FlatStore();
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
  const memId = store.getOrCreateSeries(makeLabels("mem", { host: "a" }));
  for (let i = 0; i < 50; i++) {
    store.append(memId, 1_000_000n + BigInt(i) * 15_000n, 8192 + i);
  }
  return store;
}

// ── Plan compilation tests ───────────────────────────────────────────

describe("QueryBuilder — plan compilation", () => {
  it("compiles a simple metric + range to SelectNode → TimeRangeNode", () => {
    const plan = query().metric("cpu").range(0n, 100n).plan();

    expect(plan.kind).toBe("timeRange");
    const tr = plan as Extract<PlanNode, { kind: "timeRange" }>;
    expect(tr.start).toBe(0n);
    expect(tr.end).toBe(100n);
    expect(tr.input.kind).toBe("select");
    const sel = tr.input as Extract<PlanNode, { kind: "select" }>;
    expect(sel.metric).toBe("cpu");
    expect(sel.matchers).toEqual([]);
  });

  it("compiles matchers into the SelectNode", () => {
    const plan = query()
      .metric("http_requests")
      .where("method", "=", "GET")
      .where("status", "=~", "2..")
      .range(0n, 100n)
      .plan();

    const tr = plan as Extract<PlanNode, { kind: "timeRange" }>;
    const sel = tr.input as Extract<PlanNode, { kind: "select" }>;
    expect(sel.matchers).toEqual([
      { label: "method", op: "=", value: "GET" },
      { label: "status", op: "=~", value: "2.." },
    ]);
  });

  it("compiles rate() as a TransformNode", () => {
    const plan = query().metric("cpu").range(0n, 100n).rate().plan();

    expect(plan.kind).toBe("transform");
    const t = plan as Extract<PlanNode, { kind: "transform" }>;
    expect(t.fn).toBe("rate");
    expect(t.input.kind).toBe("timeRange");
  });

  it("compiles step + sumBy as an AggregateNode", () => {
    const plan = query().metric("cpu").range(0n, 100n).step(60_000n).sumBy("host").plan();

    expect(plan.kind).toBe("aggregate");
    const agg = plan as Extract<PlanNode, { kind: "aggregate" }>;
    expect(agg.fn).toBe("sum");
    expect(agg.step).toBe(60_000n);
    expect(agg.groupBy).toEqual(["host"]);
    expect(agg.input.kind).toBe("timeRange");
  });

  it("compiles rate → step → sumBy as Aggregate(Transform(TimeRange(Select)))", () => {
    const plan = query()
      .metric("http_requests")
      .where("method", "=", "GET")
      .range(0n, 1000n)
      .rate()
      .step(60_000n)
      .sumBy("endpoint")
      .plan();

    // Outermost: aggregate
    expect(plan.kind).toBe("aggregate");
    const agg = plan as Extract<PlanNode, { kind: "aggregate" }>;
    expect(agg.fn).toBe("sum");
    expect(agg.step).toBe(60_000n);
    expect(agg.groupBy).toEqual(["endpoint"]);

    // Next: transform(rate)
    expect(agg.input.kind).toBe("transform");
    const t = agg.input as Extract<PlanNode, { kind: "transform" }>;
    expect(t.fn).toBe("rate");

    // Next: timeRange
    expect(t.input.kind).toBe("timeRange");
    const tr = t.input as Extract<PlanNode, { kind: "timeRange" }>;
    expect(tr.start).toBe(0n);
    expect(tr.end).toBe(1000n);

    // Innermost: select
    expect(tr.input.kind).toBe("select");
    const sel = tr.input as Extract<PlanNode, { kind: "select" }>;
    expect(sel.metric).toBe("http_requests");
    expect(sel.matchers).toEqual([{ label: "method", op: "=", value: "GET" }]);
  });

  it("compiles aggregation without step", () => {
    const plan = query().metric("cpu").range(0n, 100n).avg().plan();

    expect(plan.kind).toBe("aggregate");
    const agg = plan as Extract<PlanNode, { kind: "aggregate" }>;
    expect(agg.fn).toBe("avg");
    expect(agg.step).toBeUndefined();
    expect(agg.groupBy).toBeUndefined();
  });

  it("compiles multiple transforms in order", () => {
    const plan = query().metric("cpu").range(0n, 100n).abs().rate().plan();

    // Outermost transform is the last one added (rate)
    expect(plan.kind).toBe("transform");
    const outer = plan as Extract<PlanNode, { kind: "transform" }>;
    expect(outer.fn).toBe("rate");

    // Inner transform is abs
    expect(outer.input.kind).toBe("transform");
    const inner = outer.input as Extract<PlanNode, { kind: "transform" }>;
    expect(inner.fn).toBe("abs");

    expect(inner.input.kind).toBe("timeRange");
  });

  it("is immutable — each method returns a new builder", () => {
    const b1 = query().metric("cpu");
    const b2 = b1.where("host", "=", "a");
    const b3 = b1.where("host", "=", "b");

    const p2 = b2.range(0n, 100n).plan();
    const p3 = b3.range(0n, 100n).plan();

    const sel2 = (p2 as Extract<PlanNode, { kind: "timeRange" }>).input as Extract<
      PlanNode,
      { kind: "select" }
    >;
    const sel3 = (p3 as Extract<PlanNode, { kind: "timeRange" }>).input as Extract<
      PlanNode,
      { kind: "select" }
    >;

    expect(sel2.matchers).toEqual([{ label: "host", op: "=", value: "a" }]);
    expect(sel3.matchers).toEqual([{ label: "host", op: "=", value: "b" }]);
  });

  // ── Validation ───────────────────────────────────────────────────

  it("throws when metric is missing", () => {
    expect(() => query().range(0n, 100n).plan()).toThrow("metric() is required");
  });

  it("throws when range is missing", () => {
    expect(() => query().metric("cpu").plan()).toThrow("range() is required");
  });
});

// ── Execution tests ──────────────────────────────────────────────────

describe("QueryBuilder — exec()", () => {
  it("executes a raw query (no aggregation)", () => {
    const store = populateStore();
    const result = query().metric("cpu").range(0n, 100_000_000n).exec(store);

    expect(result.series.length).toBe(3);
    expect(result.scannedSeries).toBe(3);
    for (const s of result.series) {
      expect(s.timestamps.length).toBe(100);
    }
  });

  it("executes with a label matcher", () => {
    const store = populateStore();
    const result = query()
      .metric("cpu")
      .where("host", "=", "a")
      .range(0n, 100_000_000n)
      .exec(store);

    expect(result.series.length).toBe(1);
    expect(result.series[0]?.labels.get("host")).toBe("a");
  });

  it("executes sum aggregation", () => {
    const store = populateStore();
    const result = query().metric("cpu").range(0n, 100_000_000n).sum().exec(store);

    // sum across 3 series → 1 output series
    expect(result.series.length).toBe(1);
    expect(result.series[0]?.timestamps.length).toBe(100);
  });

  it("executes step-aligned avg with groupBy", () => {
    const store = populateStore();
    const result = query()
      .metric("cpu")
      .range(0n, 100_000_000n)
      .step(60_000n)
      .avgBy("region")
      .exec(store);

    // All series have region=us-east → 1 group
    expect(result.series.length).toBe(1);
    // Step-aligned: 60s step over ~1.5M ms range → multiple buckets
    expect(result.series[0]?.timestamps.length).toBeGreaterThan(1);
  });

  it("executes rate()", () => {
    const store = populateStore();
    const result = query().metric("cpu").range(0n, 100_000_000n).rate().step(60_000n).exec(store);

    // rate without agg but with step → rate step-aggregation per series
    expect(result.series.length).toBeGreaterThan(0);
    for (const s of result.series) {
      expect(s.timestamps.length).toBeGreaterThan(0);
    }
  });

  // ── Unsupported operations ─────────────────────────────────────

  it("throws for regex matcher (not yet supported)", () => {
    const store = populateStore();
    expect(() =>
      query().metric("cpu").where("host", "=~", "a|b").range(0n, 100_000_000n).exec(store)
    ).toThrow("Matcher operator '=~' is not yet supported");
  });

  it("throws for != matcher (not yet supported)", () => {
    const store = populateStore();
    expect(() =>
      query().metric("cpu").where("host", "!=", "c").range(0n, 100_000_000n).exec(store)
    ).toThrow("Matcher operator '!=' is not yet supported");
  });

  it("throws for compound rate() + sum() (not yet supported)", () => {
    const store = populateStore();
    expect(() =>
      query().metric("cpu").range(0n, 100_000_000n).rate().step(60_000n).sumBy("host").exec(store)
    ).toThrow("Compound rate() + sum() is not yet supported");
  });
});
