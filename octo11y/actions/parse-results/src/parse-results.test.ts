import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRunId,
  createTempResultPath,
  getEmptyBenchmarksWarning,
  mergeDocuments,
  parseBenchmarkContent,
  resolveMode,
  writeResultFile,
} from "./parse-results.js";
import { buildOtlpResult, MetricsBatch } from "@benchkit/format";

describe("resolveMode", () => {
  it("accepts auto and file", () => {
    assert.equal(resolveMode("auto"), "auto");
    assert.equal(resolveMode("file"), "file");
  });

  it("rejects unknown modes", () => {
    assert.throws(() => resolveMode("magic"), /Invalid mode/);
  });
});

describe("buildRunId", () => {
  it("uses a custom id when provided", () => {
    assert.equal(buildRunId({ customRunId: "run-123" }), "run-123");
  });

  it("builds a collision-safe id with sanitized job name", () => {
    assert.equal(
      buildRunId({
        githubRunId: "100",
        githubRunAttempt: "2",
        githubJob: "Benchmark (Linux)",
      }),
      "100-2--benchmark-linux",
    );
  });
});

describe("parse + merge helpers", () => {
  it("parses go benchmark content", () => {
    const go = "BenchmarkSort-8   1000   1234 ns/op   48 B/op   2 allocs/op";
    const doc = parseBenchmarkContent(go, "go", "inline-go");
    const batch = MetricsBatch.fromOtlp(doc);
    assert.ok(batch.size > 0);
    assert.ok(batch.scenarios.includes("BenchmarkSort"));
  });

  it("merges monitor and benchmark documents", () => {
    const bench = buildOtlpResult({
      benchmarks: [{ name: "BenchmarkA", metrics: { ns_per_op: { value: 100 } } }],
      context: { sourceFormat: "go" },
    });
    const monitor = buildOtlpResult({
      benchmarks: [{ name: "_monitor/system", metrics: { cpu_user_pct: { value: 42 } } }],
      context: { sourceFormat: "otlp" },
    });
    const merged = mergeDocuments(bench, monitor, {
      commit: "abc123",
      ref: "refs/heads/main",
    });
    const batch = MetricsBatch.fromOtlp(merged);
    assert.equal(batch.size, 2);
    assert.equal(batch.context.commit, "abc123");
  });

  it("returns empty warning when no benchmarks are parsed", () => {
    const warning = getEmptyBenchmarksWarning({ resourceMetrics: [] });
    assert.match(warning ?? "", /Parsed 0 benchmarks/);
  });
});

describe("writeResultFile", () => {
  it("writes OTLP JSON to a temp path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parse-results-test-"));
    const output = path.join(tmp, path.basename(createTempResultPath("test-run")));
    const result = buildOtlpResult({
      benchmarks: [{ name: "BenchmarkA", metrics: { ns_per_op: { value: 100 } } }],
      context: { sourceFormat: "go" },
    });
    writeResultFile(result, output);
    assert.ok(fs.existsSync(output));
    const raw = fs.readFileSync(output, "utf-8");
    assert.match(raw, /BenchmarkA/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

