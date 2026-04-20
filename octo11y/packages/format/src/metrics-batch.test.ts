import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetricsBatch, seriesKey } from "./metrics-batch.js";
import type { OtlpMetricsDocument } from "./types.js";
import { buildOtlpResult } from "./build-otlp-result.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(): OtlpMetricsDocument {
  return buildOtlpResult({
    benchmarks: [
      {
        name: "BenchmarkSort",
        tags: { impl: "quicksort" },
        metrics: {
          "ns/op": { value: 1500, unit: "ns", direction: "smaller_is_better" },
          "allocs/op": { value: 3, unit: "1" },
        },
      },
      {
        name: "BenchmarkSearch",
        metrics: {
          "ns/op": { value: 800, unit: "ns", direction: "smaller_is_better" },
        },
      },
      {
        name: "_monitor.cpu_user_pct",
        metrics: {
          "_monitor.cpu_user_pct": { value: 42.5, unit: "%" },
        },
      },
    ],
    context: {
      sourceFormat: "go",
      runId: "123-1",
      kind: "code",
      ref: "refs/heads/main",
      commit: "abc123",
    },
  });
}

// ---------------------------------------------------------------------------
// fromOtlp
// ---------------------------------------------------------------------------

describe("MetricsBatch.fromOtlp", () => {
  it("flattens OTLP into MetricPoints", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    assert.equal(batch.size, 4);
  });

  it("extracts resource context", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    assert.equal(batch.context.runId, "123-1");
    assert.equal(batch.context.kind, "code");
    assert.equal(batch.context.sourceFormat, "go");
    assert.equal(batch.context.ref, "refs/heads/main");
    assert.equal(batch.context.commit, "abc123");
  });

  it("extracts scenario from datapoint attributes", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const sort = batch.points.filter((p) => p.scenario === "BenchmarkSort");
    assert.equal(sort.length, 2);
  });

  it("extracts tags excluding reserved attributes", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const p = batch.points.find((p) => p.scenario === "BenchmarkSort" && p.metric === "ns/op");
    assert.ok(p, "metrics-batch.test.ts: missing BenchmarkSort/ns/op point in fromOtlp tag extraction");
    assert.equal(p.tags["impl"], "quicksort");
    assert.equal(p.tags["benchkit.scenario"], undefined);
  });

  it("extracts direction and unit", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const p = batch.points.find((p) => p.scenario === "BenchmarkSort" && p.metric === "ns/op");
    assert.ok(
      p,
      "metrics-batch.test.ts: missing BenchmarkSort/ns/op point in fromOtlp direction/unit extraction",
    );
    assert.equal(p.direction, "smaller_is_better");
    assert.equal(p.unit, "ns");
  });
});

// ---------------------------------------------------------------------------
// fromPoints
// ---------------------------------------------------------------------------

describe("MetricsBatch.fromPoints", () => {
  it("creates batch from raw points", () => {
    const batch = MetricsBatch.fromPoints([
      { scenario: "A", series: "A", metric: "x", value: 1, unit: "", direction: undefined, role: undefined, tags: {}, timestamp: undefined },
    ]);
    assert.equal(batch.size, 1);
    assert.equal(batch.context.runId, undefined);
  });
});

// ---------------------------------------------------------------------------
// Scalar accessors
// ---------------------------------------------------------------------------

describe("MetricsBatch accessors", () => {
  it("scenarios returns sorted unique scenarios", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    assert.deepEqual(batch.scenarios, ["BenchmarkSearch", "BenchmarkSort", "_monitor.cpu_user_pct"]);
  });

  it("metricNames returns sorted unique metric names", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    assert.deepEqual(batch.metricNames, ["_monitor.cpu_user_pct", "allocs/op", "ns/op"]);
  });
});

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

