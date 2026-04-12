import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  type ParsedRun,
  sortRuns,
  pruneRuns,
  buildIndex,
  buildSeries,
  readRuns,
} from "./aggregate.js";
import { buildOtlpResult, MetricsBatch } from "@benchkit/format";

// ── Schema helpers ──────────────────────────────────────────────────
const schemaDir = path.resolve(__dirname, "../../../schema");
const indexSchema = JSON.parse(
  fs.readFileSync(path.join(schemaDir, "index.schema.json"), "utf-8"),
);
const seriesSchema = JSON.parse(
  fs.readFileSync(path.join(schemaDir, "series.schema.json"), "utf-8"),
);

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const validateIndex = ajv.compile(indexSchema);
const validateSeries = ajv.compile(seriesSchema);

function assertValidIndex(data: unknown): void {
  if (!validateIndex(data)) {
    assert.fail(
      `Index JSON does not conform to schema:\n${JSON.stringify(validateIndex.errors, null, 2)}`,
    );
  }
}

function assertValidSeries(data: unknown): void {
  if (!validateSeries(data)) {
    assert.fail(
      `Series JSON does not conform to schema:\n${JSON.stringify(validateSeries.errors, null, 2)}`,
    );
  }
}

// ── Fixtures ────────────────────────────────────────────────────────
function makeRun(
  id: string,
  timestamp: string,
  benchmarks: { name: string; tags?: Record<string, string>; metrics: Record<string, { value: number; unit?: string; direction?: "bigger_is_better" | "smaller_is_better" }> }[],
  commit?: string,
): ParsedRun {
  const doc = buildOtlpResult({
    benchmarks: benchmarks.map((b) => ({
      name: b.name,
      tags: b.tags,
      metrics: Object.fromEntries(
        Object.entries(b.metrics).map(([k, m]) => [k, { value: m.value, unit: m.unit, direction: m.direction }]),
      ),
    })),
    context: {
      sourceFormat: "go",
      commit,
      ref: "refs/heads/main",
    },
  });
  return {
    id,
    batch: MetricsBatch.fromOtlp(doc),
    timestamp,
  };
}

