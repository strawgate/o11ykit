import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOtlpMetricPayload,
  emitMetricRequest,
  normalizeOtlpHttpMetricsUrl,
  parseAttributes,
} from "./emit-metric.js";

describe("normalizeOtlpHttpMetricsUrl", () => {
  it("appends /v1/metrics when given a collector base endpoint", () => {
    assert.equal(
      normalizeOtlpHttpMetricsUrl("http://localhost:4318"),
      "http://localhost:4318/v1/metrics",
    );
  });

  it("preserves an explicit /v1/metrics path", () => {
    assert.equal(
      normalizeOtlpHttpMetricsUrl("http://localhost:4318/v1/metrics"),
      "http://localhost:4318/v1/metrics",
    );
  });

  it("trims trailing slashes", () => {
    assert.equal(
      normalizeOtlpHttpMetricsUrl("http://localhost:4318///"),
      "http://localhost:4318/v1/metrics",
    );
  });
});

describe("parseAttributes", () => {
  it("parses JSON attributes with typed values", () => {
    assert.deepEqual(
      parseAttributes('{"dataset":"wiki","batch_size":2000,"warm":true}'),
      {
        dataset: "wiki",
        batch_size: 2000,
        warm: true,
      },
    );
  });

  it("parses key=value lines", () => {
    assert.deepEqual(
      parseAttributes("dataset=wiki\nvariant=bm25"),
      {
        dataset: "wiki",
        variant: "bm25",
      },
    );
  });

  it("rejects invalid line attributes", () => {
    assert.throws(
      () => parseAttributes("dataset"),
      /key=value/,
    );
  });

  it("preserves commas in line-mode values", () => {
    assert.deepEqual(
      parseAttributes("label=hello, world\nregion=us-east-1"),
      {
        label: "hello, world",
        region: "us-east-1",
      },
    );
  });
});

