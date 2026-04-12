import { inferDirection } from "@benchkit/format";
import * as fs from "node:fs";
import * as path from "node:path";

type BenchkitDirection = "bigger_is_better" | "smaller_is_better";
type BenchkitKind = "code" | "workflow" | "hybrid";
type BenchkitRole = "outcome" | "diagnostic";
type AttributeValue = string | number | boolean;

type ParsedArgs = {
  name: string;
  value: number;
  unit?: string;
  scenario: string;
  series: string;
  direction: BenchkitDirection;
  role: BenchkitRole;
  kind: BenchkitKind;
  runId: string;
  endpoint?: string;
  outputDir?: string;
  timeoutMs: number;
  attributes: Record<string, AttributeValue>;
  resourceAttributes: Record<string, AttributeValue>;
};

type OtlpAttribute = {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
};

const RESERVED_POINT_ATTRIBUTES = new Set([
  "benchkit.scenario",
  "benchkit.series",
  "benchkit.metric.direction",
  "benchkit.metric.role",
]);

function printHelp(): void {
  console.log(`benchkit-emit — emit a custom OTLP metric via benchkit monitor\n\nUsage:\n  benchkit-emit --name <metric> --value <number> [options]\n\nOptions:\n  --name <name>                    Metric name (required)\n  --value <number>                 Metric value (required)\n  --unit <unit>                    Metric unit (ms, bytes, %, etc.)\n  --scenario <scenario>            Scenario label (default: metric name)\n  --series <series>                Series label (default: GITHUB_JOB or 'default')\n  --direction <dir>                bigger_is_better|smaller_is_better|up|down\n  --role <role>                    outcome|diagnostic (default: outcome)\n  --kind <kind>                    code|workflow|hybrid (default: hybrid)\n  --run-id <id>                    Override run id (default: BENCHKIT_RUN_ID or GITHUB_RUN_ID-attempt)\n  --endpoint <url>                 OTLP HTTP endpoint (default: BENCHKIT_EMIT_ENDPOINT)\n  --output <dir>                   Output directory for *.otlp.json fallback (default: BENCHKIT_METRICS_DIR)\n  --timeout-ms <ms>                HTTP timeout in milliseconds (default: 10000)\n  --attribute <k=v>                Repeatable datapoint attribute\n  --resource-attribute <k=v>       Repeatable resource attribute\n  --help                           Show this help\n\nBehavior:\n  If --endpoint (or BENCHKIT_EMIT_ENDPOINT) is set, emits over HTTP.\n  If no endpoint is set, or emission fails and --output is available, writes an OTLP JSON file.`);
}

function defaultRunId(): string {
  const explicit = process.env.BENCHKIT_RUN_ID;
  if (explicit) return explicit;
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  if (runId) return `${runId}-${attempt}`;
  return `local-${Date.now()}`;
}

function parseDirection(raw: string | undefined, fallbackHint: string): BenchkitDirection {
  if (!raw) return inferDirection(fallbackHint);
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "bigger_is_better"
    || normalized === "bigger"
    || normalized === "up"
    || normalized === "higher"
  ) {
    return "bigger_is_better";
  }
  if (
    normalized === "smaller_is_better"
    || normalized === "smaller"
    || normalized === "down"
    || normalized === "lower"
  ) {
    return "smaller_is_better";
  }
  throw new Error(
    `Unsupported direction '${raw}'. Expected bigger_is_better|smaller_is_better|up|down.`,
  );
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("OTLP HTTP endpoint must not be empty.");
  }
  return trimmed.endsWith("/v1/metrics") ? trimmed : `${trimmed}/v1/metrics`;
}

function parseFiniteNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`'${name}' must be a finite number. Received '${value}'.`);
  }
  return parsed;
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`'${name}' must be a positive integer. Received '${value}'.`);
  }
  return parsed;
}

function parseScalar(value: string): AttributeValue {
  const lowered = value.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "") {
    return asNumber;
  }
  return value;
}

