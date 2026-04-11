import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ParsedRun } from "./aggregate.js";
import {
  buildMetricSummaryViews,
  buildPrIndex,
  buildRefIndex,
  buildRunDetail,
  extractPrNumber,
  buildBadges,
} from "./views.js";
import { buildSeries } from "./aggregate.js";
import { buildOtlpResult, MetricsBatch } from "@benchkit/format";

// ── Schema helpers ──────────────────────────────────────────────────
const schemaDir = path.resolve(__dirname, "../../../schema");
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const validateRefsIndex = ajv.compile(
  JSON.parse(fs.readFileSync(path.join(schemaDir, "index-refs.schema.json"), "utf-8")),
);
const validatePrsIndex = ajv.compile(
  JSON.parse(fs.readFileSync(path.join(schemaDir, "index-prs.schema.json"), "utf-8")),
);
const validateMetricsIndex = ajv.compile(
  JSON.parse(fs.readFileSync(path.join(schemaDir, "index-metrics.schema.json"), "utf-8")),
);
const validateRunDetail = ajv.compile(
  JSON.parse(fs.readFileSync(path.join(schemaDir, "view-run-detail.schema.json"), "utf-8")),
);

function makeRun(
  id: string,
  timestamp: string,
  ref: string,
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
      sourceFormat: "otlp",
      commit,
      ref,
    },
  });
  return {
    id,
    batch: MetricsBatch.fromOtlp(doc),
    timestamp,
  };
}

describe("prototype aggregate views", () => {
  it("extracts PR numbers from refs", () => {
    assert.equal(extractPrNumber("refs/pull/42/merge"), 42);
    assert.equal(extractPrNumber("refs/heads/main"), null);
    assert.equal(extractPrNumber(undefined), null);
  });

  it("builds ref and PR indexes from runs", () => {
    const runs = [
      { id: "run-3", timestamp: "2026-04-01T03:00:00Z", ref: "refs/pull/42/merge", commit: "ccc" },
      { id: "run-2", timestamp: "2026-04-01T02:00:00Z", ref: "refs/heads/main", commit: "bbb" },
      { id: "run-1", timestamp: "2026-04-01T01:00:00Z", ref: "refs/heads/main", commit: "aaa" },
    ];

    const refs = buildRefIndex(runs);
    const prs = buildPrIndex(runs);

    assert.deepEqual(refs[0], {
      ref: "refs/pull/42/merge",
      latestRunId: "run-3",
      latestTimestamp: "2026-04-01T03:00:00Z",
      latestCommit: "ccc",
      runCount: 1,
    });

    assert.deepEqual(prs[0], {
      prNumber: 42,
      ref: "refs/pull/42/merge",
      latestRunId: "run-3",
      latestTimestamp: "2026-04-01T03:00:00Z",
      latestCommit: "ccc",
      runCount: 1,
    });
  });

  it("builds a run detail view from a parsed run", () => {
    const runs = [
      makeRun(
        "run-1",
        "2026-04-01T01:00:00Z",
        "refs/heads/main",
        [
          {
            name: "mock-http-ingest",
            tags: { scenario: "json-ingest" },
            metrics: {
              events_per_sec: {
                value: 13240.5,
                unit: "events/sec",
                direction: "bigger_is_better",
              },
              p95_batch_ms: {
                value: 143.2,
                unit: "ms",
                direction: "smaller_is_better",
              },
            },
          },
        ],
        "abc123",
      ),
    ];

    const detail = buildRunDetail("run-1", runs);
    assert.ok(detail);
    assert.equal(detail?.run.id, "run-1");
    assert.deepEqual(detail?.run.metrics, ["events_per_sec", "p95_batch_ms"]);
    assert.equal(detail?.metricSnapshots[0].values[0].name, "mock-http-ingest [scenario=json-ingest]");
  });

  it("builds metric summary views from series files", () => {
    const runs = [
      makeRun(
        "run-1",
        "2026-04-01T01:00:00Z",
        "refs/heads/main",
        [
          {
            name: "mock-http-ingest",
            tags: { scenario: "json-ingest" },
            metrics: {
              events_per_sec: { value: 1000, unit: "events/sec", direction: "bigger_is_better" },
            },
          },
        ],
      ),
      makeRun(
        "run-2",
        "2026-04-01T02:00:00Z",
        "refs/heads/main",
        [
          {
            name: "mock-http-ingest",
            tags: { scenario: "json-ingest" },
            metrics: {
              events_per_sec: { value: 1100, unit: "events/sec", direction: "bigger_is_better" },
            },
          },
        ],
      ),
    ];

    const summary = buildMetricSummaryViews(buildSeries(runs));
    assert.deepEqual(summary, [
      {
        metric: "events_per_sec",
        latestSeriesCount: 1,
        latestRunId: "run-2",
        latestTimestamp: "2026-04-01T02:00:00Z",
      },
    ]);
  });
});