describe("buildOtlpMetricPayload", () => {
  it("builds a gauge payload with benchkit semantic attributes", () => {
    const payload = buildOtlpMetricPayload({
      endpoint: "http://localhost:4318/v1/metrics",
      name: "test_score",
      value: 74,
      unit: "points",
      metricKind: "gauge",
      aggregationTemporality: "cumulative",
      monotonic: false,
      description: "Search relevance score",
      scenario: "search-relevance",
      series: "baseline",
      direction: "bigger_is_better",
      role: "outcome",
      attributes: { dataset: "wiki" },
      resourceAttributes: { team: "platform", batch_size: 2000, warm: true },
      runId: "123-1",
      benchkitKind: "hybrid",
      serviceName: "benchkit-selftest",
      ref: "refs/heads/main",
      commit: "abc123",
      workflow: "Bench",
      job: "bench",
      runAttempt: "1",
    }, new Date("2026-04-02T03:00:00.000Z"));

    const resourceMetrics = payload.resourceMetrics as Array<Record<string, unknown>>;
    assert.equal(resourceMetrics.length, 1);

    const scopeMetrics = resourceMetrics[0].scopeMetrics as Array<Record<string, unknown>>;
    const metrics = scopeMetrics[0].metrics as Array<Record<string, unknown>>;
    assert.equal(metrics[0].name, "test_score");
    assert.equal(metrics[0].unit, "points");
    assert.ok(metrics[0].gauge);

    const resource = resourceMetrics[0].resource as Record<string, unknown>;
    const resourceAttributes = resource.attributes as Array<{ key: string; value: Record<string, unknown> }>;
    assert.ok(resourceAttributes.some((attr) => attr.key === "benchkit.run_id"));
    assert.ok(resourceAttributes.some((attr) => attr.key === "benchkit.kind"));
    assert.ok(resourceAttributes.some((attr) => attr.key === "service.name"));
    assert.ok(resourceAttributes.some((attr) => attr.key === "team"));
    assert.ok(resourceAttributes.some((attr) => attr.key === "batch_size"));
    assert.ok(resourceAttributes.some((attr) => attr.key === "warm"));

    const gauge = metrics[0].gauge as { dataPoints: Array<Record<string, unknown>> };
    const dataPoint = gauge.dataPoints[0];
    const pointAttributes = dataPoint.attributes as Array<{ key: string; value: Record<string, unknown> }>;
    assert.ok(pointAttributes.some((attr) => attr.key === "benchkit.scenario"));
    assert.ok(pointAttributes.some((attr) => attr.key === "benchkit.series"));
    assert.ok(pointAttributes.some((attr) => attr.key === "benchkit.metric.direction"));
    assert.ok(pointAttributes.some((attr) => attr.key === "dataset"));
    assert.equal(dataPoint.asInt, "74");
  });

  it("builds a sum payload with temporality metadata", () => {
    const payload = buildOtlpMetricPayload({
      endpoint: "http://localhost:4318/v1/metrics",
      name: "docs_indexed_total",
      value: 2000,
      unit: "docs",
      metricKind: "sum",
      aggregationTemporality: "delta",
      monotonic: true,
      scenario: "bulk-index",
      series: "candidate",
      direction: "bigger_is_better",
      role: "outcome",
      attributes: {},
      resourceAttributes: {},
      runId: "123-1",
      benchkitKind: "workflow",
    }, new Date("2026-04-02T03:00:00.000Z"));

    const resourceMetrics = payload.resourceMetrics as Array<Record<string, unknown>>;
    const scopeMetrics = resourceMetrics[0].scopeMetrics as Array<Record<string, unknown>>;
    const metrics = scopeMetrics[0].metrics as Array<Record<string, unknown>>;
    const sum = metrics[0].sum as Record<string, unknown>;
    assert.equal(sum.aggregationTemporality, 1);
    assert.equal(sum.isMonotonic, true);
  });

  it("rejects reserved custom attributes", () => {
    assert.throws(
      () => buildOtlpMetricPayload({
        endpoint: "http://localhost:4318/v1/metrics",
        name: "test_score",
        value: 74,
        metricKind: "gauge",
        aggregationTemporality: "cumulative",
        monotonic: false,
        scenario: "search",
        series: "baseline",
        direction: "bigger_is_better",
        role: "outcome",
        attributes: { "benchkit.scenario": "oops" },
        resourceAttributes: {},
        runId: "123-1",
        benchkitKind: "hybrid",
      }),
      /reserved/,
    );
  });

  it("rejects custom attributes with benchkit. prefix", () => {
    assert.throws(
      () => buildOtlpMetricPayload({
        endpoint: "http://localhost:4318/v1/metrics",
        name: "test_score",
        value: 74,
        metricKind: "gauge",
        aggregationTemporality: "cumulative",
        monotonic: false,
        scenario: "search",
        series: "baseline",
        direction: "bigger_is_better",
        role: "outcome",
        attributes: { "benchkit.custom.foo": "bar" },
        resourceAttributes: {},
        runId: "123-1",
        benchkitKind: "hybrid",
      }),
      /Custom attributes must not use the 'benchkit\.' prefix/,
    );
  });

  it("rejects resource attributes with benchkit. prefix", () => {
    assert.throws(
      () => buildOtlpMetricPayload({
        endpoint: "http://localhost:4318/v1/metrics",
        name: "test_score",
        value: 74,
        metricKind: "gauge",
        aggregationTemporality: "cumulative",
        monotonic: false,
        scenario: "search",
        series: "baseline",
        direction: "bigger_is_better",
        role: "outcome",
        attributes: {},
        resourceAttributes: { "benchkit.team": "platform" },
        runId: "123-1",
        benchkitKind: "hybrid",
      }),
      /Resource attributes must not use the 'benchkit\.' prefix/,
    );
  });
});