// ── sortRuns ────────────────────────────────────────────────────────
describe("sortRuns", () => {
  it("sorts runs oldest-first by timestamp", () => {
    const runs: ParsedRun[] = [
      makeRun("c", "2024-01-03T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
      makeRun("a", "2024-01-01T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
      makeRun("b", "2024-01-02T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
    ];
    sortRuns(runs);
    assert.deepEqual(
      runs.map((r) => r.id),
      ["a", "b", "c"],
    );
  });

  it("handles runs without timestamps", () => {
    const runs: ParsedRun[] = [
      { id: "x", batch: MetricsBatch.fromOtlp(buildOtlpResult({ benchmarks: [{ name: "B", metrics: { m: 1 } }], context: { sourceFormat: "go" } })), timestamp: "" },
      makeRun("y", "2024-01-01T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
    ];
    sortRuns(runs);
    // Empty string sorts before a real timestamp
    assert.equal(runs[0].id, "x");
  });
});

// ── pruneRuns ───────────────────────────────────────────────────────
describe("pruneRuns", () => {
  it("removes oldest runs beyond maxRuns", () => {
    const runs = [
      makeRun("a", "2024-01-01T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
      makeRun("b", "2024-01-02T00:00:00Z", [{ name: "B", metrics: { m: { value: 2 } } }]),
      makeRun("c", "2024-01-03T00:00:00Z", [{ name: "B", metrics: { m: { value: 3 } } }]),
      makeRun("d", "2024-01-04T00:00:00Z", [{ name: "B", metrics: { m: { value: 4 } } }]),
      makeRun("e", "2024-01-05T00:00:00Z", [{ name: "B", metrics: { m: { value: 5 } } }]),
    ];

    const removed = pruneRuns(runs, 3);
    assert.deepEqual(removed, ["a", "b"]);
    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((r) => r.id),
      ["c", "d", "e"],
    );
  });

  it("returns empty when maxRuns is 0 (unlimited)", () => {
    const runs = [
      makeRun("a", "2024-01-01T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
      makeRun("b", "2024-01-02T00:00:00Z", [{ name: "B", metrics: { m: { value: 2 } } }]),
    ];
    const removed = pruneRuns(runs, 0);
    assert.deepEqual(removed, []);
    assert.equal(runs.length, 2);
  });

  it("does nothing when runs <= maxRuns", () => {
    const runs = [
      makeRun("a", "2024-01-01T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
    ];
    const removed = pruneRuns(runs, 5);
    assert.deepEqual(removed, []);
    assert.equal(runs.length, 1);
  });

  it("prunes to exactly 1 when maxRuns=1", () => {
    const runs = [
      makeRun("a", "2024-01-01T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
      makeRun("b", "2024-01-02T00:00:00Z", [{ name: "B", metrics: { m: { value: 2 } } }]),
      makeRun("c", "2024-01-03T00:00:00Z", [{ name: "B", metrics: { m: { value: 3 } } }]),
    ];
    const removed = pruneRuns(runs, 1);
    assert.deepEqual(removed, ["a", "b"]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "c");
  });
});

// ── buildIndex ──────────────────────────────────────────────────────
describe("buildIndex", () => {
  it("builds an index from multiple runs", () => {
    const runs = [
      makeRun("run1", "2024-01-01T00:00:00Z", [
        { name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } },
      ], "abc123"),
      makeRun("run2", "2024-01-02T00:00:00Z", [
        { name: "BenchA", metrics: { ns_per_op: { value: 95, unit: "ns/op" } } },
        { name: "BenchB", metrics: { ns_per_op: { value: 200, unit: "ns/op" }, bytes_per_op: { value: 48, unit: "B/op" } } },
      ], "def456"),
    ];

    const index = buildIndex(runs);

    // Newest first
    assert.equal(index.runs.length, 2);
    assert.equal(index.runs[0].id, "run2");
    assert.equal(index.runs[1].id, "run1");

    // Metrics are collected from all runs
    assert.deepEqual(index.metrics, ["bytes_per_op", "ns_per_op"]);

    // Per-run metadata
    assert.equal(index.runs[1].benchmarks, 1);
    assert.equal(index.runs[0].benchmarks, 2);
    assert.deepEqual(index.runs[0].metrics, ["bytes_per_op", "ns_per_op"]);

    // Schema validation
    assertValidIndex(index);
  });

  it("produces valid schema for a single run", () => {
    const runs = [
      makeRun("only", "2024-06-15T12:00:00Z", [
        { name: "Test", metrics: { eps: { value: 5000, unit: "events/sec", direction: "bigger_is_better" } } },
      ]),
    ];

    const index = buildIndex(runs);
    assertValidIndex(index);
    assert.equal(index.runs.length, 1);
    assert.deepEqual(index.metrics, ["eps"]);
  });

  it("handles runs with no benchmarks gracefully", () => {
    const runs: ParsedRun[] = [
      { id: "empty", batch: MetricsBatch.fromOtlp({ resourceMetrics: [] }), timestamp: "2024-01-01T00:00:00Z" },
    ];
    const index = buildIndex(runs);
    assert.equal(index.runs.length, 1);
    assert.equal(index.runs[0].benchmarks, 0);
    assert.deepEqual(index.metrics, []);
    assertValidIndex(index);
  });

  it("includes monitor context in run entry when present", () => {
    const monitorCtx = {
      monitor_version: "0.1.0",
      poll_interval_ms: 500,
      duration_ms: 10000,
      runner_os: "Linux",
      runner_arch: "X64",
      cpu_model: "Intel Core i7-12700",
      cpu_count: 12,
      total_memory_mb: 16384,
    };
    const runs: ParsedRun[] = [
      {
        id: "run-with-monitor",
        batch: MetricsBatch.fromOtlp(buildOtlpResult({
          benchmarks: [{ name: "_monitor/system", metrics: { cpu_user_pct: { value: 12.5, unit: "%" } } }],
          context: { sourceFormat: "otlp" },
        })),
        timestamp: "2024-06-01T00:00:00Z",
        monitor: monitorCtx,
      },
    ];

    const index = buildIndex(runs);
    assertValidIndex(index);
    assert.equal(index.runs.length, 1);
    assert.deepEqual(index.runs[0].monitor, monitorCtx);
    // Monitor metrics should be prefixed with _monitor/
    assert.deepEqual(index.runs[0].metrics, ["_monitor/cpu_user_pct"]);
    assert.deepEqual(index.metrics, ["_monitor/cpu_user_pct"]);
  });

  it("omits monitor context when not present", () => {
    const runs = [
      makeRun("run-no-monitor", "2024-01-01T00:00:00Z", [
        { name: "BenchA", metrics: { ns_per_op: { value: 100 } } },
      ]),
    ];
    const index = buildIndex(runs);
    assertValidIndex(index);
    assert.equal(index.runs[0].monitor, undefined);
  });
});

// ── buildSeries ─────────────────────────────────────────────────────
describe("buildSeries", () => {
  it("builds time-series from multiple runs", () => {
    const runs = [
      makeRun("run1", "2024-01-01T00:00:00Z", [
        { name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op", direction: "smaller_is_better" } } },
      ]),
      makeRun("run2", "2024-01-02T00:00:00Z", [
        { name: "BenchA", metrics: { ns_per_op: { value: 95, unit: "ns/op", direction: "smaller_is_better" } } },
      ]),
    ];

    const seriesMap = buildSeries(runs);
    assert.equal(seriesMap.size, 1);

    const ns = seriesMap.get("ns_per_op")!;
    assert.equal(ns.metric, "ns_per_op");
    assert.equal(ns.unit, "ns/op");
    assert.equal(ns.direction, "smaller_is_better");
    assert.equal(ns.series["BenchA"].points.length, 2);
    assert.equal(ns.series["BenchA"].points[0].value, 100);
    assert.equal(ns.series["BenchA"].points[1].value, 95);

    // Schema validation
    assertValidSeries(ns);
  });

  it("averages duplicate benchmarks in a single run (Go -count=N)", () => {
    // Simulates `go test -bench=. -count=3` which produces three lines for BenchmarkFoo
    const runs = [
      makeRun("run1", "2024-01-01T00:00:00Z", [
        { name: "BenchmarkFoo", tags: { procs: "8" }, metrics: { ns_per_op: { value: 100, unit: "ns/op" } } },
        { name: "BenchmarkFoo", tags: { procs: "8" }, metrics: { ns_per_op: { value: 110, unit: "ns/op" } } },
        { name: "BenchmarkFoo", tags: { procs: "8" }, metrics: { ns_per_op: { value: 105, unit: "ns/op" } } },
      ]),
    ];

    const seriesMap = buildSeries(runs);
    const ns = seriesMap.get("ns_per_op")!;

    // Should be grouped under one series key with tags
    const key = "BenchmarkFoo [procs=8]";
    assert.ok(ns.series[key], `Expected series key "${key}"`);
    assert.equal(ns.series[key].points.length, 1);

    // Average of 100, 110, 105 = 105
    assert.equal(ns.series[key].points[0].value, 105);

    // Range = max - min = 110 - 100 = 10
    assert.equal(ns.series[key].points[0].range, 10);

    assertValidSeries(ns);
  });

  it("does not set range for single benchmark entries", () => {
    const runs = [
      makeRun("run1", "2024-01-01T00:00:00Z", [
        { name: "BenchA", metrics: { ns_per_op: { value: 100 } } },
      ]),
    ];

    const seriesMap = buildSeries(runs);
    const ns = seriesMap.get("ns_per_op")!;
    assert.equal(ns.series["BenchA"].points[0].range, undefined);
  });

  it("handles benchmarks with tags producing separate series", () => {
    const runs = [
      makeRun("run1", "2024-01-01T00:00:00Z", [
        { name: "Bench", tags: { cpu: "0.5" }, metrics: { eps: { value: 1000 } } },
        { name: "Bench", tags: { cpu: "1.0" }, metrics: { eps: { value: 2000 } } },
      ]),
    ];

    const seriesMap = buildSeries(runs);
    const eps = seriesMap.get("eps")!;

    assert.ok(eps.series["Bench [cpu=0.5]"]);
    assert.ok(eps.series["Bench [cpu=1.0]"]);
    assert.equal(eps.series["Bench [cpu=0.5]"].points[0].value, 1000);
    assert.equal(eps.series["Bench [cpu=1.0]"].points[0].value, 2000);
    assertValidSeries(eps);
  });

  it("correctly rounds averaged values", () => {
    const runs = [
      makeRun("run1", "2024-01-01T00:00:00Z", [
        { name: "B", metrics: { m: { value: 1 } } },
        { name: "B", metrics: { m: { value: 2 } } },
        { name: "B", metrics: { m: { value: 3 } } },
      ]),
    ];

    const seriesMap = buildSeries(runs);
    const m = seriesMap.get("m")!;
    assert.equal(m.series["B"].points[0].value, 2); // avg(1,2,3) = 2
    assert.equal(m.series["B"].points[0].range, 2); // 3 - 1 = 2
  });

  it("handles multiple metrics per benchmark", () => {
    const runs = [
      makeRun("run1", "2024-01-01T00:00:00Z", [
        {
          name: "BenchSort",
          metrics: {
            ns_per_op: { value: 320, unit: "ns/op", direction: "smaller_is_better" },
            bytes_per_op: { value: 48, unit: "B/op", direction: "smaller_is_better" },
            allocs_per_op: { value: 2, unit: "allocs/op", direction: "smaller_is_better" },
          },
        },
      ]),
    ];

    const seriesMap = buildSeries(runs);
    assert.equal(seriesMap.size, 3);
    assert.ok(seriesMap.has("ns_per_op"));
    assert.ok(seriesMap.has("bytes_per_op"));
    assert.ok(seriesMap.has("allocs_per_op"));

    for (const [, series] of seriesMap) {
      assertValidSeries(series);
    }
  });

  it("tracks run_id and commit in data points", () => {
    const runs = [
      makeRun("my-run-42", "2024-01-01T00:00:00Z", [
        { name: "B", metrics: { m: { value: 10 } } },
      ], "abc123def"),
    ];

    const seriesMap = buildSeries(runs);
    const m = seriesMap.get("m")!;
    const point = m.series["B"].points[0];
    assert.equal(point.run_id, "my-run-42");
    assert.equal(point.commit, "abc123def");
    assert.equal(point.timestamp, "2024-01-01T00:00:00Z");
  });

  it("produces empty series map for runs with no benchmarks", () => {
    const runs: ParsedRun[] = [
      { id: "empty", batch: MetricsBatch.fromOtlp({ resourceMetrics: [] }), timestamp: "2024-01-01T00:00:00Z" },
    ];
    const seriesMap = buildSeries(runs);
    assert.equal(seriesMap.size, 0);
  });
});

// ── Schema validation of OTLP round-trip ────────────────────────────
describe("schema: OTLP round-trip", () => {
  it("builds OTLP document from benchmarks and reads it back as MetricsBatch", () => {
    const doc = buildOtlpResult({
      benchmarks: [
        {
          name: "BenchmarkSort",
          tags: { procs: "4" },
          metrics: {
            ns_per_op: { value: 320, unit: "ns/op", direction: "smaller_is_better" },
            bytes_per_op: { value: 48, unit: "B/op" },
          },
        },
        {
          name: "BenchmarkSearch",
          metrics: {
            ns_per_op: { value: 120, unit: "ns/op" },
          },
        },
      ],
      context: {
        commit: "abc123",
        ref: "refs/heads/main",
        sourceFormat: "go",
      },
    });

    const batch = MetricsBatch.fromOtlp(doc);
    assert.ok(batch.points.length > 0);
    assert.ok(batch.points.some((p) => p.scenario === "BenchmarkSort" && p.metric === "ns_per_op"));
    assert.ok(batch.points.some((p) => p.scenario === "BenchmarkSearch" && p.metric === "ns_per_op"));
  });

  it("produces empty batch from document with no metrics", () => {
    const doc = buildOtlpResult({
      benchmarks: [],
      context: { sourceFormat: "go" },
    });
    const batch = MetricsBatch.fromOtlp(doc);
    assert.equal(batch.points.length, 0);
  });
});

// ── Integration: end-to-end aggregate + schema ──────────────────────
describe("end-to-end: aggregate and validate", () => {
  it("processes a realistic multi-run scenario", () => {
    const runs = [
      makeRun("run-001", "2024-01-01T10:00:00Z", [
        { name: "BenchmarkSort", tags: { procs: "4" }, metrics: { ns_per_op: { value: 320, unit: "ns/op", direction: "smaller_is_better" }, bytes_per_op: { value: 48, unit: "B/op" } } },
        { name: "BenchmarkSearch", tags: { procs: "4" }, metrics: { ns_per_op: { value: 120, unit: "ns/op", direction: "smaller_is_better" } } },
      ], "aaa111"),
      makeRun("run-002", "2024-01-02T10:00:00Z", [
        { name: "BenchmarkSort", tags: { procs: "4" }, metrics: { ns_per_op: { value: 310, unit: "ns/op", direction: "smaller_is_better" }, bytes_per_op: { value: 48, unit: "B/op" } } },
        { name: "BenchmarkSearch", tags: { procs: "4" }, metrics: { ns_per_op: { value: 115, unit: "ns/op", direction: "smaller_is_better" } } },
        { name: "BenchmarkInsert", metrics: { ns_per_op: { value: 450, unit: "ns/op", direction: "smaller_is_better" } } },
      ], "bbb222"),
    ];

    sortRuns(runs);
    const index = buildIndex(runs);
    const seriesMap = buildSeries(runs);

    // Validate index
    assertValidIndex(index);
    assert.equal(index.runs.length, 2);
    assert.deepEqual(index.metrics, ["bytes_per_op", "ns_per_op"]);

    // Validate all series
    for (const [, series] of seriesMap) {
      assertValidSeries(series);
    }

    // Verify series content
    const nsSeries = seriesMap.get("ns_per_op")!;
    assert.ok(nsSeries.series["BenchmarkSort [procs=4]"]);
    assert.ok(nsSeries.series["BenchmarkSearch [procs=4]"]);
    assert.ok(nsSeries.series["BenchmarkInsert"]);

    // BenchmarkInsert only appears in run-002
    assert.equal(nsSeries.series["BenchmarkInsert"].points.length, 1);
    assert.equal(nsSeries.series["BenchmarkInsert"].points[0].run_id, "run-002");
  });

  it("prune then aggregate produces valid output", () => {
    const runs = [
      makeRun("old-1", "2024-01-01T00:00:00Z", [{ name: "B", metrics: { m: { value: 1 } } }]),
      makeRun("old-2", "2024-01-02T00:00:00Z", [{ name: "B", metrics: { m: { value: 2 } } }]),
      makeRun("keep-1", "2024-01-03T00:00:00Z", [{ name: "B", metrics: { m: { value: 3 } } }]),
      makeRun("keep-2", "2024-01-04T00:00:00Z", [{ name: "B", metrics: { m: { value: 4 } } }]),
    ];

    sortRuns(runs);
    pruneRuns(runs, 2);
    const index = buildIndex(runs);
    const seriesMap = buildSeries(runs);

    assertValidIndex(index);
    assert.equal(index.runs.length, 2);
    assert.equal(index.runs[0].id, "keep-2"); // newest first

    for (const [, series] of seriesMap) {
      assertValidSeries(series);
      // Only keep-1 and keep-2 points
      assert.equal(series.series["B"].points.length, 2);
    }
  });

  it("handles -count=N duplicates then prune", () => {
    // run-1 has -count=3 for BenchmarkFoo
    const runs = [
      makeRun("run-1", "2024-01-01T00:00:00Z", [
        { name: "BenchmarkFoo", tags: { procs: "8" }, metrics: { ns_per_op: { value: 100 } } },
        { name: "BenchmarkFoo", tags: { procs: "8" }, metrics: { ns_per_op: { value: 200 } } },
        { name: "BenchmarkFoo", tags: { procs: "8" }, metrics: { ns_per_op: { value: 300 } } },
      ]),
      makeRun("run-2", "2024-01-02T00:00:00Z", [
        { name: "BenchmarkFoo", tags: { procs: "8" }, metrics: { ns_per_op: { value: 150 } } },
      ]),
    ];

    sortRuns(runs);
    const index = buildIndex(runs);
    const seriesMap = buildSeries(runs);

    assertValidIndex(index);
    const ns = seriesMap.get("ns_per_op")!;
    assertValidSeries(ns);

    const key = "BenchmarkFoo [procs=8]";
    const points = ns.series[key].points;
    assert.equal(points.length, 2);

    // First point: average of 100, 200, 300 = 200; range = 200
    assert.equal(points[0].value, 200);
    assert.equal(points[0].range, 200);

    // Second point: single value 150, no range
    assert.equal(points[1].value, 150);
    assert.equal(points[1].range, undefined);
  });
});

// ── Zero-run failure paths ───────────────────────────────────────────
describe("buildIndex: zero runs", () => {
  it("returns empty index when called with no runs", () => {
    const index = buildIndex([]);
    assert.equal(index.runs.length, 0);
    assert.deepEqual(index.metrics, []);
    assertValidIndex(index);
  });
});

describe("buildSeries: zero runs", () => {
  it("returns empty series map when called with no runs", () => {
    const seriesMap = buildSeries([]);
    assert.equal(seriesMap.size, 0);
  });
});

describe("buildSeries: monitor metric prefixing", () => {
  it("prefixes monitor benchmark metrics with _monitor/", () => {
    const runs: ParsedRun[] = [
      makeRun("r1", "2024-01-01T00:00:00Z", [
        { name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } },
        { name: "_monitor/process/go", metrics: { peak_rss_kb: { value: 50000, unit: "KB" } } },
      ]),
    ];
    const seriesMap = buildSeries(runs);
    // Regular metric keeps its name
    assert.ok(seriesMap.has("ns_per_op"));
    // Monitor metric gets prefixed
    assert.ok(seriesMap.has("_monitor/peak_rss_kb"));
    assert.ok(!seriesMap.has("peak_rss_kb"), "monitor metric should not appear without prefix");
    // Series file metric field should also be prefixed
    assert.equal(seriesMap.get("_monitor/peak_rss_kb")!.metric, "_monitor/peak_rss_kb");
    assertValidSeries(seriesMap.get("ns_per_op"));
    assertValidSeries(seriesMap.get("_monitor/peak_rss_kb"));
  });

  it("keeps non-monitor metrics unprefixed", () => {
    const runs: ParsedRun[] = [
      makeRun("r1", "2024-01-01T00:00:00Z", [
        { name: "BenchA", metrics: { ns_per_op: { value: 100 } } },
        { name: "BenchB", metrics: { ns_per_op: { value: 200 } } },
      ]),
    ];
    const seriesMap = buildSeries(runs);
    assert.ok(seriesMap.has("ns_per_op"));
    assert.ok(!seriesMap.has("_monitor/ns_per_op"));
  });
});

// ── readRuns failure paths ──────────────────────────────────────────
describe("readRuns", () => {
  it("returns empty array for a non-existent directory", () => {
    const missing = path.join(os.tmpdir(), `benchkit-no-such-dir-${Date.now()}`);
    const runs = readRuns(missing);
    assert.equal(runs.length, 0);
  });

  it("returns empty array for an empty directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      const runs = readRuns(tmpDir);
      assert.equal(runs.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads telemetry sidecar-only runs from .otlp.jsonl.gz", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      const runDir = path.join(tmpDir, "run-001");
      fs.mkdirSync(runDir, { recursive: true });

      const telemetryLine = JSON.stringify({
        resourceMetrics: [
          {
            resource: { attributes: [] },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "system.cpu.utilization",
                    gauge: {
                      dataPoints: [
                        {
                          attributes: [],
                          asDouble: 0.42,
                          timeUnixNano: "1711929600000000000",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
      fs.writeFileSync(
        path.join(runDir, "telemetry.otlp.jsonl.gz"),
        gzipSync(`${telemetryLine}\n`),
      );

      const runs = readRuns(tmpDir);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, "run-001");
      assert.equal(runs[0].batch.points.length, 1);
      assert.equal(runs[0].batch.points[0].scenario, "_monitor/system");
      assert.equal(runs[0].batch.points[0].series, "system");
      assert.equal(runs[0].batch.points[0].role, "diagnostic");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("merges benchmark and telemetry files from the same run directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      const runDir = path.join(tmpDir, "run-001");
      fs.mkdirSync(runDir, { recursive: true });

      const benchmarkDoc = buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } }],
        context: { sourceFormat: "otlp", commit: "abc123" },
      });
      fs.writeFileSync(path.join(runDir, "benchmark.otlp.json"), JSON.stringify(benchmarkDoc));

      const telemetryLine = JSON.stringify({
        resourceMetrics: [
          {
            resource: { attributes: [] },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "process.cpu.time",
                    gauge: {
                      dataPoints: [
                        {
                          attributes: [],
                          asDouble: 12.5,
                          timeUnixNano: "1711929600000000000",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
      fs.writeFileSync(path.join(runDir, "telemetry.otlp.jsonl"), `${telemetryLine}\n`);

      const runs = readRuns(tmpDir);
      assert.equal(runs.length, 1);
      const points = runs[0].batch.points;
      assert.ok(points.some((point) => point.scenario === "BenchA" && point.metric === "ns_per_op"));
      assert.ok(points.some((point) => point.scenario === "_monitor/system" && point.metric === "process.cpu.time"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("ignores non-OTLP JSON files inside run directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      const runDir = path.join(tmpDir, "run-001");
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ ok: true }));

      const benchmarkDoc = buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } }],
        context: { sourceFormat: "otlp" },
      });
      fs.writeFileSync(path.join(runDir, "benchmark.otlp.json"), JSON.stringify(benchmarkDoc));

      const runs = readRuns(tmpDir);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, "run-001");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("rejects non-OTLP JSON files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      const legacy = {
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } }],
        context: { timestamp: "2024-01-01T00:00:00Z", commit: "abc" },
      };
      fs.writeFileSync(path.join(tmpDir, "run-001.json"), JSON.stringify(legacy));
      assert.throws(
        () => readRuns(tmpDir),
        /not valid OTLP JSON/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads OTLP format files correctly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      const doc = buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } }],
        context: { sourceFormat: "go", commit: "abc" },
      });
      fs.writeFileSync(path.join(tmpDir, "run-001.json"), JSON.stringify(doc));
      const runs = readRuns(tmpDir);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, "run-001");
      assert.equal(runs[0].batch.points.length, 1);
      assert.ok(runs[0].batch.points[0].scenario === "BenchA");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("throws a descriptive error on a corrupted JSON file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "bad-run.json"), "{ not valid json }");
      assert.throws(
        () => readRuns(tmpDir),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("bad-run.json"),
            `Expected message to include filename, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("throws when a run file contains a non-object (null)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-")); 
    try {
      fs.writeFileSync(path.join(tmpDir, "null-run.json"), "null");
      assert.throws(
        () => readRuns(tmpDir),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("null-run.json"),
            `Expected filename in error: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("throws when a run file contains a JSON array instead of an object", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "array-run.json"), "[]");
      assert.throws(
        () => readRuns(tmpDir),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("array-run.json"),
            `Expected filename in error: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("ignores non-JSON files in the directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-agg-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "notes.txt"), "not a run");
      const doc = buildOtlpResult({
        benchmarks: [{ name: "B", metrics: { m: { value: 1 } } }],
        context: { sourceFormat: "otlp" },
      });
      fs.writeFileSync(path.join(tmpDir, "run-001.json"), JSON.stringify(doc));
      const runs = readRuns(tmpDir);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, "run-001");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ── Full stash-aggregate-read cycle ────────────────────────────────
describe("stash-aggregate-read cycle", () => {
  it("reads stash output files, builds index and series, all schemas valid", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-cycle-test-"));
    try {
      // Simulate two stash runs writing OTLP files to a runs directory
      const run1 = buildOtlpResult({
        benchmarks: [
          { name: "BenchSort", metrics: { ns_per_op: { value: 320, unit: "ns/op", direction: "smaller_is_better" } } },
        ],
        context: { sourceFormat: "go", commit: "aaa", ref: "refs/heads/main" },
      });
      const run2 = buildOtlpResult({
        benchmarks: [
          { name: "BenchSort", metrics: { ns_per_op: { value: 310, unit: "ns/op", direction: "smaller_is_better" } } },
          { name: "BenchSearch", metrics: { ns_per_op: { value: 120, unit: "ns/op", direction: "smaller_is_better" } } },
        ],
        context: { sourceFormat: "go", commit: "bbb", ref: "refs/heads/main" },
      });

      fs.writeFileSync(path.join(tmpDir, "run-001.json"), JSON.stringify(run1));
      fs.writeFileSync(path.join(tmpDir, "run-002.json"), JSON.stringify(run2));

      // Aggregate reads them
      const runs = readRuns(tmpDir);
      sortRuns(runs);
      const index = buildIndex(runs);
      const seriesMap = buildSeries(runs);

      // Validate index
      assertValidIndex(index);
      assert.equal(index.runs.length, 2);
      assert.deepEqual(index.metrics, ["ns_per_op"]);

      // Validate all series
      for (const [, series] of seriesMap) {
        assertValidSeries(series);
      }

      // BenchSort appears in both runs
      const ns = seriesMap.get("ns_per_op")!;
      assert.ok(ns.series["BenchSort"]);
      assert.equal(ns.series["BenchSort"].points.length, 2);

      // BenchSearch only in run-002
      assert.ok(ns.series["BenchSearch"]);
      assert.equal(ns.series["BenchSearch"].points.length, 1);
      assert.equal(ns.series["BenchSearch"].points[0].run_id, "run-002");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ── Error path tests ────────────────────────────────────────────────

describe("readRuns — error paths", () => {
  it("returns empty array when directory does not exist", () => {
    assert.deepEqual(readRuns("/nonexistent/runs"), []);
  });

  it("throws on corrupted JSON with the offending filename", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-err-"));
    fs.writeFileSync(path.join(tmpDir, "bad-run.json"), "{{{invalid json");
    try {
      assert.throws(
        () => readRuns(tmpDir),
        (err: Error) => err.message.includes("bad-run.json"),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("throws on non-object JSON (array)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-arr-"));
    fs.writeFileSync(path.join(tmpDir, "array.json"), "[1,2,3]");
    try {
      assert.throws(
        () => readRuns(tmpDir),
        /must contain a JSON object/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("throws on null JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-null-"));
    fs.writeFileSync(path.join(tmpDir, "null.json"), "null");
    try {
      assert.throws(
        () => readRuns(tmpDir),
        /must contain a JSON object/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("ignores non-JSON files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-ign-"));
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "not a run file");
    const runs = readRuns(tmpDir);
    assert.equal(runs.length, 0);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("pruneRuns", () => {
  it("does nothing when maxRuns is 0 (unlimited)", () => {
    const runs: ParsedRun[] = [];
    const pruned = pruneRuns(runs, 0);
    assert.deepEqual(pruned, []);
  });

  it("does nothing when runs are within the limit", () => {
    const fakeBatch = { points: [], context: {}, size: 0 } as unknown as ParsedRun["batch"];
    const runs: ParsedRun[] = [
      { id: "r1", batch: fakeBatch, timestamp: "2026-01-01T00:00:00Z" },
      { id: "r2", batch: fakeBatch, timestamp: "2026-01-02T00:00:00Z" },
    ];
    const pruned = pruneRuns(runs, 5);
    assert.deepEqual(pruned, []);
    assert.equal(runs.length, 2);
  });

  it("prunes oldest runs to keep maxRuns", () => {
    const fakeBatch = { points: [], context: {}, size: 0 } as unknown as ParsedRun["batch"];
    const runs: ParsedRun[] = [
      { id: "r1", batch: fakeBatch, timestamp: "2026-01-01T00:00:00Z" },
      { id: "r2", batch: fakeBatch, timestamp: "2026-01-02T00:00:00Z" },
      { id: "r3", batch: fakeBatch, timestamp: "2026-01-03T00:00:00Z" },
    ];
    const pruned = pruneRuns(runs, 2);
    assert.deepEqual(pruned, ["r1"]);
    assert.equal(runs.length, 2);
  });
});
