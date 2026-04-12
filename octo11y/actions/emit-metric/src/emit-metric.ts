import * as core from "@actions/core";
import { inferDirection } from "@benchkit/format";

type BenchkitDirection = "bigger_is_better" | "smaller_is_better";
type BenchkitKind = "code" | "workflow" | "hybrid";
type BenchkitRole = "outcome" | "diagnostic";
type MetricKind = "gauge" | "sum";
type AggregationTemporality = "delta" | "cumulative";
type AttributeValue = string | number | boolean;

const RESERVED_POINT_ATTRIBUTES = new Set([
  "benchkit.scenario",
  "benchkit.series",
  "benchkit.metric.direction",
  "benchkit.metric.role",
]);

interface OtlpAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

export interface EmitMetricOptions {
  endpoint: string;
  name: string;
  value: number;
  unit?: string;
  metricKind: MetricKind;
  aggregationTemporality: AggregationTemporality;
  monotonic: boolean;
  description?: string;
  scenario: string;
  series: string;
  direction: BenchkitDirection;
  role: BenchkitRole;
  attributes: Record<string, AttributeValue>;
  runId: string;
  benchkitKind: BenchkitKind;
  serviceName?: string;
  resourceAttributes: Record<string, AttributeValue>;
  ref?: string;
  commit?: string;
  workflow?: string;
  job?: string;
  runAttempt?: string;
}

export interface EmitMetricRequest {
  url: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

function defaultRunId(): string {
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  if (runId) return `${runId}-${attempt}`;
  return `local-${Date.now()}`;
}

export function normalizeOtlpHttpMetricsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("OTLP HTTP endpoint must not be empty.");
  }
  return trimmed.endsWith("/v1/metrics") ? trimmed : `${trimmed}/v1/metrics`;
}

function parseMetricKind(input: string): MetricKind {
  if (input === "gauge" || input === "sum") return input;
  throw new Error(`Unsupported metric-kind '${input}'. Expected 'gauge' or 'sum'.`);
}

function parseBenchkitKind(input: string): BenchkitKind {
  if (input === "code" || input === "workflow" || input === "hybrid") return input;
  throw new Error(`Unsupported benchkit-kind '${input}'. Expected 'code', 'workflow', or 'hybrid'.`);
}

function parseBenchkitRole(input: string): BenchkitRole {
  if (input === "outcome" || input === "diagnostic") return input;
  throw new Error(`Unsupported role '${input}'. Expected 'outcome' or 'diagnostic'.`);
}

function parseDirection(input: string, fallbackHint: string): BenchkitDirection {
  if (!input) return inferDirection(fallbackHint);
  if (input === "bigger_is_better" || input === "smaller_is_better") return input;
  throw new Error(
    `Unsupported direction '${input}'. Expected 'bigger_is_better' or 'smaller_is_better'.`,
  );
}

function parseTemporality(input: string): AggregationTemporality {
  if (input === "delta" || input === "cumulative") return input;
  throw new Error(
    `Unsupported aggregation-temporality '${input}'. Expected 'delta' or 'cumulative'.`,
  );
}

function parseFiniteNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Input '${name}' must be a finite number. Received '${value}'.`);
  }
  return parsed;
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Input '${name}' must be a positive integer. Received '${value}'.`);
  }
  return parsed;
}

export function parseAttributes(raw: string): Record<string, AttributeValue> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Attributes JSON must be an object.");
    }

    const result: Record<string, AttributeValue> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.trim()) {
        throw new Error("Attribute keys must not be empty.");
      }
      if (
        typeof value !== "string"
        && typeof value !== "number"
        && typeof value !== "boolean"
      ) {
        throw new Error(
          `Attribute '${key}' must be a string, number, or boolean.`,
        );
      }
      result[key] = value;
    }
    return result;
  }

  const result: Record<string, AttributeValue> = {};
  const entries = trimmed
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(
        `Attribute entry '${entry}' must use key=value format.`,
      );
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!key) {
      throw new Error("Attribute keys must not be empty.");
    }
    result[key] = value;
  }

  return result;
}

function toOtlpAttributeValue(value: AttributeValue): OtlpAttribute["value"] {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  return { stringValue: value };
}

function buildAttribute(key: string, value: AttributeValue): OtlpAttribute {
  return {
    key,
    value: toOtlpAttributeValue(value),
  };
}

function buildResourceAttributes(options: EmitMetricOptions): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = [
    buildAttribute("benchkit.run_id", options.runId),
    buildAttribute("benchkit.kind", options.benchkitKind),
    buildAttribute("benchkit.source_format", "otlp"),
  ];

  if (options.ref) attributes.push(buildAttribute("benchkit.ref", options.ref));
  if (options.commit) attributes.push(buildAttribute("benchkit.commit", options.commit));
  if (options.workflow) attributes.push(buildAttribute("benchkit.workflow", options.workflow));
  if (options.job) attributes.push(buildAttribute("benchkit.job", options.job));
  if (options.runAttempt) attributes.push(buildAttribute("benchkit.run_attempt", options.runAttempt));
  if (options.serviceName) attributes.push(buildAttribute("service.name", options.serviceName));
  for (const key of Object.keys(options.resourceAttributes)) {
    if (key.startsWith("benchkit.")) {
      throw new Error(
        `Resource attributes must not use the 'benchkit.' prefix. Got '${key}'.`,
      );
    }
  }
  for (const [key, value] of Object.entries(options.resourceAttributes)) {
    attributes.push(buildAttribute(key, value));
  }

  return attributes;
}

