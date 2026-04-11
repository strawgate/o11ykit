import { buildOtlpResult } from "./build-otlp.js";
import type { Format, OtlpMetricsDocument, ParsedBenchmark, ParsedMetric } from "./types.js";

interface ParsedPayload {
  readonly benchmarks: readonly ParsedBenchmark[];
  readonly sourceFormat: Exclude<Format, "auto">;
}

function inferDirection(unit: string): ParsedMetric["direction"] {
  const normalized = unit.trim().toLowerCase();
  if (
    normalized.includes("ns/op") ||
    normalized.includes("ms/op") ||
    normalized.includes("s/op") ||
    normalized.includes("b/op") ||
    normalized.includes("allocs/op") ||
    normalized.includes("latency") ||
    normalized.includes("time")
  ) {
    return "smaller_is_better";
  }
  if (
    normalized.includes("ops/s") ||
    normalized.includes("rps") ||
    normalized.includes("throughput")
  ) {
    return "bigger_is_better";
  }
  return undefined;
}

function metricNameFromUnit(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (normalized === "ns/op") return "ns_per_op";
  if (normalized === "ms/op") return "ms_per_op";
  if (normalized === "b/op") return "bytes_per_op";
  if (normalized === "allocs/op") return "allocs_per_op";
  return normalized
    .replaceAll("/", "_per_")
    .replaceAll("%", "pct")
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

function parseGo(input: string): ParsedPayload {
  const benchmarks: ParsedBenchmark[] = [];
  const re = /^(?<fullName>Benchmark\S+)\s+(?<iters>\d+)\s+(?<rest>.+)$/;

  for (const line of input.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m?.groups) continue;
    const fullName = m.groups.fullName;
    if (!fullName) continue;
    const procsMatch = fullName.match(/^(?<name>.+?)-(?<procs>\d+)$/);
    const name = procsMatch?.groups?.name ?? fullName;
    const procs = procsMatch?.groups?.procs;
    const rest = m.groups.rest ?? "";
    const parts = rest.trim().split(/\s+/);
    const metrics: Record<string, ParsedMetric> = {};
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const value = Number.parseFloat(parts[i] ?? "");
      const unit = parts[i + 1];
      if (!Number.isFinite(value) || !unit) continue;
      const direction = inferDirection(unit);
      const metric: ParsedMetric = {
        value,
        unit,
        ...(direction ? { direction } : {}),
      };
      metrics[metricNameFromUnit(unit)] = metric;
    }
    if (Object.keys(metrics).length === 0) continue;
    const tags = procs ? { procs } : null;
    benchmarks.push({
      name,
      ...(tags ? { tags } : {}),
      metrics,
    });
  }

  return { benchmarks, sourceFormat: "go" };
}

function parseRust(input: string): ParsedPayload {
  const benchmarks: ParsedBenchmark[] = [];
  const re =
    /^test\s+(?<name>\S+)\s+\.\.\.\s+bench:\s+(?<value>[\d,]+)\s+(?<unit>\S+)(?:\s+\(\+\/-\s+(?<range>[\d,]+)\))?/;

  for (const line of input.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (!m?.groups) continue;
    const name = m.groups.name;
    const unit = m.groups.unit;
    if (!name || !unit) continue;
    const numeric = Number.parseFloat((m.groups.value ?? "").replaceAll(",", ""));
    if (!Number.isFinite(numeric)) continue;
    benchmarks.push({
      name,
      metrics: {
        [metricNameFromUnit(unit)]: {
          value: numeric,
          unit,
          direction: "smaller_is_better",
        },
      },
    });
  }

  return { benchmarks, sourceFormat: "rust" };
}

function parseHyperfine(input: string): ParsedPayload {
  const parsed = JSON.parse(input) as {
    readonly results?: readonly {
      readonly command?: string;
      readonly mean?: number;
      readonly stddev?: number;
      readonly median?: number;
      readonly min?: number;
      readonly max?: number;
    }[];
  };
  if (!Array.isArray(parsed.results)) {
    throw new Error("Hyperfine input must contain a results array.");
  }

  const benchmarks: ParsedBenchmark[] = [];
  for (const result of parsed.results) {
    if (!result.command) continue;
    benchmarks.push({
      name: result.command,
      metrics: {
        mean: { value: result.mean ?? 0, unit: "s", direction: "smaller_is_better" },
        stddev: { value: result.stddev ?? 0, unit: "s", direction: "smaller_is_better" },
        median: { value: result.median ?? 0, unit: "s", direction: "smaller_is_better" },
        min: { value: result.min ?? 0, unit: "s", direction: "smaller_is_better" },
        max: { value: result.max ?? 0, unit: "s", direction: "smaller_is_better" },
      },
    });
  }

  return { benchmarks, sourceFormat: "hyperfine" };
}

