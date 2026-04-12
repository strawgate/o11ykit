import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  buildResult,
  buildRunId,
  createTempResultPath,
  formatResultSummaryMarkdown,
  getEmptyBenchmarksWarning,
  parseBenchmarkFiles,
  parseBenchmarks,
  readMetricsDir,
  readMonitorOutput,
  writeResultFile,
} from "./stash.js";
import { buildOtlpResult, MetricsBatch } from "@benchkit/format";
import type { OtlpMetricsDocument } from "@octo11y/core";

// ── buildRunId ──────────────────────────────────────────────────────

describe("buildRunId", () => {
  it("returns the custom run-id unchanged when provided", () => {
    assert.equal(
      buildRunId({ customRunId: "my-custom-run" }),
      "my-custom-run",
    );
  });

  it("ignores all other options when customRunId is set", () => {
    assert.equal(
      buildRunId({ customRunId: "custom", githubRunId: "99", githubJob: "bench" }),
      "custom",
    );
  });

  it("builds base id from run id and attempt", () => {
    assert.equal(
      buildRunId({ githubRunId: "12345", githubRunAttempt: "2" }),
      "12345-2",
    );
  });

  it("appends sanitized job name separated by double dash", () => {
    assert.equal(
      buildRunId({ githubRunId: "12345", githubRunAttempt: "1", githubJob: "bench" }),
      "12345-1--bench",
    );
  });

  it("lower-cases the job segment", () => {
    assert.equal(
      buildRunId({ githubRunId: "12345", githubRunAttempt: "1", githubJob: "BenchGo" }),
      "12345-1--benchgo",
    );
  });

  it("replaces spaces and special characters with dashes in job segment", () => {
    assert.equal(
      buildRunId({ githubRunId: "12345", githubRunAttempt: "1", githubJob: "My Bench (Linux)" }),
      "12345-1--my-bench-linux",
    );
  });

  it("collapses consecutive special characters to a single dash", () => {
    assert.equal(
      buildRunId({ githubRunId: "1", githubRunAttempt: "1", githubJob: "a  b__c" }),
      "1-1--a-b-c",
    );
  });

  it("strips leading and trailing dashes from the job segment", () => {
    assert.equal(
      buildRunId({ githubRunId: "1", githubRunAttempt: "1", githubJob: "---bench---" }),
      "1-1--bench",
    );
  });

  it("falls back to base id when job sanitizes to empty string", () => {
    assert.equal(
      buildRunId({ githubRunId: "1", githubRunAttempt: "1", githubJob: "!!!" }),
      "1-1",
    );
  });

  it("uses 'local' and attempt '1' as fallbacks when env vars are absent", () => {
    assert.equal(
      buildRunId({}),
      "local-1",
    );
  });

  it("uses attempt '1' as fallback when only run id is provided", () => {
    assert.equal(
      buildRunId({ githubRunId: "42" }),
      "42-1",
    );
  });
});

// ── buildResult ─────────────────────────────────────────────────────