describe("view artifact schema validation", () => {
  const runs = [
    makeRun(
      "run-1",
      "2026-04-01T01:00:00Z",
      "refs/heads/main",
      [
        {
          name: "mock-http-ingest",
          tags: { scenario: "json-ingest" },
          metrics: {
            events_per_sec: { value: 1000, unit: "events/sec", direction: "bigger_is_better" },
          },
        },
      ],
      "aaa111",
    ),
    makeRun(
      "run-2",
      "2026-04-01T02:00:00Z",
      "refs/pull/7/merge",
      [
        {
          name: "mock-http-ingest",
          tags: { scenario: "json-ingest" },
          metrics: {
            events_per_sec: { value: 1100, unit: "events/sec", direction: "bigger_is_better" },
          },
        },
      ],
      "bbb222",
    ),
  ];

  const runEntries = [
    { id: "run-1", timestamp: "2026-04-01T01:00:00Z", ref: "refs/heads/main", commit: "aaa111" },
    { id: "run-2", timestamp: "2026-04-01T02:00:00Z", ref: "refs/pull/7/merge", commit: "bbb222" },
  ];

  it("refs index conforms to schema", () => {
    const result = buildRefIndex(runEntries);
    const valid = validateRefsIndex(result);
    assert.ok(valid, `refs index schema: ${JSON.stringify(validateRefsIndex.errors, null, 2)}`);
  });

  it("prs index conforms to schema", () => {
    const result = buildPrIndex(runEntries);
    const valid = validatePrsIndex(result);
    assert.ok(valid, `prs index schema: ${JSON.stringify(validatePrsIndex.errors, null, 2)}`);
  });

  it("metrics index conforms to schema", () => {
    const result = buildMetricSummaryViews(buildSeries(runs));
    const valid = validateMetricsIndex(result);
    assert.ok(valid, `metrics index schema: ${JSON.stringify(validateMetricsIndex.errors, null, 2)}`);
  });

  it("run detail view conforms to schema", () => {
    const detail = buildRunDetail("run-1", runs);
    assert.ok(detail, "buildRunDetail returned null");
    const valid = validateRunDetail(detail);
    assert.ok(valid, `run detail schema: ${JSON.stringify(validateRunDetail.errors, null, 2)}`);
  });

  it("refs index is sorted newest-first", () => {
    const result = buildRefIndex(runEntries);
    assert.equal(result[0].ref, "refs/pull/7/merge");
    assert.equal(result[1].ref, "refs/heads/main");
  });

  it("prs index only contains PR refs", () => {
    const result = buildPrIndex(runEntries);
    assert.equal(result.length, 1);
    assert.equal(result[0].prNumber, 7);
    assert.equal(result[0].latestRunId, "run-2");
  });

  it("metrics index contains all metrics", () => {
    const result = buildMetricSummaryViews(buildSeries(runs));
    assert.equal(result.length, 1);
    assert.equal(result[0].metric, "events_per_sec");
    assert.equal(result[0].latestSeriesCount, 1);
    assert.equal(result[0].latestRunId, "run-2");
  });

  it("run detail contains metric snapshots sorted by name", () => {
    const detail = buildRunDetail("run-1", runs);
    assert.ok(detail);
    const metrics = detail.metricSnapshots.map((s) => s.metric);
    const sorted = [...metrics].sort();
    assert.deepEqual(metrics, sorted);
  });
});