describe("MetricsBatch.filter", () => {
  it("filter keeps matching points", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const filtered = batch.filter((p) => p.value > 100);
    assert.equal(filtered.size, 2); // 1500, 800
  });

  it("forScenario filters by scenario name", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const sort = batch.forScenario("BenchmarkSort");
    assert.equal(sort.size, 2);
    assert.ok(sort.points.every((p) => p.scenario === "BenchmarkSort"));
  });

  it("forMetric filters by metric name", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const nsOp = batch.forMetric("ns/op");
    assert.equal(nsOp.size, 2); // Sort + Search
  });

  it("withoutMonitor excludes monitor metrics", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const noMonitor = batch.withoutMonitor();
    assert.equal(noMonitor.size, 3);
    assert.ok(noMonitor.points.every((p) => !p.metric.startsWith("_monitor.")));
  });

  it("onlyMonitor keeps only monitor metrics", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const monitor = batch.onlyMonitor();
    assert.equal(monitor.size, 1);
    assert.equal(monitor.points[0].metric, "_monitor.cpu_user_pct");
  });

  it("filters are chainable", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const result = batch.withoutMonitor().forMetric("ns/op").forScenario("BenchmarkSort");
    assert.equal(result.size, 1);
    assert.equal(result.points[0].value, 1500);
  });
});

// ---------------------------------------------------------------------------
// GroupBy
// ---------------------------------------------------------------------------

describe("MetricsBatch.groupBy", () => {
  it("groupByScenario groups points by scenario", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const groups = batch.groupByScenario();
    assert.equal(groups.size, 3);
    assert.equal(groups.get("BenchmarkSort")!.size, 2);
    assert.equal(groups.get("BenchmarkSearch")!.size, 1);
  });

  it("groupByMetric groups points by metric name", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const groups = batch.groupByMetric();
    assert.equal(groups.get("ns/op")!.size, 2);
    assert.equal(groups.get("allocs/op")!.size, 1);
  });

  it("groupBySeries uses name + sorted tags", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const groups = batch.groupBySeries();
    // BenchmarkSort has tag impl=quicksort
    assert.ok(groups.has("BenchmarkSort [impl=quicksort]"));
    // BenchmarkSearch has no tags
    assert.ok(groups.has("BenchmarkSearch"));
  });

  it("custom groupBy works", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const groups = batch.groupBy((p) => p.unit);
    assert.ok(groups.has("ns"));
    assert.ok(groups.has("1"));
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe("MetricsBatch.merge", () => {
  it("merges multiple batches", () => {
    const a = MetricsBatch.fromPoints([
      { scenario: "A", series: "A", metric: "x", value: 1, unit: "", direction: undefined, role: undefined, tags: {}, timestamp: undefined },
    ], { runId: "run-1", kind: undefined, sourceFormat: "go", commit: undefined, ref: undefined, workflow: undefined, job: undefined, runAttempt: undefined, runner: undefined, serviceName: undefined });
    const b = MetricsBatch.fromPoints([
      { scenario: "B", series: "B", metric: "y", value: 2, unit: "", direction: undefined, role: undefined, tags: {}, timestamp: undefined },
    ]);
    const merged = MetricsBatch.merge(a, b);
    assert.equal(merged.size, 2);
    assert.equal(merged.context.runId, "run-1"); // uses first batch's context
  });

  it("merge of empty array returns empty batch", () => {
    const merged = MetricsBatch.merge();
    assert.equal(merged.size, 0);
  });
});

// ---------------------------------------------------------------------------
// toOtlp round-trip
// ---------------------------------------------------------------------------

describe("MetricsBatch.toOtlp", () => {
  it("round-trips through fromOtlp → toOtlp → fromOtlp", () => {
    const original = MetricsBatch.fromOtlp(makeDoc());
    const doc = original.toOtlp();
    const restored = MetricsBatch.fromOtlp(doc);

    assert.equal(restored.size, original.size);
    assert.deepEqual(restored.scenarios, original.scenarios);
    assert.deepEqual(restored.metricNames, original.metricNames);
    assert.equal(restored.context.runId, original.context.runId);
    assert.equal(restored.context.sourceFormat, original.context.sourceFormat);
  });

  it("preserves values through round-trip", () => {
    const original = MetricsBatch.fromOtlp(makeDoc());
    const restored = MetricsBatch.fromOtlp(original.toOtlp());

    for (const orig of original.points) {
      const found = restored.points.find(
        (p) => p.scenario === orig.scenario && p.metric === orig.metric,
      );
      assert.ok(
        found,
        `metrics-batch.test.ts: missing restored point for ${orig.scenario}/${orig.metric} in toOtlp round-trip`,
      );
      assert.equal(found.value, orig.value);
      assert.equal(found.unit, orig.unit);
      assert.equal(found.direction, orig.direction);
    }
  });

  it("preserves tags through round-trip", () => {
    const original = MetricsBatch.fromOtlp(makeDoc());
    const restored = MetricsBatch.fromOtlp(original.toOtlp());
    const origSort = original.points.find((p) => p.scenario === "BenchmarkSort" && p.metric === "ns/op");
    const restoredSort = restored.points.find((p) => p.scenario === "BenchmarkSort" && p.metric === "ns/op");
    assert.ok(
      origSort && restoredSort,
      "metrics-batch.test.ts: missing BenchmarkSort/ns/op point in round-trip tag check",
    );
    assert.deepEqual(restoredSort.tags, origSort.tags);
  });

  it("toJson returns valid JSON", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const json = batch.toJson();
    const parsed = JSON.parse(json) as OtlpMetricsDocument;
    assert.ok(parsed.resourceMetrics);
    assert.ok(parsed.resourceMetrics[0].scopeMetrics);
  });
});

