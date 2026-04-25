import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCurrentRun, parseMatrixPolicyInput, readBaselineRuns, runComparison } from "./compare-action.js";
import { buildOtlpResult } from "@benchkit/format";
import type { OtlpMetricsDocument } from "@octo11y/core";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-compare-test-"));
}

function writeOtlpResult(dir: string, name: string, doc: OtlpMetricsDocument): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(doc) + "\n");
  return file;
}

function setAllPointTimestamps(doc: OtlpMetricsDocument, timeUnixNano: string): OtlpMetricsDocument {
  for (const resourceMetric of doc.resourceMetrics ?? []) {
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        for (const point of metric.gauge?.dataPoints ?? []) {
          point.timeUnixNano = timeUnixNano;
        }
        for (const point of metric.sum?.dataPoints ?? []) {
          point.timeUnixNano = timeUnixNano;
        }
      }
    }
  }
  return doc;
}

describe("parseCurrentRun", () => {
  it("parses OTLP JSON files", () => {
    const dir = makeTmpDir();
    try {
      const doc = buildOtlpResult({
        benchmarks: [{ name: "BenchSort", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } }],
        context: { sourceFormat: "otlp" },
      });
      const file = writeOtlpResult(dir, "result.json", doc);
      const batch = parseCurrentRun([file], "otlp");
      assert.equal(batch.size, 1);
      assert.equal(batch.scenarios[0], "BenchSort");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("parses go bench files", () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, "bench.txt");
      fs.writeFileSync(file, "BenchmarkSort-4  5000000  320 ns/op  48 B/op  2 allocs/op\n");
      const batch = parseCurrentRun([file], "go");
      assert.ok(batch.size >= 1);
      assert.equal(batch.scenarios[0], "BenchmarkSort");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("throws when no files are provided", () => {
    assert.throws(() => parseCurrentRun([], "otlp"), /No benchmark result files/);
  });
});

describe("readBaselineRuns", () => {
  it("returns empty when runs directory is missing", () => {
    assert.deepEqual(readBaselineRuns("/definitely/missing/path", 5), []);
  });

  it("loads the most recent json files up to maxRuns", () => {
    const dir = makeTmpDir();
    try {
      writeOtlpResult(dir, "100-1.json", buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100 } } }],
        context: { sourceFormat: "go" },
      }));
      writeOtlpResult(dir, "101-1.json", buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 110 } } }],
        context: { sourceFormat: "go" },
      }));
      writeOtlpResult(dir, "102-1.json", buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 120 } } }],
        context: { sourceFormat: "go" },
      }));
      const baselines = readBaselineRuns(dir, 2);
      assert.equal(baselines.length, 2);
      // Most recent first (102, 101)
      assert.equal(baselines[0].points[0].value, 120);
      assert.equal(baselines[1].points[0].value, 110);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("prefers latest metric timestamps over filename ordering", () => {
    const dir = makeTmpDir();
    try {
      writeOtlpResult(
        dir,
        "zzz-new-name-old-data.json",
        setAllPointTimestamps(
          buildOtlpResult({
            benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100 } } }],
            context: { sourceFormat: "go" },
          }),
          "1000000000",
        ),
      );
      writeOtlpResult(
        dir,
        "aaa-old-name-new-data.json",
        setAllPointTimestamps(
          buildOtlpResult({
            benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 250 } } }],
            context: { sourceFormat: "go" },
          }),
          "3000000000",
        ),
      );

      const baselines = readBaselineRuns(dir, 1);
      assert.equal(baselines.length, 1);
      assert.equal(baselines[0].points[0].value, 250);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("runComparison", () => {
  it("formats a no-baseline result cleanly", () => {
    const runsDir = makeTmpDir();
    const currentDir = makeTmpDir();
    try {
      const doc = buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100 } } }],
        context: { sourceFormat: "otlp" },
      });
      const currentFile = writeOtlpResult(currentDir, "current.json", doc);
      const { markdown, hasRegression } = runComparison({
        files: [currentFile],
        format: "otlp",
        runsDir: path.join(runsDir, "missing"),
        baselineRuns: 5,
        threshold: 5,
      });
      assert.equal(hasRegression, false);
      assert.match(markdown, /No comparable baseline data found/);
    } finally {
      fs.rmSync(runsDir, { recursive: true });
      fs.rmSync(currentDir, { recursive: true });
    }
  });

  it("detects regressions against baseline runs", () => {
    const runsDir = makeTmpDir();
    const currentDir = makeTmpDir();
    try {
      writeOtlpResult(runsDir, "100-1.json", buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op", direction: "smaller_is_better" } } }],
        context: { sourceFormat: "go" },
      }));
      const currentDoc = buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 120, unit: "ns/op", direction: "smaller_is_better" } } }],
        context: { sourceFormat: "go" },
      });
      const currentFile = writeOtlpResult(currentDir, "current.json", currentDoc);
      const { markdown, hasRegression } = runComparison({
        files: [currentFile],
        format: "otlp",
        runsDir,
        baselineRuns: 5,
        threshold: 5,
        currentCommit: "abcdef123456",
        currentRef: "refs/pull/12/merge",
      });
      assert.equal(hasRegression, true);
      assert.match(markdown, /### Regressions/);
      assert.match(markdown, /PR #12/);
    } finally {
      fs.rmSync(runsDir, { recursive: true });
      fs.rmSync(currentDir, { recursive: true });
    }
  });

  it("computes matrix outputs from inline JSON policy", () => {
    const runsDir = makeTmpDir();
    const currentDir = makeTmpDir();
    try {
      writeOtlpResult(runsDir, "100-1.json", buildOtlpResult({
        benchmarks: [
          {
            name: "BenchA",
            tags: { collector: "otelcol", target_eps: "10" },
            metrics: { ns_per_op: { value: 100, unit: "ns/op", direction: "smaller_is_better" } },
          },
          {
            name: "BenchA",
            tags: { collector: "otelcol", target_eps: "10000" },
            metrics: { ns_per_op: { value: 150, unit: "ns/op", direction: "smaller_is_better" } },
          },
        ],
        context: { sourceFormat: "go" },
      }));
      const currentFile = writeOtlpResult(currentDir, "current.json", buildOtlpResult({
        benchmarks: [
          {
            name: "BenchA",
            tags: { collector: "otelcol", target_eps: "10" },
            metrics: { ns_per_op: { value: 103, unit: "ns/op", direction: "smaller_is_better" } },
          },
          {
            name: "BenchA",
            tags: { collector: "otelcol", target_eps: "10000" },
            metrics: { ns_per_op: { value: 180, unit: "ns/op", direction: "smaller_is_better" } },
          },
        ],
        context: { sourceFormat: "go" },
      }));

      const result = runComparison({
        files: [currentFile],
        format: "otlp",
        runsDir,
        baselineRuns: 5,
        threshold: 5,
        matrixPolicyInput: JSON.stringify({
          dimensions: {
            collector: ["otelcol"],
            target_eps: [10, 10000, "max"],
          },
          required: [{ target_eps: { lte: 1000 } }],
          probe: [{ target_eps: { gte: 10000 } }, { target_eps: "max" }],
        }),
      });

      assert.equal(result.hasRegression, true);
      assert.equal(result.hasRequiredFailure, false);
      assert.equal(result.missingResultCount, 1);
      assert.equal(result.requiredPassedCount, 1);
      assert.equal(result.requiredFailedCount, 0);
      assert.equal(result.probeFailedCount, 1);
      assert.match(result.markdown, /### Matrix Summary/);

      const matrix = JSON.parse(result.matrixSummaryJson) as { lanes: Array<{ label: string; status: string }> };
      assert.equal(matrix.lanes.length, 3);
      assert.equal(matrix.lanes.find((lane) => lane.label.includes("target_eps=max"))?.status, "missing");
    } finally {
      fs.rmSync(runsDir, { recursive: true });
      fs.rmSync(currentDir, { recursive: true });
    }
  });
});

