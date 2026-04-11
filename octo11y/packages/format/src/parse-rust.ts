import type { OtlpMetricsDocument } from "./types.js";
import type { OtlpResultBenchmark, OtlpResultMetric } from "./build-otlp-result.js";
import { buildOtlpResult } from "./build-otlp-result.js";
import { unitToMetricName } from "./parser-utils.js";

/**
 * Parse Rust cargo bench (libtest) output into an OtlpMetricsDocument.
 *
 * Example:
 *   test sort::bench_sort   ... bench:         320 ns/iter (+/- 42)
 */
export function parseRustBench(input: string): OtlpMetricsDocument {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("[parse-rust] Input must be a non-empty string.");
  }

  try {
    const benchmarks: OtlpResultBenchmark[] = [];

    const re =
      /^test\s+(?<name>\S+)\s+\.\.\.\s+bench:\s+(?<value>[\d,]+)\s+(?<unit>\S+)(?:\s+\(\+\/-\s+(?<range>[\d,]+)\))?/;

    for (const line of input.split(/\r?\n/)) {
      const trimmedLine = line.trim();
      const m = trimmedLine.match(re);
      if (!m?.groups) continue;

      const { name, value, unit, range: _range } = m.groups;

      const numericValue = parseFloat(value.replace(/,/g, ""));
      if (isNaN(numericValue)) {
        throw new Error(`Invalid numeric value '${value}' for benchmark '${name}'.`);
      }

      const metric: OtlpResultMetric = {
        value: numericValue,
        unit,
        direction: "smaller_is_better",
      };

      const metrics: Record<string, OtlpResultMetric> = {};
      metrics[unitToMetricName(unit)] = metric;

      benchmarks.push({
        name,
        metrics,
      });
    }

    return buildOtlpResult({
      benchmarks,
      context: { sourceFormat: "rust" },
    });
  } catch (err) {
    throw new Error(
      `[parse-rust] Failed to parse Rust benchmark output: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

