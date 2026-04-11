import type { OtlpMetricsDocument } from "./types.js";
import type { OtlpResultBenchmark, OtlpResultMetric } from "./build-otlp-result.js";
import { buildOtlpResult } from "./build-otlp-result.js";
import { inferDirection } from "./infer-direction.js";

/**
 * benchmark-action/github-action-benchmark compatible format.
 *
 * Input: [{ name, value, unit, range?, extra? }]
 *
 * Each entry becomes one benchmark with one metric called "value".
 * Direction is inferred from the unit string.
 */

export function parseBenchmarkAction(input: string): OtlpMetricsDocument {
  let entries: unknown;
  try {
    entries = JSON.parse(input);
  } catch (err) {
    throw new Error(
      `[parse-benchmark-action] Failed to parse input as JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!Array.isArray(entries)) {
    throw new Error(
      "[parse-benchmark-action] Input must be a JSON array of {name, value, unit} objects.",
    );
  }

  const benchmarks: OtlpResultBenchmark[] = entries.map((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `[parse-benchmark-action] Entry at index ${index} must be an object.`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string") {
      throw new Error(
        `[parse-benchmark-action] Entry at index ${index} must have a string 'name'.`,
      );
    }
    if (typeof e.value !== "number") {
      throw new Error(
        `[parse-benchmark-action] Entry '${e.name}' must have a numeric 'value'.`,
      );
    }
    if (typeof e.unit !== "string") {
      throw new Error(
        `[parse-benchmark-action] Entry '${e.name}' must have a string 'unit'.`,
      );
    }
    const metric: OtlpResultMetric = {
      value: e.value,
      unit: e.unit,
      direction: inferDirection(e.unit),
    };

    return {
      name: e.name,
      metrics: { value: metric },
    };
  });

  return buildOtlpResult({
    benchmarks,
    context: { sourceFormat: "benchmark-action" },
  });
}

