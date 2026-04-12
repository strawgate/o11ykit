import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __test, runCli } from "./cli.js";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

describe("benchkit-emit cli parse", () => {
  it("parses required args and infers defaults", () => {
    withEnv("GITHUB_JOB", "bench", () => {
      const parsed = __test.parseArgs([
        "--name", "latency_ms",
        "--value", "42",
        "--output", "/tmp/out",
      ]);
      assert.equal(parsed.name, "latency_ms");
      assert.equal(parsed.value, 42);
      assert.equal(parsed.scenario, "latency_ms");
      assert.equal(parsed.series, "bench");
      assert.equal(parsed.direction, "smaller_is_better");
      assert.equal(parsed.outputDir, "/tmp/out");
    });
  });

  it("accepts direction aliases", () => {
    assert.equal(__test.parseDirection("up", "ms"), "bigger_is_better");
    assert.equal(__test.parseDirection("down", "ops/s"), "smaller_is_better");
  });

  it("normalizes endpoint suffix", () => {
    assert.equal(
      __test.normalizeEndpoint("http://localhost:4318"),
      "http://localhost:4318/v1/metrics",
    );
    assert.equal(
      __test.normalizeEndpoint("http://localhost:4318/v1/metrics"),
      "http://localhost:4318/v1/metrics",
    );
  });
});

describe("benchkit-emit cli payload", () => {
  it("builds payload with benchkit semantic attrs", () => {
    const parsed = __test.parseArgs([
      "--name", "bundle_size_bytes",
      "--value", "1024",
      "--unit", "bytes",
      "--direction", "down",
      "--output", "/tmp/out",
      "--attribute", "dataset=wiki",
      "--resource-attribute", "team=platform",
    ]);
    const payload = __test.buildPayload(parsed, new Date("2026-04-12T00:00:00.000Z")) as {
      resourceMetrics: Array<{
        resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
        scopeMetrics: Array<{ metrics: Array<{ name: string }> }>;
      }>;
    };

    const attrs = payload.resourceMetrics[0].resource.attributes;
    assert.ok(attrs.some((a) => a.key === "benchkit.run_id"));
    assert.ok(attrs.some((a) => a.key === "benchkit.kind"));
    assert.ok(attrs.some((a) => a.key === "benchkit.source_format"));
    assert.ok(attrs.some((a) => a.key === "team"));

    const metric = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];
    assert.equal(metric.name, "bundle_size_bytes");
  });
});

describe("benchkit-emit cli runtime", () => {
  it("writes OTLP fallback file when output is configured", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-emit-test-"));
    try {
      await runCli([
        "--name", "latency_ms",
        "--value", "17.5",
        "--output", tmpDir,
      ]);

      const files = fs
        .readdirSync(tmpDir)
        .filter((name) => name.endsWith(".otlp.json"));
      assert.equal(files.length, 1);

      const doc = JSON.parse(
        fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"),
      ) as { resourceMetrics?: unknown[] };
      assert.ok(Array.isArray(doc.resourceMetrics));
      assert.ok(doc.resourceMetrics.length > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