// ---------------------------------------------------------------------------
// seriesKey
// ---------------------------------------------------------------------------

describe("seriesKey", () => {
  it("returns series name when no tags", () => {
    const key = seriesKey({
      scenario: "A", series: "A", metric: "x", value: 1,
      unit: "", direction: undefined, role: undefined, tags: {}, timestamp: undefined,
    });
    assert.equal(key, "A");
  });

  it("appends sorted tags", () => {
    const key = seriesKey({
      scenario: "A", series: "A", metric: "x", value: 1,
      unit: "", direction: undefined, role: undefined,
      tags: { z: "3", a: "1" }, timestamp: undefined,
    });
    assert.equal(key, "A [a=1,z=3]");
  });
});

// ---------------------------------------------------------------------------
// Real-world usage patterns (from consumer audit)
// ---------------------------------------------------------------------------

describe("Consumer patterns", () => {
  it("stash: split bench vs monitor for markdown", () => {
    const batch = MetricsBatch.fromOtlp(makeDoc());
    const benchmarks = batch.withoutMonitor().groupByScenario();
    const monitor = batch.onlyMonitor().groupByScenario();

    assert.equal(benchmarks.size, 2);
    assert.equal(monitor.size, 1);

    // Each scenario group has its metrics
    const sort = benchmarks.get("BenchmarkSort")!;
    assert.deepEqual(sort.metricNames, ["allocs/op", "ns/op"]);
  });

  it("aggregate: build series with averaged repeated runs", () => {
    // Simulate 3 runs of BenchmarkSort with different values
    const runs = [100, 200, 300].map((v) =>
      MetricsBatch.fromPoints([
        { scenario: "BenchmarkSort", series: "BenchmarkSort", metric: "ns/op", value: v, unit: "ns", direction: "smaller_is_better" as const, role: "outcome" as const, tags: {}, timestamp: undefined },
      ]),
    );
    const merged = MetricsBatch.merge(...runs);
    const byMetric = merged.groupByMetric();
    const nsOp = byMetric.get("ns/op")!;
    const values = nsOp.points.map((p) => p.value);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    assert.equal(avg, 200);
    assert.equal(Math.max(...values) - Math.min(...values), 200); // range
  });

  it("compare: current vs averaged baseline", () => {
    const current = MetricsBatch.fromPoints([
      { scenario: "BenchmarkSort", series: "BenchmarkSort", metric: "ns/op", value: 150, unit: "ns", direction: "smaller_is_better" as const, role: "outcome" as const, tags: {}, timestamp: undefined },
    ]);
    const baseline = MetricsBatch.merge(
      MetricsBatch.fromPoints([
        { scenario: "BenchmarkSort", series: "BenchmarkSort", metric: "ns/op", value: 100, unit: "ns", direction: "smaller_is_better" as const, role: "outcome" as const, tags: {}, timestamp: undefined },
      ]),
      MetricsBatch.fromPoints([
        { scenario: "BenchmarkSort", series: "BenchmarkSort", metric: "ns/op", value: 100, unit: "ns", direction: "smaller_is_better" as const, role: "outcome" as const, tags: {}, timestamp: undefined },
      ]),
    );

    for (const point of current.points) {
      const baselineValues = baseline
        .forScenario(point.scenario)
        .forMetric(point.metric)
        .points.map((p) => p.value);
      const baselineAvg = baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length;
      const pctChange = ((point.value - baselineAvg) / baselineAvg) * 100;
      assert.equal(pctChange, 50); // 150 vs 100 = 50% regression
    }
  });
});