function buildPointAttributes(options: EmitMetricOptions): OtlpAttribute[] {
  for (const key of Object.keys(options.attributes)) {
    if (RESERVED_POINT_ATTRIBUTES.has(key)) {
      throw new Error(
        `Attribute '${key}' is reserved. Use the dedicated action inputs instead.`,
      );
    }
    if (key.startsWith("benchkit.")) {
      throw new Error(
        `Custom attributes must not use the 'benchkit.' prefix. Got '${key}'.`,
      );
    }
  }

  const attributes: OtlpAttribute[] = [
    buildAttribute("benchkit.scenario", options.scenario),
    buildAttribute("benchkit.series", options.series),
    buildAttribute("benchkit.metric.direction", options.direction),
    buildAttribute("benchkit.metric.role", options.role),
  ];

  for (const [key, value] of Object.entries(options.attributes)) {
    attributes.push(buildAttribute(key, value));
  }

  return attributes;
}

function buildDataPointValue(value: number): { asInt?: string; asDouble?: number } {
  if (Number.isSafeInteger(value)) {
    return { asInt: String(value) };
  }
  return { asDouble: value };
}

function aggregationTemporalityNumber(value: AggregationTemporality): 1 | 2 {
  return value === "delta" ? 1 : 2;
}

export function buildOtlpMetricPayload(
  options: EmitMetricOptions,
  now: Date = new Date(),
): Record<string, unknown> {
  const timestampNanos = String(BigInt(now.getTime()) * 1_000_000n);
  const point = {
    timeUnixNano: timestampNanos,
    attributes: buildPointAttributes(options),
    ...buildDataPointValue(options.value),
  };

  const metric: Record<string, unknown> = {
    name: options.name,
    unit: options.unit || undefined,
    description: options.description || undefined,
  };

  if (options.metricKind === "gauge") {
    metric.gauge = { dataPoints: [point] };
  } else {
    metric.sum = {
      aggregationTemporality: aggregationTemporalityNumber(options.aggregationTemporality),
      isMonotonic: options.monotonic,
      dataPoints: [point],
    };
  }

  return {
    resourceMetrics: [{
      resource: {
        attributes: buildResourceAttributes(options),
      },
      scopeMetrics: [{
        scope: {
          name: "benchkit.emit-metric",
        },
        metrics: [metric],
      }],
    }],
  };
}

const DEFAULT_EMIT_RETRIES = 3;
const RETRY_BASE_MS = 500;

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export async function emitMetricRequest(options: EmitMetricRequest): Promise<void> {
  const maxRetries = options.maxRetries ?? DEFAULT_EMIT_RETRIES;
  const fetchImpl = options.fetchImpl ?? fetch;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(options.payload),
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (response.ok) return;

    if (isRetryableStatus(response.status) && attempt < maxRetries) {
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise<void>((r) => setTimeout(r, delayMs));
      continue;
    }

    const body = (await response.text()).trim();
    throw new Error(
      `Collector rejected metric emission (${response.status} ${response.statusText})${body ? `: ${body}` : "."}`,
    );
  }
}

export async function runEmitMetricAction(): Promise<void> {
  const endpoint = normalizeOtlpHttpMetricsUrl(
    core.getInput("otlp-http-endpoint") || "http://localhost:4318",
  );
  const name = core.getInput("name", { required: true }).trim();
  if (!name) {
    throw new Error("Input 'name' must not be blank.");
  }
  const unit = core.getInput("unit").trim();
  const metricKind = parseMetricKind(core.getInput("metric-kind") || "gauge");
  const aggregationTemporality = parseTemporality(
    core.getInput("aggregation-temporality") || "cumulative",
  );
  const monotonic = core.getBooleanInput("monotonic");
  const description = core.getInput("description").trim();
  const scenario = core.getInput("scenario").trim() || name;
  const series = core.getInput("series").trim() || process.env.GITHUB_JOB || "default";
  const direction = parseDirection(
    core.getInput("direction").trim(),
    unit || name,
  );
  const role = parseBenchkitRole(core.getInput("role") || "outcome");
  const attributes = parseAttributes(core.getInput("attributes") || "");
  const resourceAttributes = parseAttributes(core.getInput("resource-attributes") || "");
  const runId = core.getInput("run-id").trim() || defaultRunId();
  const benchkitKind = parseBenchkitKind(core.getInput("benchkit-kind") || "hybrid");
  const serviceName = core.getInput("service-name").trim() || process.env.GITHUB_REPOSITORY;
  const timeoutMs = parsePositiveInteger(
    "timeout-ms",
    core.getInput("timeout-ms") || "10000",
  );
  const rawValue = core.getInput("value", { required: true }).trim();
  if (!rawValue) {
    throw new Error("Input 'value' must not be blank.");
  }
  const value = parseFiniteNumber("value", rawValue);

  const payload = buildOtlpMetricPayload({
    endpoint,
    name,
    value,
    unit,
    metricKind,
    aggregationTemporality,
    monotonic,
    description,
    scenario,
    series,
    direction,
    role,
    attributes,
    resourceAttributes,
    runId,
    benchkitKind,
    serviceName,
    ref: process.env.GITHUB_REF,
    commit: process.env.GITHUB_SHA,
    workflow: process.env.GITHUB_WORKFLOW,
    job: process.env.GITHUB_JOB,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });

  await emitMetricRequest({
    url: endpoint,
    payload,
    timeoutMs,
  });

  core.info(
    `Emitted ${metricKind} metric '${name}'=${value} to ${endpoint} for scenario '${scenario}' / series '${series}'.`,
  );
  core.setOutput("run-id", runId);
  core.setOutput("request-url", endpoint);
}