describe("buildResult", () => {
  const baseBenchmarkDoc = buildOtlpResult({
    benchmarks: [{ name: "BenchmarkSort", metrics: { ns_per_op: { value: 320, unit: "ns/op" } } }],
    context: { sourceFormat: "go" },
  });
  const baseContext = {
    commit: "abc123",
    ref: "refs/heads/main",
    timestamp: "2026-01-01T00:00:00Z",
    runner: "Linux/X64",
  };

  it("builds a result from benchmarks and context", () => {
    const result = buildResult({ benchmarkDoc: baseBenchmarkDoc, context: baseContext });
    const batch = MetricsBatch.fromOtlp(result);
    assert.equal(batch.size, 1);
    assert.equal(batch.points[0].scenario, "BenchmarkSort");
    assert.equal(batch.context.commit, "abc123");
    assert.equal(batch.context.ref, "refs/heads/main");
    assert.equal(batch.context.runner, "Linux/X64");
  });

  it("merges monitor document", () => {
    const monitorDoc = buildOtlpResult({
      benchmarks: [{ name: "_monitor/system", metrics: { cpu_user_pct: { value: 45 } } }],
      context: { sourceFormat: "otlp" },
    });
    const result = buildResult({
      benchmarkDoc: baseBenchmarkDoc,
      monitorDoc,
      context: baseContext,
    });
    const batch = MetricsBatch.fromOtlp(result);
    assert.equal(batch.size, 2);
    const scenarios = batch.scenarios;
    assert.ok(scenarios.includes("BenchmarkSort"));
    assert.ok(scenarios.includes("_monitor/system"));
  });

  it("merges metrics-dir document", () => {
    const metricsDirDoc = buildOtlpResult({
      benchmarks: [{ name: "workflow", metrics: { bundle_size_bytes: { value: 1024 } } }],
      context: { sourceFormat: "otlp" },
    });
    const result = buildResult({
      benchmarkDoc: baseBenchmarkDoc,
      metricsDirDoc,
      context: baseContext,
    });
    const batch = MetricsBatch.fromOtlp(result);
    assert.equal(batch.size, 2);
    assert.ok(batch.metricNames.includes("bundle_size_bytes"));
  });

  it("does not mutate input document", () => {
    const inputDoc = buildOtlpResult({
      benchmarks: [{ name: "BenchA", metrics: { m: { value: 1 } } }],
      context: { sourceFormat: "go" },
    });
    const inputMetrics = inputDoc.resourceMetrics[0].scopeMetrics![0].metrics!.length;
    const monitorDoc = buildOtlpResult({
      benchmarks: [{ name: "_monitor/x", metrics: { m: { value: 1 } } }],
      context: { sourceFormat: "otlp" },
    });
    buildResult({ benchmarkDoc: inputDoc, monitorDoc, context: baseContext });
    assert.equal(
      inputDoc.resourceMetrics[0].scopeMetrics![0].metrics!.length,
      inputMetrics,
      "original doc should not be modified",
    );
  });

  it("omits runner from context when undefined", () => {
    const result = buildResult({
      benchmarkDoc: baseBenchmarkDoc,
      context: { ...baseContext, runner: undefined },
    });
    const batch = MetricsBatch.fromOtlp(result);
    assert.equal(batch.context.runner, undefined);
  });

  it("throws when no data sources are provided", () => {
    assert.throws(
      () => buildResult({ context: baseContext }),
      /No benchmark or monitor metrics were provided/,
    );
  });
});

// ── parseBenchmarkFiles ─────────────────────────────────────────────

describe("parseBenchmarkFiles", () => {
  let tmpDir: string;

  it("parses Go bench files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-test-"));
    const goFile = path.join(tmpDir, "bench.txt");
    fs.writeFileSync(goFile, [
      "BenchmarkSort-4  5000000  320 ns/op  48 B/op  2 allocs/op",
      "BenchmarkSearch-4  10000000  120 ns/op  0 B/op  0 allocs/op",
    ].join("\n"));

    const doc = parseBenchmarkFiles([goFile], "go");
    const batch = MetricsBatch.fromOtlp(doc);
    assert.equal(batch.scenarios.length, 2);
    assert.ok(batch.scenarios.includes("BenchmarkSort"));
    assert.ok(batch.metricNames.includes("ns_per_op"));
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses OTLP JSON files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-test-"));
    const otlpFile = path.join(tmpDir, "results.json");
    const otlpDoc = buildOtlpResult({
      benchmarks: [{ name: "http-throughput", metrics: { rps: { value: 15230 } } }],
      context: { sourceFormat: "otlp" },
    });
    fs.writeFileSync(otlpFile, JSON.stringify(otlpDoc));

    const doc = parseBenchmarkFiles([otlpFile], "otlp");
    const batch = MetricsBatch.fromOtlp(doc);
    assert.equal(batch.scenarios.length, 1);
    assert.ok(batch.scenarios.includes("http-throughput"));
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("concatenates benchmarks from multiple files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-test-"));
    const f1 = path.join(tmpDir, "a.txt");
    const f2 = path.join(tmpDir, "b.txt");
    fs.writeFileSync(f1, "BenchmarkA-4  1000  100 ns/op");
    fs.writeFileSync(f2, "BenchmarkB-4  2000  200 ns/op");

    const doc = parseBenchmarkFiles([f1, f2], "go");
    const batch = MetricsBatch.fromOtlp(doc);
    assert.equal(batch.scenarios.length, 2);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws on empty file list", () => {
    assert.throws(() => parseBenchmarkFiles([], "go"), /No benchmark result files/);
  });
});

