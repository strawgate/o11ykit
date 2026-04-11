import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isMonitorMetric } from "./labels.js";

describe("isMonitorMetric", () => {
  it("returns true for _monitor/ prefixed metrics", () => {
    assert.equal(isMonitorMetric("_monitor/system"), true);
    assert.equal(isMonitorMetric("_monitor/process/worker"), true);
    assert.equal(isMonitorMetric("_monitor/cpu_user_pct"), true);
  });

  it("returns false for regular metrics", () => {
    assert.equal(isMonitorMetric("ns_per_op"), false);
    assert.equal(isMonitorMetric("bytes_per_op"), false);
    assert.equal(isMonitorMetric("eps"), false);
  });

  it("returns false for metrics that contain but do not start with _monitor/", () => {
    assert.equal(isMonitorMetric("my_monitor/metric"), false);
    assert.equal(isMonitorMetric("benchmark/_monitor/foo"), false);
  });
});

describe("metric partitioning", () => {
  const allMetrics = [
    "ns_per_op",
    "bytes_per_op",
    "_monitor/system",
    "_monitor/process/worker",
    "allocs_per_op",
  ];

  it("correctly separates user metrics from monitor metrics", () => {
    const userMetrics = allMetrics.filter((m) => !isMonitorMetric(m));
    const monitorMetrics = allMetrics.filter((m) => isMonitorMetric(m));

    assert.deepEqual(userMetrics, ["ns_per_op", "bytes_per_op", "allocs_per_op"]);
    assert.deepEqual(monitorMetrics, ["_monitor/system", "_monitor/process/worker"]);
  });

  it("returns all metrics as user metrics when no monitor metrics present", () => {
    const metrics = ["ns_per_op", "bytes_per_op"];
    const userMetrics = metrics.filter((m) => !isMonitorMetric(m));
    const monitorMetrics = metrics.filter((m) => isMonitorMetric(m));

    assert.deepEqual(userMetrics, ["ns_per_op", "bytes_per_op"]);
    assert.deepEqual(monitorMetrics, []);
  });

  it("returns all metrics as monitor metrics when all are monitor metrics", () => {
    const metrics = ["_monitor/system", "_monitor/process/worker"];
    const userMetrics = metrics.filter((m) => !isMonitorMetric(m));
    const monitorMetrics = metrics.filter((m) => isMonitorMetric(m));

    assert.deepEqual(userMetrics, []);
    assert.deepEqual(monitorMetrics, ["_monitor/system", "_monitor/process/worker"]);
  });
});