describe("emitMetricRequest", () => {
  it("posts JSON to the collector endpoint", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    let capturedContentType = "";

    await emitMetricRequest({
      url: "http://localhost:4318/v1/metrics",
      payload: { resourceMetrics: [] },
      timeoutMs: 1000,
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedMethod = String(init?.method);
        capturedBody = String(init?.body);
        const headers = new Headers(init?.headers as HeadersInit);
        capturedContentType = headers.get("content-type") || "";
        return new Response("", { status: 200 });
      },
    });

    assert.equal(capturedUrl, "http://localhost:4318/v1/metrics");
    assert.equal(capturedMethod, "POST");
    assert.equal(capturedBody, '{"resourceMetrics":[]}');
    assert.equal(capturedContentType, "application/json");
  });

  it("surfaces collector errors", async () => {
    await assert.rejects(
      () => emitMetricRequest({
        url: "http://localhost:4318/v1/metrics",
        payload: { resourceMetrics: [] },
        timeoutMs: 1000,
        fetchImpl: async () => new Response("bad request", { status: 400, statusText: "Bad Request" }),
      }),
      /Collector rejected metric emission/,
    );
  });

  it("retries on 5xx errors and succeeds", async () => {
    let attempts = 0;
    await emitMetricRequest({
      url: "http://localhost:4318/v1/metrics",
      payload: { resourceMetrics: [] },
      timeoutMs: 1000,
      maxRetries: 3,
      fetchImpl: async () => {
        attempts++;
        if (attempts < 3) {
          return new Response("internal error", { status: 500, statusText: "Internal Server Error" });
        }
        return new Response("", { status: 200 });
      },
    });
    assert.equal(attempts, 3);
  });

  it("retries on 429 Too Many Requests", async () => {
    let attempts = 0;
    await emitMetricRequest({
      url: "http://localhost:4318/v1/metrics",
      payload: { resourceMetrics: [] },
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl: async () => {
        attempts++;
        if (attempts < 2) {
          return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
        }
        return new Response("", { status: 200 });
      },
    });
    assert.equal(attempts, 2);
  });

  it("throws after exhausting retries on 5xx", async () => {
    let attempts = 0;
    await assert.rejects(
      () => emitMetricRequest({
        url: "http://localhost:4318/v1/metrics",
        payload: { resourceMetrics: [] },
        timeoutMs: 1000,
        maxRetries: 2,
        fetchImpl: async () => {
          attempts++;
          return new Response("server down", { status: 503, statusText: "Service Unavailable" });
        },
      }),
      /Collector rejected metric emission \(503 Service Unavailable\): server down/,
    );
    assert.equal(attempts, 2);
  });

  it("does not retry on 4xx errors", async () => {
    let attempts = 0;
    await assert.rejects(
      () => emitMetricRequest({
        url: "http://localhost:4318/v1/metrics",
        payload: { resourceMetrics: [] },
        timeoutMs: 1000,
        maxRetries: 3,
        fetchImpl: async () => {
          attempts++;
          return new Response("bad request", { status: 400, statusText: "Bad Request" });
        },
      }),
      /Collector rejected metric emission/,
    );
    assert.equal(attempts, 1);
  });
});

describe("normalizeOtlpHttpMetricsUrl — error paths", () => {
  it("rejects empty endpoint", () => {
    assert.throws(
      () => normalizeOtlpHttpMetricsUrl(""),
      /OTLP HTTP endpoint must not be empty/,
    );
  });

  it("rejects whitespace-only endpoint", () => {
    assert.throws(
      () => normalizeOtlpHttpMetricsUrl("   "),
      /OTLP HTTP endpoint must not be empty/,
    );
  });
});

describe("parseAttributes — error paths", () => {
  it("rejects non-object JSON (array)", () => {
    assert.throws(
      () => parseAttributes('[1,2,3]'),
      /key=value/,
    );
  });

  it("rejects empty keys in JSON", () => {
    assert.throws(
      () => parseAttributes('{"": "val"}'),
      /Attribute keys must not be empty/,
    );
  });

  it("rejects unsupported attribute types in JSON", () => {
    assert.throws(
      () => parseAttributes('{"key": [1]}'),
      /must be a string, number, or boolean/,
    );
  });

  it("rejects line entries without equals sign", () => {
    assert.throws(
      () => parseAttributes("no-equals-here"),
      /key=value/,
    );
  });
});
