import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMetricNames,
  ALL_METRICS,
  writeOtlpFile,
  median,
  parseResourceAttributes,
} from "./repo-stats.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---- parseMetricNames -----------------------------------------------------

describe("parseMetricNames", () => {
  it('returns all metrics for "all"', () => {
    const result = parseMetricNames("all");
    assert.deepStrictEqual(result, [...ALL_METRICS]);
  });

  it("returns all metrics for empty string", () => {
    const result = parseMetricNames("");
    assert.deepStrictEqual(result, [...ALL_METRICS]);
  });

  it("parses a comma-separated list", () => {
    const result = parseMetricNames("stars, forks, watchers");
    assert.deepStrictEqual(result, ["stars", "forks", "watchers"]);
  });

  it("accepts traffic metrics", () => {
    const result = parseMetricNames("page-views, unique-visitors, clones, unique-cloners");
    assert.deepStrictEqual(result, [
      "page-views", "unique-visitors", "clones", "unique-cloners",
    ]);
  });

  it("accepts statistics metrics", () => {
    const result = parseMetricNames("weekly-commits, weekly-additions, weekly-deletions");
    assert.deepStrictEqual(result, [
      "weekly-commits", "weekly-additions", "weekly-deletions",
    ]);
  });

  it("accepts network-count", () => {
    const result = parseMetricNames("network-count");
    assert.deepStrictEqual(result, ["network-count"]);
  });

  it("is case-insensitive", () => {
    const result = parseMetricNames("Stars,FORKS");
    assert.deepStrictEqual(result, ["stars", "forks"]);
  });

  it("trims whitespace", () => {
    const result = parseMetricNames("  open-issues , open-prs  ");
    assert.deepStrictEqual(result, ["open-issues", "open-prs"]);
  });

  it("throws on unknown metric", () => {
    assert.throws(
      () => parseMetricNames("stars,invalid-metric"),
      /Unknown metric "invalid-metric"/,
    );
  });

  it("throws when only commas remain", () => {
    assert.throws(() => parseMetricNames(",,,"), /No metrics selected/);
  });

  it("accepts a single metric", () => {
    const result = parseMetricNames("workflow-success-pct");
    assert.deepStrictEqual(result, ["workflow-success-pct"]);
  });

  it("accepts velocity metrics", () => {
    const result = parseMetricNames(
      "avg-issue-close-days, median-issue-close-days, avg-pr-merge-hours, median-pr-merge-hours",
    );
    assert.deepStrictEqual(result, [
      "avg-issue-close-days",
      "median-issue-close-days",
      "avg-pr-merge-hours",
      "median-pr-merge-hours",
    ]);
  });

  it("accepts security metrics", () => {
    const result = parseMetricNames("dependabot-alerts, code-scanning-alerts");
    assert.deepStrictEqual(result, ["dependabot-alerts", "code-scanning-alerts"]);
  });

  it("accepts languages", () => {
    const result = parseMetricNames("languages");
    assert.deepStrictEqual(result, ["languages"]);
  });
});

// ---- parseResourceAttributes ----------------------------------------------

describe("parseResourceAttributes", () => {
  it("parses JSON resource attributes with typed values", () => {
    assert.deepStrictEqual(
      parseResourceAttributes('{"team":"platform","batch_size":2000,"warm":true}'),
      {
        team: "platform",
        batch_size: 2000,
        warm: true,
      },
    );
  });

  it("parses key=value lines", () => {
    assert.deepStrictEqual(
      parseResourceAttributes("team=platform\nenv=prod"),
      {
        team: "platform",
        env: "prod",
      },
    );
  });

  it("rejects benchkit-prefixed keys", () => {
    assert.throws(
      () => parseResourceAttributes("benchkit.team=platform"),
      /must not use the 'benchkit\.' prefix/,
    );
  });

  it("rejects non-object JSON", () => {
    assert.throws(
      () => parseResourceAttributes('[1,2,3]'),
      /must use key=value format/,
    );
  });
});

// ---- writeOtlpFile --------------------------------------------------------