describe("getEmptyBenchmarksWarning", () => {
  it("returns a warning when parsing produced no benchmarks", () => {
    const emptyDoc: OtlpMetricsDocument = { resourceMetrics: [] };
    assert.match(
      getEmptyBenchmarksWarning(emptyDoc) ?? "",
      /Parsed 0 benchmarks from the provided file\(s\)/,
    );
  });

  it("does not warn when at least one benchmark was parsed", () => {
    const doc = buildOtlpResult({
      benchmarks: [{ name: "BenchmarkSort", metrics: { ns_per_op: { value: 320 } } }],
      context: { sourceFormat: "go" },
    });
    assert.equal(getEmptyBenchmarksWarning(doc), undefined);
  });
});

// ── parseBenchmarks failure paths ────────────────────────────────────

describe("parseBenchmarks", () => {
  it("throws a descriptive error for malformed JSON", () => {
    assert.throws(
      () => parseBenchmarks("{ not valid json }", "otlp", "results.json"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("results.json"),
          `Expected filename in error: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("throws when OTLP JSON is missing resourceMetrics", () => {
    const content = JSON.stringify({ something: "else" });
    assert.throws(
      () => parseBenchmarks(content, "otlp", "bench.json"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("bench.json"),
          `Expected filename in error: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("throws for an unknown format", () => {
    assert.throws(
      () => parseBenchmarks("any content", "unknown" as never, "file.txt"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("file.txt"),
          `Expected filename in error: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("returns OtlpMetricsDocument for valid OTLP JSON", () => {
    const otlpDoc = buildOtlpResult({
      benchmarks: [{ name: "BenchSort", metrics: { ns_per_op: { value: 320, unit: "ns/op" } } }],
      context: { sourceFormat: "otlp" },
    });
    const doc = parseBenchmarks(JSON.stringify(otlpDoc), "otlp", "results.json");
    const batch = MetricsBatch.fromOtlp(doc);
    assert.equal(batch.size, 1);
    assert.equal(batch.scenarios[0], "BenchSort");
  });

  it("returns OtlpMetricsDocument when auto-detecting Go format", () => {
    const goOutput = [
      "goos: linux",
      "goarch: amd64",
      "BenchmarkSort-8   1000   1234 ns/op   48 B/op   2 allocs/op",
      "PASS",
    ].join("\n");
    const doc = parseBenchmarks(goOutput, "auto", "bench.txt");
    const batch = MetricsBatch.fromOtlp(doc);
    assert.ok(batch.size >= 1);
    assert.equal(batch.scenarios[0], "BenchmarkSort");
  });
});

// ── readMonitorOutput ───────────────────────────────────────────────

describe("readMonitorOutput", () => {
  it("rejects a legacy native monitor output file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-test-"));
    const monitorFile = path.join(tmpDir, "monitor.json");
    fs.writeFileSync(monitorFile, JSON.stringify({
      benchmarks: [
        { name: "_monitor/process/go", metrics: { peak_rss_kb: { value: 50000 } } },
      ],
    }));

    assert.throws(
      () => readMonitorOutput(monitorFile),
      /not valid OTLP JSON/,
    );
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("reads an OTLP monitor output file directly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-test-"));
    const monitorFile = path.join(tmpDir, "monitor.json");
    const otlpDoc = buildOtlpResult({
      benchmarks: [{ name: "_monitor/process/go", metrics: { peak_rss_kb: { value: 50000 } } }],
      context: { sourceFormat: "otlp" },
    });
    fs.writeFileSync(monitorFile, JSON.stringify(otlpDoc));

    const doc = readMonitorOutput(monitorFile);
    const batch = MetricsBatch.fromOtlp(doc);
    assert.equal(batch.size, 1);
    assert.ok(batch.scenarios.includes("_monitor/process/go"));
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws when the monitor file does not exist", () => {
    const missing = path.join(os.tmpdir(), `benchkit-no-monitor-${Date.now()}.json`);
    assert.throws(
      () => readMonitorOutput(missing),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("Monitor file not found"),
          `Expected 'Monitor file not found' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("throws on invalid JSON content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-stash-test-"));
    const filePath = path.join(tmpDir, "monitor.json");
    try {
      fs.writeFileSync(filePath, "{ not valid json }");
      assert.throws(() => readMonitorOutput(filePath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("readMetricsDir", () => {
  it("merges *.otlp.json files in the directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-metrics-dir-"));
    const docA = buildOtlpResult({
      benchmarks: [{ name: "bench-a", metrics: { ns_per_op: { value: 120 } } }],
      context: { sourceFormat: "otlp" },
    });
    const docB = buildOtlpResult({
      benchmarks: [{ name: "bench-b", metrics: { ns_per_op: { value: 220 } } }],
      context: { sourceFormat: "otlp" },
    });
    fs.writeFileSync(path.join(tmpDir, "a.otlp.json"), JSON.stringify(docA));
    fs.writeFileSync(path.join(tmpDir, "b.otlp.json"), JSON.stringify(docB));

    try {
      const merged = readMetricsDir(tmpDir);
      assert.ok(merged);
      const batch = MetricsBatch.fromOtlp(merged!);
      assert.equal(batch.size, 2);
      assert.ok(batch.scenarios.includes("bench-a"));
      assert.ok(batch.scenarios.includes("bench-b"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns undefined when no *.otlp.json files exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-metrics-dir-empty-"));
    try {
      assert.equal(readMetricsDir(tmpDir), undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when metrics-dir path is missing", () => {
    const missing = path.join(os.tmpdir(), `stash-metrics-missing-${Date.now()}`);
    assert.throws(
      () => readMetricsDir(missing),
      /Metrics directory not found/,
    );
  });
});

// ── file writing / summary helpers ───────────────────────────────────

describe("writeResultFile", () => {
  it("writes a result file to disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-stash-test-"));
    try {
      const outputPath = path.join(tmpDir, "nested", "result.json");
      const result = buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100 } } }],
        context: { sourceFormat: "go" },
      });
      const writtenPath = writeResultFile(result, "run-1", outputPath);
      assert.equal(writtenPath, outputPath);
      const parsed = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as OtlpMetricsDocument;
      assert.ok(parsed.resourceMetrics);
      const batch = MetricsBatch.fromOtlp(parsed);
      assert.equal(batch.scenarios[0], "BenchA");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("creates a temp result path that includes the run id", () => {
    const resultPath = createTempResultPath("1234-1");
    assert.ok(resultPath.includes("1234-1"));
    assert.ok(resultPath.endsWith(".json"));
  });
});

describe("formatResultSummaryMarkdown", () => {
  it("formats benchmarks and monitor metrics for GITHUB_STEP_SUMMARY", () => {
    const result = buildOtlpResult({
      benchmarks: [
        {
          name: "mock-http-ingest",
          metrics: {
            events_per_sec: { value: 13240.5, unit: "events/sec", direction: "bigger_is_better" },
            service_rss_mb: { value: 543.1, unit: "MB", direction: "smaller_is_better" },
          },
        },
        {
          name: "_monitor/system",
          metrics: {
            cpu_user_pct: { value: 71.2, unit: "%" },
          },
        },
      ],
      context: {
        sourceFormat: "go",
        commit: "abcdef1234567890",
        ref: "refs/pull/42/merge",
      },
    });

    const markdown = formatResultSummaryMarkdown(result, { runId: "12345-1" });
    assert.match(markdown, /## Benchkit Stash/);
    assert.match(markdown, /Run ID: `12345-1`/);
    assert.match(markdown, /commit `abcdef12`/);
    assert.match(markdown, /ref `refs\/pull\/42\/merge`/);
    assert.match(markdown, /mock-http-ingest/);
    assert.match(markdown, /events_per_sec/);
    assert.match(markdown, /13240\.5/);
    assert.match(markdown, /Monitor metrics/);
    assert.match(markdown, /_monitor\/system/);
    assert.match(markdown, /cpu_user_pct/);
    assert.match(markdown, /71\.2/);
  });

  it("omits the monitor details block when no monitor benchmarks exist", () => {
    const result = buildOtlpResult({
      benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } }],
      context: { sourceFormat: "go" },
    });
    const markdown = formatResultSummaryMarkdown(result, { runId: "run-1" });
    assert.doesNotMatch(markdown, /Monitor metrics/);
    assert.match(markdown, /BenchA/);
  });
});

// ── Error path tests ────────────────────────────────────────────────

describe("parseBenchmarkFiles — error paths", () => {
  it("throws when no files are provided", () => {
    assert.throws(
      () => parseBenchmarkFiles([], "auto"),
      /No benchmark result files provided/,
    );
  });

  it("throws a descriptive error when a file does not exist", () => {
    assert.throws(
      () => parseBenchmarkFiles(["/nonexistent/path/bench.txt"], "auto"),
      /ENOENT/,
    );
  });

  it("includes the filename in parse error for malformed content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-err-"));
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json at all {{{");
    try {
      assert.throws(
        () => parseBenchmarkFiles([filePath], "otlp"),
        (err: Error) => err.message.includes("bad.json"),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("readMonitorOutput — error paths", () => {
  it("throws when the monitor file does not exist", () => {
    assert.throws(
      () => readMonitorOutput("/nonexistent/monitor.json"),
      /Monitor file not found|ENOENT/,
    );
  });

  it("throws on malformed monitor JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-mon-"));
    const filePath = path.join(tmpDir, "monitor.json");
    fs.writeFileSync(filePath, "not json");
    try {
      assert.throws(
        () => readMonitorOutput(filePath),
        /SyntaxError|Unexpected token|is not valid JSON/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("getEmptyBenchmarksWarning", () => {
  it("returns a warning when the document has no benchmarks", () => {
    const emptyDoc = buildOtlpResult({
      benchmarks: [],
      context: { sourceFormat: "otlp" },
    });
    const warning = getEmptyBenchmarksWarning(emptyDoc);
    assert.ok(warning);
    assert.match(warning, /Parsed 0 benchmarks/);
  });

  it("returns undefined when benchmarks are present", () => {
    const doc = buildOtlpResult({
      benchmarks: [{ name: "BenchA", metrics: { m: { value: 1 } } }],
      context: { sourceFormat: "otlp" },
    });
    assert.equal(getEmptyBenchmarksWarning(doc), undefined);
  });
});

describe("writeResultFile — round trip", () => {
  it("writes valid JSON that can be read back", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stash-wrt-"));
    const doc = buildOtlpResult({
      benchmarks: [{ name: "BenchRT", metrics: { score: { value: 42 } } }],
      context: { sourceFormat: "otlp" },
    });
    const outPath = path.join(tmpDir, "sub", "run-test.json");
    writeResultFile(doc, "run-test", outPath);
    try {
      const content = fs.readFileSync(outPath, "utf-8");
      const parsed = JSON.parse(content);
      assert.ok(Array.isArray(parsed.resourceMetrics));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
