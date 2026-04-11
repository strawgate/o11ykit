import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { defaultMetricLabel, defaultMonitorMetricLabel } from "./labels.js";

describe("defaultMetricLabel", () => {
  it("formats common benchmark metrics into readable labels", () => {
    assert.equal(defaultMetricLabel("ns_per_op"), "ns/op");
    assert.equal(defaultMetricLabel("bytes_per_op"), "bytes/op");
    assert.equal(defaultMetricLabel("allocs_per_op"), "allocs/op");
  });

  it("falls back to replacing underscores for custom metrics", () => {
    assert.equal(defaultMetricLabel("requests_per_second"), "requests/second");
    assert.equal(defaultMetricLabel("cache_hit_rate"), "cache hit rate");
  });

  it("delegates monitor metrics to the monitor label formatter", () => {
    assert.equal(defaultMetricLabel("_monitor/cpu_user_pct"), "CPU user %");
  });
});

describe("defaultMonitorMetricLabel", () => {
  it("uses friendly labels for known monitor metrics", () => {
    assert.equal(defaultMonitorMetricLabel("_monitor/wall_clock_ms"), "Wall clock time (ms)");
    assert.equal(defaultMonitorMetricLabel("_monitor/mem_available_min_mb"), "Lowest available memory (MB)");
  });

  it("formats unknown monitor metrics into title case", () => {
    assert.equal(defaultMonitorMetricLabel("_monitor/process/background_worker"), "Process Background Worker");
    assert.equal(defaultMonitorMetricLabel("_monitor/custom_probe"), "Custom Probe");
  });
});