describe("writeOtlpFile", () => {
  it("writes valid OTLP JSON with metric data", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-stats-test-"));
    const outFile = path.join(tmpDir, "out.json");

    try {
      writeOtlpFile(
        {
          stars: { value: 42, unit: "count", direction: "bigger_is_better" },
          open_issues: {
            value: 3,
            unit: "count",
            direction: "smaller_is_better",
          },
        },
        "my-repo",
        outFile,
      );

      const doc = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      assert.ok(doc.resourceMetrics, "should have resourceMetrics");
      assert.equal(doc.resourceMetrics.length, 1);

      const scopeMetrics = doc.resourceMetrics[0].scopeMetrics;
      assert.equal(scopeMetrics.length, 1);

      const metrics = scopeMetrics[0].metrics;
      assert.equal(metrics.length, 2);

      // Verify metric names
      const names = metrics.map(
        (m: { name: string }) => m.name,
      );
      assert.ok(names.includes("stars"), 'should include "stars"');
      assert.ok(names.includes("open_issues"), 'should include "open_issues"');

      // Verify stars gauge
      const starsMetric = metrics.find(
        (m: { name: string }) => m.name === "stars",
      );
      assert.ok(starsMetric.gauge, "stars should be a gauge");
      assert.equal(starsMetric.gauge.dataPoints.length, 1);
      assert.equal(starsMetric.gauge.dataPoints[0].asInt, "42");
      assert.equal(starsMetric.unit, "count");

      // Verify scenario attribute on datapoint
      const attrs = starsMetric.gauge.dataPoints[0].attributes;
      const scenarioAttr = attrs.find(
        (a: { key: string }) => a.key === "benchkit.scenario",
      );
      assert.ok(scenarioAttr, "should have benchkit.scenario attribute");
      assert.equal(scenarioAttr.value.stringValue, "my-repo");

      // Verify direction attribute
      const dirAttr = attrs.find(
        (a: { key: string }) => a.key === "benchkit.metric.direction",
      );
      assert.ok(dirAttr, "should have direction attribute");
      assert.equal(dirAttr.value.stringValue, "bigger_is_better");

      // Verify resource attributes include source format
      const resAttrs = doc.resourceMetrics[0].resource.attributes;
      const fmtAttr = resAttrs.find(
        (a: { key: string }) => a.key === "benchkit.source_format",
      );
      assert.ok(fmtAttr, "should have source_format");
      assert.equal(fmtAttr.value.stringValue, "otlp");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles fractional values with asDouble", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-stats-test-"));
    const outFile = path.join(tmpDir, "out.json");

    try {
      writeOtlpFile(
        {
          workflow_success_pct: {
            value: 93.3,
            unit: "%",
            direction: "bigger_is_better",
          },
        },
        "test-repo",
        outFile,
      );

      const doc = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      const metric = doc.resourceMetrics[0].scopeMetrics[0].metrics[0];
      assert.equal(metric.name, "workflow_success_pct");
      assert.equal(metric.gauge.dataPoints[0].asDouble, 93.3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes custom resource attributes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-stats-test-"));
    const outFile = path.join(tmpDir, "out.json");

    try {
      writeOtlpFile(
        {
          stars: { value: 42, unit: "count", direction: "bigger_is_better" },
        },
        "my-repo",
        outFile,
        {
          team: "platform",
          batch_size: 2000,
          warm: true,
        },
      );

      const doc = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      const resAttrs = doc.resourceMetrics[0].resource.attributes;
      const teamAttr = resAttrs.find((a: { key: string }) => a.key === "team");
      const batchSizeAttr = resAttrs.find((a: { key: string }) => a.key === "batch_size");
      const warmAttr = resAttrs.find((a: { key: string }) => a.key === "warm");
      assert.equal(teamAttr?.value?.stringValue, "platform");
      assert.equal(batchSizeAttr?.value?.intValue, "2000");
      assert.equal(warmAttr?.value?.boolValue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---- median ---------------------------------------------------------------

describe("median", () => {
  it("returns 0 for empty array", () => {
    assert.equal(median([]), 0);
  });

  it("returns the middle value for odd-length array", () => {
    assert.equal(median([1, 3, 5]), 3);
  });

  it("returns the average of two middle values for even-length array", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it("returns the single element for length-1 array", () => {
    assert.equal(median([42]), 42);
  });

  it("handles fractional values", () => {
    assert.equal(median([1.5, 2.5, 3.5]), 2.5);
  });
});

// ---- writeOtlpFile with language-style multi metrics ----------------------

describe("writeOtlpFile with language metrics", () => {
  it("includes language bytes metrics alongside regular metrics", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-stats-test-"));
    const outFile = path.join(tmpDir, "out.json");

    try {
      writeOtlpFile(
        {
          stars: { value: 10, unit: "count", direction: "bigger_is_better" },
          lang_bytes_typescript: {
            value: 50000,
            unit: "bytes",
            direction: "bigger_is_better",
          },
          lang_bytes_javascript: {
            value: 12000,
            unit: "bytes",
            direction: "bigger_is_better",
          },
        },
        "my-repo",
        outFile,
      );

      const doc = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      const metrics = doc.resourceMetrics[0].scopeMetrics[0].metrics;
      const names = metrics.map((m: { name: string }) => m.name).sort();
      assert.deepStrictEqual(names, [
        "lang_bytes_javascript",
        "lang_bytes_typescript",
        "stars",
      ]);

      const tsMetric = metrics.find(
        (m: { name: string }) => m.name === "lang_bytes_typescript",
      );
      assert.equal(tsMetric.unit, "bytes");
      assert.equal(tsMetric.gauge.dataPoints[0].asInt, "50000");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
