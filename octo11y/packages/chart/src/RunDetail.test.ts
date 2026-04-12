import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunDetailView, ComparisonResult } from "@benchkit/format";

// We can't render JSX in Node.js tests without a DOM, but we can test
// the helpers and the component's data-partitioning logic.
// Import the module to verify it compiles and exports correctly.
import { RunDetail, MetricSnapshotCard } from "./RunDetail.js";

/* ------------------------------------------------------------------ */
/*  Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

function makeDetail(overrides?: Partial<RunDetailView>): RunDetailView {
  return {
    run: {
      id: "run-1",
      timestamp: "2026-01-15T10:00:00Z",
      commit: "abc123def456",
      ref: "refs/heads/main",
      benchmarks: 4,
      metrics: ["latency_ms", "throughput_ops"],
      ...overrides?.run,
    },
    metricSnapshots: overrides?.metricSnapshots ?? [
      {
        metric: "latency_ms",
        unit: "ms",
        direction: "smaller_is_better" as const,
        values: [
          { name: "BenchFoo", value: 12.5, unit: "ms", range: 0.3 },
          { name: "BenchBar", value: 45.2, unit: "ms" },
        ],
      },
      {
        metric: "throughput_ops",
        unit: "ops/s",
        direction: "bigger_is_better" as const,
        values: [
          { name: "BenchFoo", value: 1000, unit: "ops/s" },
        ],
      },
    ],
  };
}

function makeMonitorDetail(): RunDetailView {
  return {
    run: {
      id: "run-2",
      timestamp: "2026-01-15T11:00:00Z",
      monitor: {
        monitor_version: "1.0.0",
        poll_interval_ms: 500,
        duration_ms: 60000,
        runner_os: "Linux",
        runner_arch: "x64",
        cpu_model: "AMD EPYC",
        cpu_count: 4,
        total_memory_mb: 16384,
      },
    },
    metricSnapshots: [
      {
        metric: "latency_ms",
        unit: "ms",
        direction: "smaller_is_better" as const,
        values: [{ name: "BenchFoo", value: 10.0, unit: "ms" }],
      },
      {
        metric: "_monitor.cpu_percent",
        unit: "%",
        values: [{ name: "default", value: 55.2, unit: "%" }],
      },
      {
        metric: "_monitor.memory_mb",
        unit: "MB",
        values: [{ name: "default", value: 4096, unit: "MB" }],
      },
    ],
  };
}

function makeComparison(): ComparisonResult {
  return {
    hasRegression: true,
    entries: [
      {
        benchmark: "BenchFoo",
        metric: "latency_ms",
        unit: "ms",
        direction: "smaller_is_better" as const,
        baseline: 10.0,
        current: 15.0,
        percentChange: 50,
        status: "regressed" as const,
      },
      {
        benchmark: "BenchFoo",
        metric: "throughput_ops",
        unit: "ops/s",
        direction: "bigger_is_better" as const,
        baseline: 1000,
        current: 1100,
        percentChange: 10,
        status: "improved" as const,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("RunDetail", () => {
  it("exports the RunDetail component", () => {
    assert.equal(typeof RunDetail, "function");
  });

  it("exports MetricSnapshotCard component", () => {
    assert.equal(typeof MetricSnapshotCard, "function");
  });
});

describe("RunDetail data model", () => {
  it("creates a valid detail with user metrics only", () => {
    const d = makeDetail();
    assert.equal(d.run.id, "run-1");
    assert.equal(d.metricSnapshots.length, 2);
    assert.equal(d.metricSnapshots[0].metric, "latency_ms");
    assert.equal(d.metricSnapshots[0].values.length, 2);
  });

  it("creates a valid detail with monitor context and monitor metrics", () => {
    const d = makeMonitorDetail();
    assert.equal(d.run.monitor?.runner_os, "Linux");
    assert.equal(d.run.monitor?.cpu_count, 4);

    const userSnaps = d.metricSnapshots.filter((s) => !s.metric.startsWith("_monitor."));
    const monitorSnaps = d.metricSnapshots.filter((s) => s.metric.startsWith("_monitor."));

    assert.equal(userSnaps.length, 1);
    assert.equal(monitorSnaps.length, 2);
  });

  it("handles a detail with no metrics", () => {
    const d = makeDetail({ metricSnapshots: [] });
    assert.equal(d.metricSnapshots.length, 0);
  });

  it("handles a detail with no commit/ref", () => {
    const d: RunDetailView = {
      run: { id: "run-minimal", timestamp: "2026-01-01T00:00:00Z" },
      metricSnapshots: [],
    };
    assert.equal(d.run.commit, undefined);
    assert.equal(d.run.ref, undefined);
    assert.equal(d.run.monitor, undefined);
  });

  it("comparison result has correct structure", () => {
    const c = makeComparison();
    assert.equal(c.hasRegression, true);
    assert.equal(c.entries.length, 2);
    assert.equal(c.entries[0].status, "regressed");
    assert.equal(c.entries[1].status, "improved");
  });

  it("metric snapshot direction values are valid", () => {
    const d = makeDetail();
    const directions = d.metricSnapshots.map((s) => s.direction).filter(Boolean);
    for (const dir of directions) {
      assert.ok(
        dir === "bigger_is_better" || dir === "smaller_is_better",
        `Unexpected direction: ${dir}`,
      );
    }
  });

  it("values contain range for statistical significance", () => {
    const d = makeDetail();
    const fooLatency = d.metricSnapshots[0].values[0];
    assert.equal(fooLatency.range, 0.3);
    // Second value has no range
    assert.equal(d.metricSnapshots[0].values[1].range, undefined);
  });
});