function parseBenchmarkAction(input: string): ParsedPayload {
  const entries = JSON.parse(input) as readonly {
    readonly name?: string;
    readonly value?: number;
    readonly unit?: string;
  }[];
  if (!Array.isArray(entries)) {
    throw new Error("benchmark-action input must be a JSON array.");
  }
  const benchmarks: ParsedBenchmark[] = [];
  for (const entry of entries) {
    if (!entry.name || typeof entry.value !== "number" || !entry.unit) continue;
    const direction = inferDirection(entry.unit);
    benchmarks.push({
      name: entry.name,
      metrics: {
        value: {
          value: entry.value,
          unit: entry.unit,
          ...(direction ? { direction } : {}),
        },
      },
    });
  }
  return { benchmarks, sourceFormat: "benchmark-action" };
}

function parsePytestBenchmark(input: string): ParsedPayload {
  const parsed = JSON.parse(input) as {
    readonly benchmarks?: readonly {
      readonly name?: string;
      readonly stats?: {
        readonly min?: number;
        readonly max?: number;
        readonly mean?: number;
        readonly stddev?: number;
        readonly rounds?: number;
        readonly median?: number;
        readonly ops?: number;
      };
    }[];
  };
  if (!Array.isArray(parsed.benchmarks)) {
    throw new Error("pytest-benchmark input must contain a benchmarks array.");
  }

  const benchmarks: ParsedBenchmark[] = [];
  for (const entry of parsed.benchmarks) {
    if (!entry.name || !entry.stats) continue;
    benchmarks.push({
      name: entry.name,
      metrics: {
        mean: { value: entry.stats.mean ?? 0, unit: "s", direction: "smaller_is_better" },
        median: { value: entry.stats.median ?? 0, unit: "s", direction: "smaller_is_better" },
        min: { value: entry.stats.min ?? 0, unit: "s", direction: "smaller_is_better" },
        max: { value: entry.stats.max ?? 0, unit: "s", direction: "smaller_is_better" },
        stddev: { value: entry.stats.stddev ?? 0, unit: "s", direction: "smaller_is_better" },
        ops: { value: entry.stats.ops ?? 0, unit: "ops/s", direction: "bigger_is_better" },
        rounds: { value: entry.stats.rounds ?? 0, direction: "bigger_is_better" },
      },
    });
  }

  return { benchmarks, sourceFormat: "pytest-benchmark" };
}

function parseOtlp(input: string): OtlpMetricsDocument {
  const parsed = JSON.parse(input) as Partial<OtlpMetricsDocument>;
  if (!Array.isArray(parsed.resourceMetrics)) {
    throw new Error("otlp input must include a resourceMetrics array.");
  }
  return parsed as OtlpMetricsDocument;
}

export function detectFormat(input: string): Exclude<Format, "auto"> {
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "resourceMetrics" in parsed &&
        Array.isArray((parsed as { resourceMetrics?: unknown[] }).resourceMetrics)
      ) {
        return "otlp";
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "results" in parsed &&
        Array.isArray((parsed as { results?: unknown[] }).results)
      ) {
        return "hyperfine";
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "benchmarks" in parsed &&
        Array.isArray((parsed as { benchmarks?: unknown[] }).benchmarks)
      ) {
        return "pytest-benchmark";
      }
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        typeof (parsed[0] as { name?: unknown }).name === "string"
      ) {
        return "benchmark-action";
      }
    } catch {
      // continue to text detectors
    }
  }

  if (/^Benchmark\w.*\s+\d+\s+[\d.]+\s+\w+\/\w+/m.test(trimmed)) {
    return "go";
  }
  if (/^test\s+\S+\s+\.\.\.\s+bench:/m.test(trimmed)) {
    return "rust";
  }
  throw new Error(
    "Could not auto-detect format. Set format to one of: go, rust, hyperfine, pytest-benchmark, benchmark-action, otlp."
  );
}

export function parseToOtlpDocument(
  raw: string,
  format: Format,
  context: Omit<Parameters<typeof buildOtlpResult>[1], "sourceFormat">
): OtlpMetricsDocument {
  const input = raw.replace(
    // Strip ANSI control sequences from action logs.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: log cleanup
    /\u001b\[[0-9;]*[A-Za-z]/g,
    ""
  );

  const resolved = format === "auto" ? detectFormat(input) : format;
  if (resolved === "otlp") {
    return parseOtlp(input);
  }

  const parsed =
    resolved === "go"
      ? parseGo(input)
      : resolved === "rust"
        ? parseRust(input)
        : resolved === "hyperfine"
          ? parseHyperfine(input)
          : resolved === "pytest-benchmark"
            ? parsePytestBenchmark(input)
            : parseBenchmarkAction(input);

  return buildOtlpResult(parsed.benchmarks, {
    ...context,
    sourceFormat: parsed.sourceFormat,
  });
}