function parseKeyValueEntry(entry: string): [string, AttributeValue] {
  const separator = entry.indexOf("=");
  if (separator <= 0) {
    throw new Error(`Attribute '${entry}' must use key=value format.`);
  }
  const key = entry.slice(0, separator).trim();
  const value = entry.slice(separator + 1).trim();
  if (!key) {
    throw new Error("Attribute key must not be empty.");
  }
  return [key, parseScalar(value)];
}

function sanitizeFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "metric";
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help") {
      printHelp();
      process.exit(0);
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument '${token}'. Use --help for usage.`);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for '--${key}'.`);
    }
    i += 1;
    const existing = flags.get(key) ?? [];
    existing.push(value);
    flags.set(key, existing);
  }

  const requiredSingle = (name: string): string => {
    const values = flags.get(name) ?? [];
    if (values.length === 0) {
      throw new Error(`Missing required argument '--${name}'.`);
    }
    return values[values.length - 1].trim();
  };
  const optionalSingle = (name: string): string | undefined => {
    const values = flags.get(name) ?? [];
    if (values.length === 0) return undefined;
    return values[values.length - 1].trim();
  };

  const attributes: Record<string, AttributeValue> = {};
  for (const raw of flags.get("attribute") ?? []) {
    const [key, value] = parseKeyValueEntry(raw);
    attributes[key] = value;
  }

  const resourceAttributes: Record<string, AttributeValue> = {};
  for (const raw of flags.get("resource-attribute") ?? []) {
    const [key, value] = parseKeyValueEntry(raw);
    resourceAttributes[key] = value;
  }

  const name = requiredSingle("name");
  if (!name) {
    throw new Error("'--name' must not be blank.");
  }
  const unit = optionalSingle("unit");
  const scenario = optionalSingle("scenario") || name;
  const series = optionalSingle("series") || process.env.GITHUB_JOB || "default";
  const direction = parseDirection(optionalSingle("direction"), unit || name);
  const roleInput = optionalSingle("role") || "outcome";
  if (roleInput !== "outcome" && roleInput !== "diagnostic") {
    throw new Error(`Unsupported role '${roleInput}'. Expected outcome|diagnostic.`);
  }
  const kindInput = optionalSingle("kind") || "hybrid";
  if (kindInput !== "code" && kindInput !== "workflow" && kindInput !== "hybrid") {
    throw new Error(`Unsupported kind '${kindInput}'. Expected code|workflow|hybrid.`);
  }

  return {
    name,
    value: parseFiniteNumber("value", requiredSingle("value")),
    unit,
    scenario,
    series,
    direction,
    role: roleInput,
    kind: kindInput,
    runId: optionalSingle("run-id") || defaultRunId(),
    endpoint: optionalSingle("endpoint") || process.env.BENCHKIT_EMIT_ENDPOINT,
    outputDir: optionalSingle("output") || process.env.BENCHKIT_METRICS_DIR,
    timeoutMs: parsePositiveInteger("timeout-ms", optionalSingle("timeout-ms") || "10000"),
    attributes,
    resourceAttributes,
  };
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

function validatePointAttributes(attributes: Record<string, AttributeValue>): void {
  for (const key of Object.keys(attributes)) {
    if (RESERVED_POINT_ATTRIBUTES.has(key)) {
      throw new Error(`Attribute '${key}' is reserved. Use a dedicated option instead.`);
    }
    if (key.startsWith("benchkit.")) {
      throw new Error(`Custom attributes must not use the 'benchkit.' prefix. Got '${key}'.`);
    }
  }
}

function validateResourceAttributes(attributes: Record<string, AttributeValue>): void {
  for (const key of Object.keys(attributes)) {
    if (key.startsWith("benchkit.")) {
      throw new Error(`Resource attributes must not use the 'benchkit.' prefix. Got '${key}'.`);
    }
  }
}