// ── Error path tests ────────────────────────────────────────────────

describe("parseCurrentRun — error paths", () => {
  it("throws when no files are provided", () => {
    assert.throws(
      () => parseCurrentRun([], "auto"),
      /No benchmark result files provided/,
    );
  });

  it("throws when a result file does not exist", () => {
    assert.throws(
      () => parseCurrentRun(["/nonexistent/bench.json"], "otlp"),
      /ENOENT/,
    );
  });
});

describe("readBaselineRuns — edge cases", () => {
  it("returns empty when directory does not exist", () => {
    const baselines = readBaselineRuns("/nonexistent/runs", 5);
    assert.deepEqual(baselines, []);
  });

  it("returns empty when directory is empty", () => {
    const tmpDir = makeTmpDir();
    try {
      const baselines = readBaselineRuns(tmpDir, 5);
      assert.deepEqual(baselines, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("limits to maxRuns most recent files", () => {
    const tmpDir = makeTmpDir();
    try {
      for (let i = 1; i <= 10; i++) {
        writeOtlpResult(tmpDir, `${String(i).padStart(3, "0")}.json`, buildOtlpResult({
          benchmarks: [{ name: "B", metrics: { m: { value: i } } }],
          context: { sourceFormat: "go" },
        }));
      }
      const baselines = readBaselineRuns(tmpDir, 3);
      assert.equal(baselines.length, 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("runComparison — graceful degradation", () => {
  it("reports no regressions when no baseline exists", () => {
    const currentDir = makeTmpDir();
    try {
      const currentFile = writeOtlpResult(currentDir, "current.json", buildOtlpResult({
        benchmarks: [{ name: "BenchA", metrics: { ns_per_op: { value: 100, unit: "ns/op" } } }],
        context: { sourceFormat: "go" },
      }));
      const { hasRegression } = runComparison({
        files: [currentFile],
        format: "otlp",
        runsDir: "/nonexistent/runs",
        baselineRuns: 5,
        threshold: 5,
      });
      assert.equal(hasRegression, false);
    } finally {
      fs.rmSync(currentDir, { recursive: true });
    }
  });
});

describe("parseMatrixPolicyInput", () => {
  it("accepts a JSON file path", () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, "matrix.json");
      fs.writeFileSync(file, JSON.stringify({
        dimensions: {
          collector: ["otelcol"],
          target_eps: [10],
        },
      }));

      const policy = parseMatrixPolicyInput(file);
      assert.deepEqual(policy, {
        dimensions: {
          collector: ["otelcol"],
          target_eps: [10],
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("rejects malformed policy payloads", () => {
    assert.throws(
      () => parseMatrixPolicyInput(JSON.stringify({ required: [] })),
      /dimensions must be an object/,
    );
  });

  it("rejects non-array dimension values", () => {
    assert.throws(
      () => parseMatrixPolicyInput(JSON.stringify({
        dimensions: {
          collector: "otelcol",
        },
      })),
      /dimensions\.collector must be an array/,
    );
  });

  it("rejects malformed matcher lists", () => {
    assert.throws(
      () => parseMatrixPolicyInput(JSON.stringify({
        dimensions: {
          collector: ["otelcol"],
        },
        probe: { collector: "otelcol" },
      })),
      /probe must be an array of matcher objects/,
    );
  });

  it("reports parse source for invalid JSON", () => {
    assert.throws(
      () => parseMatrixPolicyInput("{"),
      /inline JSON/,
    );
  });
});
