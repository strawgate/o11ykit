import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countDataPoints } from "./build-otlp.js";
import { parseToOtlpDocument } from "./parsers.js";
import { buildRunId } from "./stash.js";

describe("buildRunId", () => {
  it("uses custom run id when provided", () => {
    assert.equal(buildRunId({ customRunId: "abc" }), "abc");
  });

  it("sanitizes github job name", () => {
    assert.equal(
      buildRunId({
        githubRunId: "100",
        githubRunAttempt: "2",
        githubJob: "Bench (Linux)",
      }),
      "100-2--bench-linux"
    );
  });
});

describe("parseToOtlpDocument", () => {
  it("parses go benchmark output", () => {
    const input = "BenchmarkSort-8   1000   1234 ns/op   48 B/op   2 allocs/op";
    const doc = parseToOtlpDocument(input, "go", {
      runId: "run-1",
      workflow: "bench",
    });
    assert.ok(doc.resourceMetrics.length > 0);
    assert.ok(countDataPoints(doc) >= 3);
  });

  it("auto-detects benchmark-action json", () => {
    const input = JSON.stringify([{ name: "Bundle", value: 1200, unit: "ms" }]);
    const doc = parseToOtlpDocument(input, "auto", { runId: "run-2" });
    assert.equal(countDataPoints(doc), 1);
  });

  it("passes through otlp input", () => {
    const input = JSON.stringify({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "x",
                  gauge: { dataPoints: [{ asDouble: 1.23 }] },
                },
              ],
            },
          ],
        },
      ],
    });
    const doc = parseToOtlpDocument(input, "otlp", {});
    assert.equal(countDataPoints(doc), 1);
  });
});