describe("buildBadges", () => {
  it("generates Shields.io endpoint badge for each non-monitor metric", () => {
    const runs: ParsedRun[] = [
      makeRun("run-1", "2026-04-01T01:00:00Z", "refs/heads/main", [
        { name: "BenchReverse", metrics: { ns_per_op: { value: 125, unit: "ns/op", direction: "smaller_is_better" } } },
      ], "aaa"),
    ];
    const seriesMap = buildSeries(runs);
    const badges = buildBadges(seriesMap);

    assert.equal(badges.size, 1);
    const badge = badges.get("ns_per_op");
    assert.ok(badge);
    assert.equal(badge.schemaVersion, 1);
    assert.equal(badge.label, "ns per op");
    assert.equal(badge.message, "125 ns/op");
    assert.equal(badge.color, "blue"); // no previous value → blue
  });

  it("colors badge green when metric improves", () => {
    const runs: ParsedRun[] = [
      makeRun("run-1", "2026-04-01T01:00:00Z", "refs/heads/main", [
        { name: "Bench", metrics: { ns_per_op: { value: 200, unit: "ns/op", direction: "smaller_is_better" } } },
      ], "aaa"),
      makeRun("run-2", "2026-04-01T02:00:00Z", "refs/heads/main", [
        { name: "Bench", metrics: { ns_per_op: { value: 100, unit: "ns/op", direction: "smaller_is_better" } } },
      ], "bbb"),
    ];
    const seriesMap = buildSeries(runs);
    const badges = buildBadges(seriesMap);
    const badge = badges.get("ns_per_op")!;
    assert.equal(badge.color, "brightgreen"); // smaller is better, value decreased
    assert.equal(badge.message, "100 ns/op");
  });

  it("colors badge red when metric regresses", () => {
    const runs: ParsedRun[] = [
      makeRun("run-1", "2026-04-01T01:00:00Z", "refs/heads/main", [
        { name: "Bench", metrics: { throughput: { value: 1000, unit: "ops/s", direction: "bigger_is_better" } } },
      ], "aaa"),
      makeRun("run-2", "2026-04-01T02:00:00Z", "refs/heads/main", [
        { name: "Bench", metrics: { throughput: { value: 500, unit: "ops/s", direction: "bigger_is_better" } } },
      ], "bbb"),
    ];
    const seriesMap = buildSeries(runs);
    const badges = buildBadges(seriesMap);
    const badge = badges.get("throughput")!;
    assert.equal(badge.color, "red"); // bigger is better, value halved
  });

  it("skips _monitor/ metrics", () => {
    const runs: ParsedRun[] = [
      makeRun("run-1", "2026-04-01T01:00:00Z", "refs/heads/main", [
        { name: "_monitor/cpu", metrics: { cpu_pct: { value: 55, unit: "%" } } },
        { name: "BenchReal", metrics: { score: { value: 42 } } },
      ], "aaa"),
    ];
    const seriesMap = buildSeries(runs);
    const badges = buildBadges(seriesMap);
    assert.ok(!badges.has("_monitor/cpu_pct"));
    assert.ok(badges.has("score"));
  });

  it("formats large values with k/M suffixes", () => {
    const runs: ParsedRun[] = [
      makeRun("run-1", "2026-04-01T01:00:00Z", "refs/heads/main", [
        { name: "Bench", metrics: { ops: { value: 1_500_000, unit: "ops" } } },
      ], "aaa"),
    ];
    const seriesMap = buildSeries(runs);
    const badges = buildBadges(seriesMap);
    assert.equal(badges.get("ops")!.message, "1.5M ops");
  });

  it("returns empty map for empty series", () => {
    const badges = buildBadges(new Map());
    assert.equal(badges.size, 0);
  });
});
