import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import {
  filterToRunnerDescendants,
  findDescendantPids,
  isProcessRunning,
  safeUnlink,
  stopCollector,
  suppressExpectedCiNoise,
} from "./otel-stop.js";
import type { OtelState } from "./types.js";

// ── isProcessRunning ────────────────────────────────────────────────

describe("isProcessRunning", () => {
  it("returns true for the current process", () => {
    assert.equal(isProcessRunning(process.pid), true);
  });

  it("returns false for pid 0", () => {
    assert.equal(isProcessRunning(0), false);
  });

  it("returns false for negative pid", () => {
    assert.equal(isProcessRunning(-1), false);
  });

  it("returns false for a non-existent pid", () => {
    // PID 99999999 is extremely unlikely to exist
    assert.equal(isProcessRunning(99999999), false);
  });
});

// ── safeUnlink ──────────────────────────────────────────────────────

describe("safeUnlink", () => {
  it("removes an existing file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-stop-test-"));
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "hello");
    assert.ok(fs.existsSync(filePath));

    safeUnlink(filePath);
    assert.ok(!fs.existsSync(filePath));
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("does not throw for a non-existent file", () => {
    assert.doesNotThrow(() => safeUnlink("/tmp/this-file-does-not-exist-12345"));
  });
});

describe("suppressExpectedCiNoise", () => {
  it("suppresses known process-scraper noise lines", () => {
    const log = [
      "info exporter started",
      "error scraping process metrics: unknown userid 65535",
      "warn process no such process",
      "info flush complete",
    ].join("\n");
    const result = suppressExpectedCiNoise(log);
    assert.equal(result.suppressedLineCount, 2);
    assert.match(result.filteredLog, /exporter started/);
    assert.match(result.filteredLog, /flush complete/);
    assert.doesNotMatch(result.filteredLog, /unknown userid/);
  });

  it("keeps logs unchanged when no suppression patterns match", () => {
    const log = "info collector started\ninfo collector stopped";
    const result = suppressExpectedCiNoise(log);
    assert.equal(result.suppressedLineCount, 0);
    assert.equal(result.filteredLog, log);
  });
});

// ── stopCollector ───────────────────────────────────────────────────

