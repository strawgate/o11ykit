/**
 * OTel Collector config generation.
 *
 * Produces a collector YAML config string from simple action inputs.
 * We build a plain JS object and serialize it with a minimal YAML emitter
 * (no library needed — the shape is fixed and shallow).
 */

export interface CollectorConfigOptions {
  /** Host metrics scrape interval, e.g. "1s", "250ms". */
  scrapeInterval: string;
  /** Which hostmetrics scrapers to enable. */
  metricSets: string[];
  /** OTLP gRPC port. 0 to disable. */
  otlpGrpcPort: number;
  /** OTLP HTTP port. 0 to disable. */
  otlpHttpPort: number;
  /** File path for the file exporter output. */
  outputPath: string;
  /** Benchkit run ID injected as a resource attribute. */
  runId: string;
  /** Git ref (e.g. refs/heads/main). */
  ref?: string;
  /** Commit SHA. */
  commit?: string;
  /** Additional custom resource attributes (non-benchkit namespace). */
  resourceAttributes?: Record<string, string | number | boolean>;
  /** When true, set process scraper to mute all process-level scraper errors. */
  muteProcessAllErrors?: boolean;
}

type ResourceAttributeValue = string | number | boolean;

const VALID_METRIC_SETS = new Set([
  "cpu",
  "memory",
  "load",
  "process",
  "disk",
  "network",
  "filesystem",
  "paging",
]);

/**
 * Validate and normalize metric set names.
 * Throws on unknown names.
 */
export function validateMetricSets(raw: string[]): string[] {
  const sets = raw.map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const name of sets) {
    if (!VALID_METRIC_SETS.has(name)) {
      throw new Error(
        `Unknown metric set '${name}'. Valid sets: ${[...VALID_METRIC_SETS].join(", ")}`,
      );
    }
  }
  return sets;
}

/** Escape a string for safe inclusion in a YAML double-quoted value. */
function yamlEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
}

function resourceAttributes(opts: CollectorConfigOptions): Array<{
  key: string;
  value: string;
  action: string;
}> {
  const attrs: Array<{ key: string; value: string; action: string }> = [
    { key: "benchkit.run_id", value: opts.runId, action: "upsert" },
    { key: "benchkit.kind", value: "hybrid", action: "upsert" },
    { key: "benchkit.source_format", value: "otlp", action: "upsert" },
  ];
  if (opts.ref) {
    attrs.push({ key: "benchkit.ref", value: opts.ref, action: "upsert" });
  }
  if (opts.commit) {
    attrs.push({ key: "benchkit.commit", value: opts.commit, action: "upsert" });
  }
  for (const [key, value] of Object.entries(opts.resourceAttributes ?? {})) {
    attrs.push({ key, value: String(value), action: "upsert" });
  }
  return attrs;
}

export function parseResourceAttributes(raw: string): Record<string, ResourceAttributeValue> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("resource-attributes JSON must be an object.");
    }
    const result: Record<string, ResourceAttributeValue> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.trim()) {
        throw new Error("resource-attributes keys must not be empty.");
      }
      if (
        typeof value !== "string"
        && typeof value !== "number"
        && typeof value !== "boolean"
      ) {
        throw new Error(
          `resource-attributes '${key}' must be a string, number, or boolean.`,
        );
      }
      if (key.startsWith("benchkit.")) {
        throw new Error(
          `resource-attributes must not use the 'benchkit.' prefix. Got '${key}'.`,
        );
      }
      result[key] = value;
    }
    return result;
  }

  const result: Record<string, ResourceAttributeValue> = {};
  const entries = trimmed
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(
        `resource-attributes entry '${entry}' must use key=value format.`,
      );
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!key) {
      throw new Error("resource-attributes keys must not be empty.");
    }
    if (key.startsWith("benchkit.")) {
      throw new Error(
        `resource-attributes must not use the 'benchkit.' prefix. Got '${key}'.`,
      );
    }
    result[key] = value;
  }

  return result;
}

export function mergeResourceAttributesInputs(
  explicitInput: string,
  envInput: string | undefined,
): Record<string, ResourceAttributeValue> {
  const envAttributes = parseResourceAttributes(envInput ?? "");
  const explicitAttributes = parseResourceAttributes(explicitInput);
  return {
    ...envAttributes,
    ...explicitAttributes,
  };
}

/** Validate that a scrape interval looks like a valid Go duration. */
export function validateScrapeInterval(interval: string): string {
  if (!/^\d+(ms|s|m|h)$/.test(interval)) {
    throw new Error(
      `Invalid scrape interval '${interval}'. Expected format: <number><unit> where unit is ms, s, m, or h.`,
    );
  }
  return interval;
}

/**
 * Generate a complete OTel Collector config YAML from action inputs.
 */
export function generateCollectorConfig(opts: CollectorConfigOptions): string {
  const receiverNames: string[] = [];
  const interval = validateScrapeInterval(opts.scrapeInterval);
  const lines: string[] = [
    "# Auto-generated by benchkit/monitor — do not edit.",
    "",
    "receivers:",
  ];

  // hostmetrics receiver
  if (opts.metricSets.length > 0) {
    receiverNames.push("hostmetrics");
    lines.push("  hostmetrics:");
    lines.push("    initial_delay: 0s");
    lines.push(`    collection_interval: ${interval}`);
    lines.push("    scrapers:");
    for (const set of opts.metricSets) {
      if (set === "process") {
        lines.push("      process:");
        lines.push("        mute_process_name_error: true");
        lines.push("        mute_process_exe_error: true");
        lines.push("        mute_process_io_error: true");
        if (opts.muteProcessAllErrors) {
          lines.push("        mute_process_all_errors: true");
        }
      } else {
        lines.push(`      ${set}: {}`);
      }
    }
  }

  // otlp receiver
  if (opts.otlpGrpcPort > 0 || opts.otlpHttpPort > 0) {
    receiverNames.push("otlp");
    lines.push("  otlp:");
    lines.push("    protocols:");
    if (opts.otlpGrpcPort > 0) {
      lines.push("      grpc:");
      lines.push(`        endpoint: "127.0.0.1:${opts.otlpGrpcPort}"`);
    }
    if (opts.otlpHttpPort > 0) {
      lines.push("      http:");
      lines.push(`        endpoint: "127.0.0.1:${opts.otlpHttpPort}"`);
    }
  }

  if (receiverNames.length === 0) {
    throw new Error(
      "No receivers enabled. Enable at least one metric set or OTLP port.",
    );
  }

  // processors — stamp resource attributes for benchkit semantic conventions
  const processorNames: string[] = [];

  lines.push("");
  lines.push("processors:");
  lines.push("  resource:");
  lines.push("    attributes:");
  for (const attr of resourceAttributes(opts)) {
    lines.push(`      - key: ${attr.key}`);
    lines.push(`        value: "${yamlEscape(attr.value)}"`);
    lines.push(`        action: ${attr.action}`);
  }
  processorNames.push("resource");

  // exporters
  lines.push("");
  lines.push("exporters:");
  lines.push("  file:");
  lines.push(`    path: "${yamlEscape(opts.outputPath)}"`);

  // service pipeline
  lines.push("");
  lines.push("service:");
  lines.push("  pipelines:");
  lines.push("    metrics:");
  lines.push(`      receivers: [${receiverNames.join(", ")}]`);
  lines.push(`      processors: [${processorNames.join(", ")}]`);
  lines.push("      exporters: [file]");
  lines.push("");

  return lines.join("\n");
}