function buildPayload(options: ParsedArgs, now: Date = new Date()): Record<string, unknown> {
  validatePointAttributes(options.attributes);
  validateResourceAttributes(options.resourceAttributes);

  const timestampNanos = String(BigInt(now.getTime()) * 1_000_000n);
  const point = {
    timeUnixNano: timestampNanos,
    attributes: [
      buildAttribute("benchkit.scenario", options.scenario),
      buildAttribute("benchkit.series", options.series),
      buildAttribute("benchkit.metric.direction", options.direction),
      buildAttribute("benchkit.metric.role", options.role),
      ...Object.entries(options.attributes).map(([key, value]) => buildAttribute(key, value)),
    ],
    ...(Number.isSafeInteger(options.value)
      ? { asInt: String(options.value) }
      : { asDouble: options.value }),
  };

  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          buildAttribute("benchkit.run_id", options.runId),
          buildAttribute("benchkit.kind", options.kind),
          buildAttribute("benchkit.source_format", "otlp"),
          ...(process.env.GITHUB_REF ? [buildAttribute("benchkit.ref", process.env.GITHUB_REF)] : []),
          ...(process.env.GITHUB_SHA ? [buildAttribute("benchkit.commit", process.env.GITHUB_SHA)] : []),
          ...(process.env.GITHUB_WORKFLOW ? [buildAttribute("benchkit.workflow", process.env.GITHUB_WORKFLOW)] : []),
          ...(process.env.GITHUB_JOB ? [buildAttribute("benchkit.job", process.env.GITHUB_JOB)] : []),
          ...(process.env.GITHUB_RUN_ATTEMPT ? [buildAttribute("benchkit.run_attempt", process.env.GITHUB_RUN_ATTEMPT)] : []),
          ...(process.env.GITHUB_REPOSITORY ? [buildAttribute("service.name", process.env.GITHUB_REPOSITORY)] : []),
          ...Object.entries(options.resourceAttributes).map(([key, value]) => buildAttribute(key, value)),
        ],
      },
      scopeMetrics: [{
        scope: { name: "benchkit.emit.cli" },
        metrics: [{
          name: options.name,
          unit: options.unit || undefined,
          gauge: { dataPoints: [point] },
        }],
      }],
    }],
  };
}

async function emitToCollector(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<void> {
  const url = normalizeEndpoint(endpoint);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.ok) {
    console.log(`benchkit-emit: emitted metric to ${url}`);
    return;
  }

  const body = (await response.text()).trim();
  throw new Error(
    `Collector rejected metric emission (${response.status} ${response.statusText})${body ? `: ${body}` : "."}`,
  );
}

function writePayloadFile(outputDir: string, metricName: string, payload: Record<string, unknown>): string {
  const fileName = `emit-${sanitizeFileName(metricName)}-${Date.now()}.otlp.json`;
  const outputPath = path.join(outputDir, fileName);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return outputPath;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const payload = buildPayload(args);

  if (!args.endpoint && !args.outputDir) {
    throw new Error(
      "No endpoint or output directory available. Set --endpoint/--output or BENCHKIT_EMIT_ENDPOINT/BENCHKIT_METRICS_DIR.",
    );
  }

  if (args.endpoint) {
    try {
      await emitToCollector(args.endpoint, payload, args.timeoutMs);
      return;
    } catch (err) {
      if (!args.outputDir) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`benchkit-emit: HTTP emit failed (${message}); writing OTLP file fallback.`);
    }
  }

  if (!args.outputDir) {
    throw new Error("No output directory available for OTLP fallback file.");
  }
  const outputPath = writePayloadFile(args.outputDir, args.name, payload);
  console.log(`benchkit-emit: wrote ${outputPath}`);
}

if (require.main === module) {
  runCli().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`benchkit-emit: ${message}`);
    process.exitCode = 1;
  });
}

export const __test = {
  buildPayload,
  parseArgs,
  parseDirection,
  normalizeEndpoint,
};
