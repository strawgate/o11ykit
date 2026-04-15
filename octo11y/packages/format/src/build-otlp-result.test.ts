import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOtlpResult } from "./build-otlp-result.js";
import type { OtlpAttribute } from "./types.js";
import {
  ATTR_RUN_ID,
  ATTR_KIND,
  ATTR_SOURCE_FORMAT,
  ATTR_REF,
  ATTR_COMMIT,
  ATTR_SCENARIO,
  ATTR_SERIES,
  ATTR_METRIC_DIRECTION,
  ATTR_METRIC_ROLE,
} from "./otlp-conventions.js";

function findAttr(attrs: OtlpAttribute[], key: string): OtlpAttribute | undefined {
  return attrs.find((a) => a.key === key);
}

describe("buildOtlpResult", () => {
  it("produces a valid OtlpMetricsDocument with one benchmark", () => {
    const doc = buildOtlpResult({
      benchmarks: [{
        name: "BenchmarkParse",
        metrics: {
          ns_per_op: { value: 1234, unit: "ns/op", direction: "smaller_is_better" },
        },
      }],
      context: { sourceFormat: "go", runId: "123-1", kind: "code" },
    });

    assert.equal(doc.resourceMetrics.length, 1);
    const rm = doc.resourceMetrics[0];
    assert.ok(rm.resource?.attributes);

    // Resource attributes
    const resAttrs = rm.resource!.attributes!;
    assert.equal(findAttr(resAttrs, ATTR_RUN_ID)?.value?.stringValue, "123-1");
    assert.equal(findAttr(resAttrs, ATTR_KIND)?.value?.stringValue, "code");
    assert.equal(findAttr(resAttrs, ATTR_SOURCE_FORMAT)?.value?.stringValue, "go");

    // Scope metrics
    assert.equal(rm.scopeMetrics?.length, 1);
    const metrics = rm.scopeMetrics![0].metrics!;
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].name, "ns_per_op");
    assert.equal(metrics[0].unit, "ns/op");

    // Gauge datapoint
    const dp = metrics[0].gauge!.dataPoints![0];
    assert.equal(dp.asInt, "1234");
    assert.ok(dp.timeUnixNano);

    // Datapoint attributes
    const dpAttrs = dp.attributes!;
    assert.equal(findAttr(dpAttrs, ATTR_SCENARIO)?.value?.stringValue, "BenchmarkParse");
    assert.equal(findAttr(dpAttrs, ATTR_SERIES)?.value?.stringValue, "BenchmarkParse");
    assert.equal(findAttr(dpAttrs, ATTR_METRIC_DIRECTION)?.value?.stringValue, "smaller_is_better");
    assert.equal(findAttr(dpAttrs, ATTR_METRIC_ROLE)?.value?.stringValue, "outcome");
  });

  it("handles multiple benchmarks with multiple metrics", () => {
    const doc = buildOtlpResult({
      benchmarks: [
        {
          name: "BenchmarkA",
          metrics: {
            ns_per_op: { value: 100, unit: "ns/op", direction: "smaller_is_better" },
            b_per_op: { value: 64, unit: "B/op", direction: "smaller_is_better" },
          },
        },
        {
          name: "BenchmarkB",
          metrics: {
            ns_per_op: { value: 200, unit: "ns/op", direction: "smaller_is_better" },
          },
        },
      ],
      context: { sourceFormat: "go" },
    });

    const metrics = doc.resourceMetrics[0].scopeMetrics![0].metrics!;
    assert.equal(metrics.length, 3);
    assert.equal(metrics[0].name, "ns_per_op");
    assert.equal(metrics[1].name, "b_per_op");
    assert.equal(metrics[2].name, "ns_per_op");

    // First metric belongs to BenchmarkA
    const dp0 = metrics[0].gauge!.dataPoints![0];
    assert.equal(findAttr(dp0.attributes!, ATTR_SCENARIO)?.value?.stringValue, "BenchmarkA");

    // Third metric belongs to BenchmarkB
    const dp2 = metrics[2].gauge!.dataPoints![0];
    assert.equal(findAttr(dp2.attributes!, ATTR_SCENARIO)?.value?.stringValue, "BenchmarkB");
  });

  it("accepts numeric shorthand for metric values", () => {
    const doc = buildOtlpResult({
      benchmarks: [{
        name: "test",
        metrics: { score: 42 },
      }],
    });

    const dp = doc.resourceMetrics[0].scopeMetrics![0].metrics![0].gauge!.dataPoints![0];
    assert.equal(dp.asInt, "42");
  });

  it("uses asDouble for non-integer values", () => {
    const doc = buildOtlpResult({
      benchmarks: [{
        name: "test",
        metrics: { latency: { value: 1.5 } },
      }],
    });

    const dp = doc.resourceMetrics[0].scopeMetrics![0].metrics![0].gauge!.dataPoints![0];
    assert.equal(dp.asDouble, 1.5);
    assert.equal(dp.asInt, undefined);
  });

  it("includes tags as datapoint attributes", () => {
    const doc = buildOtlpResult({
      benchmarks: [{
        name: "BenchmarkParse",
        tags: { procs: "8", variant: "fast" },
        metrics: { ns_per_op: 100 },
      }],
      context: { sourceFormat: "go" },
    });

    const dp = doc.resourceMetrics[0].scopeMetrics![0].metrics![0].gauge!.dataPoints![0];
    const attrs = dp.attributes!;
    assert.equal(findAttr(attrs, "procs")?.value?.stringValue, "8");
    assert.equal(findAttr(attrs, "variant")?.value?.stringValue, "fast");
  });

  it("includes optional resource attributes when provided", () => {
    const doc = buildOtlpResult({
      benchmarks: [{ name: "test", metrics: { x: 1 } }],
      context: {
        sourceFormat: "go",
        runId: "run-1",
        kind: "code",
        ref: "refs/heads/main",
        commit: "abc123",
      },
    });

    const attrs = doc.resourceMetrics[0].resource!.attributes!;
    assert.equal(findAttr(attrs, ATTR_REF)?.value?.stringValue, "refs/heads/main");
    assert.equal(findAttr(attrs, ATTR_COMMIT)?.value?.stringValue, "abc123");
  });

  it("merges custom resource attributes from context", () => {
    const doc = buildOtlpResult({
      benchmarks: [{ name: "test", metrics: { x: 1 } }],
      context: {
        sourceFormat: "go",
        runId: "run-1",
        resourceAttributes: {
          team: "platform",
          batch_size: 2000,
          warm: true,
        },
      },
    });

    const attrs = doc.resourceMetrics[0].resource!.attributes!;
    assert.equal(findAttr(attrs, ATTR_RUN_ID)?.value?.stringValue, "run-1");
    assert.equal(findAttr(attrs, "team")?.value?.stringValue, "platform");
    assert.equal(findAttr(attrs, "batch_size")?.value?.intValue, "2000");
    assert.equal(findAttr(attrs, "warm")?.value?.boolValue, true);
  });

  it("defaults to otlp source format when no context is provided", () => {
    const doc = buildOtlpResult({
      benchmarks: [{ name: "test", metrics: { x: 1 } }],
    });

    const attrs = doc.resourceMetrics[0].resource!.attributes!;
    assert.equal(findAttr(attrs, ATTR_SOURCE_FORMAT)?.value?.stringValue, "otlp");
  });

  it("omits direction attribute when not specified", () => {
    const doc = buildOtlpResult({
      benchmarks: [{
        name: "test",
        metrics: { score: { value: 42 } },
      }],
    });

    const dp = doc.resourceMetrics[0].scopeMetrics![0].metrics![0].gauge!.dataPoints![0];
    assert.equal(findAttr(dp.attributes!, ATTR_METRIC_DIRECTION), undefined);
  });
});