describe("stopCollector", () => {
  it("handles an already-exited process gracefully", async () => {
    const state: OtelState = {
      pid: 99999999, // non-existent
      configPath: "/tmp/fake-config.yaml",
      outputPath: "/tmp/fake-output.jsonl",
      logPath: "/tmp/fake-otelcol.log",
      startTime: Date.now(),
      runId: "test-1",
      dataBranch: "bench-data",
    };
    // Should not throw
    await stopCollector(state);
  });

  it("stops a real child process via SIGTERM", async () => {
    // Spawn a long-running process (cross-platform)
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid!;
    assert.ok(pid > 0);
    assert.ok(isProcessRunning(pid), "child should be running");

    const state: OtelState = {
      pid,
      configPath: "/tmp/fake-config.yaml",
      outputPath: "/tmp/fake-output.jsonl",
      logPath: "/tmp/fake-otelcol.log",
      startTime: Date.now(),
      runId: "test-2",
      dataBranch: "bench-data",
    };

    await stopCollector(state);

    // Wait for process to be reaped (up to 2s)
    for (let i = 0; i < 20; i++) {
      if (!isProcessRunning(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(!isProcessRunning(pid), "child should be stopped");
  });
});

// ── Config YAML structural validation ───────────────────────────────

describe("generated config structural validation", () => {
  it("generates config that has all required top-level sections", async () => {
    const { generateCollectorConfig } = await import("./otel-config.js");
    const yaml = generateCollectorConfig({
      scrapeInterval: "1s",
      metricSets: ["cpu", "memory"],
      otlpGrpcPort: 4317,
      otlpHttpPort: 4318,
      outputPath: "/tmp/test.jsonl",
      runId: "test-run-1",
      ref: "refs/heads/main",
      commit: "abc123",
    });

    const lines = yaml.split("\n");
    const topLevelKeys = lines
      .filter((l) => /^\w/.test(l) && l.includes(":"))
      .map((l) => l.split(":")[0]);

    assert.ok(topLevelKeys.includes("receivers"), "must have receivers section");
    assert.ok(topLevelKeys.includes("processors"), "must have processors section");
    assert.ok(topLevelKeys.includes("exporters"), "must have exporters section");
    assert.ok(topLevelKeys.includes("service"), "must have service section");
  });

  it("generates consistent indentation (2-space)", async () => {
    const { generateCollectorConfig } = await import("./otel-config.js");
    const yaml = generateCollectorConfig({
      scrapeInterval: "1s",
      metricSets: ["cpu"],
      otlpGrpcPort: 4317,
      otlpHttpPort: 0,
      outputPath: "/tmp/test.jsonl",
      runId: "test-1",
    });

    const indentedLines = yaml.split("\n").filter((l) => l.startsWith(" "));
    for (const line of indentedLines) {
      const leadingSpaces = line.match(/^( *)/)![1].length;
      assert.equal(
        leadingSpaces % 2,
        0,
        `Line has odd indentation (${leadingSpaces} spaces): "${line}"`,
      );
    }
  });
});

// ── PPID tree walking & filtering ───────────────────────────────────

/**
 * Build an OTLP resource with process.pid and process.parent_pid attributes.
 */
function makeProcessResource(pid: number, ppid: number, metricName: string) {
  return {
    resource: {
      attributes: [
        { key: "process.pid", value: { intValue: String(pid) } },
        { key: "process.parent_pid", value: { intValue: String(ppid) } },
        { key: "process.executable.name", value: { stringValue: `proc-${pid}` } },
      ],
    },
    scopeMetrics: [{
      scope: { name: "otelcol/hostmetricsreceiver/process" },
      metrics: [{ name: metricName, gauge: { dataPoints: [{ asDouble: 42 }] } }],
    }],
  };
}

function makeSystemResource(metricName: string) {
  return {
    resource: { attributes: [] as Array<{ key: string; value: Record<string, unknown> }> },
    scopeMetrics: [{
      scope: { name: "otelcol/hostmetricsreceiver/cpu" },
      metrics: [{ name: metricName, gauge: { dataPoints: [{ asDouble: 99 }] } }],
    }],
  };
}

function makeJsonlLine(...resources: object[]) {
  return JSON.stringify({ resourceMetrics: resources });
}

describe("findDescendantPids", () => {
  it("finds direct children of ancestor", () => {
    // runner(1) -> bash(10), runner(1) -> node(20)
    const content = [
      makeJsonlLine(makeProcessResource(10, 1, "process.cpu.time")),
      makeJsonlLine(makeProcessResource(20, 1, "process.cpu.time")),
    ].join("\n");
    const descendants = findDescendantPids(content, 1);
    assert.ok(descendants.has(10));
    assert.ok(descendants.has(20));
  });

  it("finds nested descendants", () => {
    // runner(1) -> bash(10) -> go-test(100) -> worker(200)
    const content = [
      makeJsonlLine(makeProcessResource(10, 1, "process.cpu.time")),
      makeJsonlLine(makeProcessResource(100, 10, "process.cpu.time")),
      makeJsonlLine(makeProcessResource(200, 100, "process.cpu.time")),
    ].join("\n");
    const descendants = findDescendantPids(content, 1);
    assert.ok(descendants.has(10));
    assert.ok(descendants.has(100));
    assert.ok(descendants.has(200));
  });

  it("excludes processes not descended from ancestor", () => {
    // runner(1) -> bash(10), systemd(0) -> sshd(50)
    const content = [
      makeJsonlLine(makeProcessResource(10, 1, "process.cpu.time")),
      makeJsonlLine(makeProcessResource(50, 0, "process.cpu.time")),
    ].join("\n");
    const descendants = findDescendantPids(content, 1);
    assert.ok(descendants.has(10));
    assert.ok(!descendants.has(50));
  });

  it("returns empty set when no processes match", () => {
    const content = makeJsonlLine(makeProcessResource(50, 0, "process.cpu.time"));
    const descendants = findDescendantPids(content, 999);
    assert.equal(descendants.size, 0);
  });

  it("handles intValue as number (not string)", () => {
    const resource = {
      resource: {
        attributes: [
          { key: "process.pid", value: { intValue: 10 } },
          { key: "process.parent_pid", value: { intValue: 1 } },
        ],
      },
      scopeMetrics: [],
    };
    const content = JSON.stringify({ resourceMetrics: [resource] });
    const descendants = findDescendantPids(content, 1);
    assert.ok(descendants.has(10));
  });

  it("terminates on PID cycles without infinite recursion", () => {
    // Create a cycle: 10 -> 20 -> 10
    const content = [
      makeJsonlLine(makeProcessResource(10, 20, "process.cpu.time")),
      makeJsonlLine(makeProcessResource(20, 10, "process.cpu.time")),
    ].join("\n");
    // Neither is a descendant of 1, and should not infinite-loop
    const descendants = findDescendantPids(content, 1);
    assert.equal(descendants.size, 0);
  });

  it("handles empty input", () => {
    const descendants = findDescendantPids("", 1);
    assert.equal(descendants.size, 0);
  });

  it("handles malformed JSON lines gracefully", () => {
    const content = [
      "this is not json",
      makeJsonlLine(makeProcessResource(10, 1, "process.cpu.time")),
      '{"truncated": true',
    ].join("\n");
    const descendants = findDescendantPids(content, 1);
    assert.ok(descendants.has(10));
  });

  it("handles resources with missing attributes", () => {
    const content = JSON.stringify({
      resourceMetrics: [
        { resource: {} },
        { resource: { attributes: [] } },
        { resource: { attributes: [{ key: "process.pid", value: { intValue: 10 } }] } },
      ],
    });
    // PID 10 has no parent_pid, so it won't be in parentOf map
    const descendants = findDescendantPids(content, 1);
    assert.equal(descendants.size, 0);
  });
});

describe("filterToRunnerDescendants", () => {
  it("keeps runner descendants and removes system processes", () => {
    // runner(1) -> bash(10) -> benchmark(100)
    // systemd(0) -> sshd(50), systemd(0) -> dockerd(60)
    const content = [
      makeJsonlLine(
        makeProcessResource(10, 1, "process.cpu.time"),
        makeProcessResource(100, 10, "process.cpu.time"),
        makeProcessResource(50, 0, "process.cpu.time"),
        makeProcessResource(60, 0, "process.cpu.time"),
      ),
    ].join("\n");
    const { filtered, kept, removed } = filterToRunnerDescendants(content, 1);
    assert.equal(kept, 2);
    assert.equal(removed, 2);
    const parsed = JSON.parse(filtered.trim());
    assert.equal(parsed.resourceMetrics.length, 2);
  });

  it("keeps system-level metrics (no process.pid)", () => {
    const content = [
      makeJsonlLine(
        makeSystemResource("system.cpu.time"),
        makeProcessResource(50, 0, "process.cpu.time"),
      ),
    ].join("\n");
    const { kept, removed } = filterToRunnerDescendants(content, 1);
    assert.equal(kept, 1); // system resource
    assert.equal(removed, 1); // non-descendant process
  });

  it("drops entire JSONL line if all process resources are non-descendants", () => {
    const content = makeJsonlLine(
      makeProcessResource(50, 0, "process.cpu.time"),
      makeProcessResource(60, 0, "process.cpu.time"),
    );
    const { filtered, removed } = filterToRunnerDescendants(content, 1);
    assert.equal(removed, 2);
    assert.equal(filtered.trim(), "");
  });

  it("handles multi-line JSONL", () => {
    // runner(1) -> bash(10), systemd(0) -> sshd(50)
    const content = [
      makeJsonlLine(makeProcessResource(10, 1, "process.cpu.time"), makeProcessResource(50, 0, "process.cpu.time")),
      makeJsonlLine(makeProcessResource(10, 1, "process.memory.usage"), makeProcessResource(50, 0, "process.memory.usage")),
    ].join("\n");
    const { kept, removed } = filterToRunnerDescendants(content, 1);
    assert.equal(kept, 2);
    assert.equal(removed, 2);
  });

  it("keeps all resources when all processes are descendants", () => {
    const content = [
      makeJsonlLine(
        makeProcessResource(10, 1, "process.cpu.time"),
        makeProcessResource(100, 10, "process.cpu.time"),
      ),
    ].join("\n");
    const { kept, removed } = filterToRunnerDescendants(content, 1);
    assert.equal(kept, 2);
    assert.equal(removed, 0);
  });

  it("passes through malformed JSON lines unchanged", () => {
    const badLine = "not valid json";
    const goodLine = makeJsonlLine(makeProcessResource(10, 1, "process.cpu.time"));
    const content = [badLine, goodLine].join("\n");
    const { filtered, kept } = filterToRunnerDescendants(content, 1);
    assert.ok(filtered.includes(badLine));
    assert.equal(kept, 1);
  });

  it("handles empty input", () => {
    const { filtered, kept, removed } = filterToRunnerDescendants("", 1);
    assert.equal(kept, 0);
    assert.equal(removed, 0);
    assert.equal(filtered.trim(), "");
  });

  it("keeps user OTLP metrics with process.pid but no parent_pid", () => {
    // User-sent OTLP metrics may have process.pid set but not parent_pid
    const customOtlpResource = {
      resource: {
        attributes: [
          { key: "process.pid", value: { intValue: 999 } },
          { key: "custom.metric", value: { stringValue: "user-metric" } },
          // Note: no process.parent_pid attribute
        ],
      },
      scopeMetrics: [
        {
          scope: { name: "user-app" },
          metrics: [{ name: "custom.duration", gauge: { dataPoints: [{ asDouble: 42 }] } }],
        },
      ],
    };
    const content = makeJsonlLine(customOtlpResource);
    const { kept, removed } = filterToRunnerDescendants(content, 1);
    assert.equal(kept, 1, "user OTLP metric should be kept");
    assert.equal(removed, 0);
  });
});
