import type { OtlpMetricsDocument } from "./types.js";
import { parseGoBench } from "./parse-go.js";
import { parseRustBench } from "./parse-rust.js";
import { parseBenchmarkAction } from "./parse-benchmark-action.js";
import { parseHyperfine } from "./parse-hyperfine.js";
import { parsePytestBenchmark } from "./parse-pytest-benchmark.js";
import { parseOtlp } from "./parse-otlp.js";

export type Format = "go" | "benchmark-action" | "rust" | "hyperfine" | "pytest-benchmark" | "otlp" | "auto";

/**
 * Detect the input format and parse into an OtlpMetricsDocument.
 */
export function parseBenchmarks(input: string, format: Format = "auto"): OtlpMetricsDocument {
  if (format === "auto") {
    format = detectFormat(input);
  }

  switch (format) {
    case "go":
      return parseGoBench(input);
    case "rust":
      return parseRustBench(input);
    case "benchmark-action":
      return parseBenchmarkAction(input);
    case "hyperfine":
      return parseHyperfine(input);
    case "pytest-benchmark":
      return parsePytestBenchmark(input);
    case "otlp":
      return parseOtlp(input);
    default:
      throw new Error(`[parseBenchmarks] Unknown format: ${format}`);
  }
}

/**
 * Auto-detect format from content.
 *
 * - If it parses as JSON with a "benchmarks" key and entries with "stats" → pytest-benchmark
 * - If it parses as JSON with a "resourceMetrics" key → otlp
 * - If it parses as JSON with a "results" key containing objects with "command" → hyperfine
 * - If it parses as a JSON array of objects with "name"/"value"/"unit" → benchmark-action
 * - If it contains lines matching "Benchmark...\s+\d+" → go
 * - Otherwise → error
 */
function detectFormat(input: string): Exclude<Format, "auto"> {
  const trimmed = input.trim();

  // Try JSON first
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);

      if (parsed.benchmarks && Array.isArray(parsed.benchmarks)) {
        if (
          parsed.benchmarks.length > 0 &&
          parsed.benchmarks[0].stats &&
          typeof parsed.benchmarks[0].stats === "object"
        ) {
          return "pytest-benchmark";
        }
      }

      if (parsed.resourceMetrics && Array.isArray(parsed.resourceMetrics)) {
        return "otlp";
      }

      if (
        parsed.results &&
        Array.isArray(parsed.results) &&
        parsed.results.length > 0 &&
        typeof parsed.results[0].command === "string"
      ) {
        return "hyperfine";
      }

      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        typeof parsed[0].name === "string" &&
        typeof parsed[0].value === "number"
      ) {
        return "benchmark-action";
      }
    } catch {
      // Not valid JSON, fall through
    }
  }

  // Check for Go benchmark lines
  if (/^Benchmark\w.*\s+\d+\s+[\d.]+\s+\w+\/\w+/m.test(trimmed)) {
    return "go";
  }

  // Check for Rust benchmark lines
  if (/^test\s+\S+\s+\.\.\.\s+bench:/m.test(trimmed)) {
    return "rust";
  }

  throw new Error(
    "[parseBenchmarks] Could not auto-detect format. Use the 'format' option to specify one of: go, rust, benchmark-action, hyperfine, pytest-benchmark, otlp.",
  );
}
