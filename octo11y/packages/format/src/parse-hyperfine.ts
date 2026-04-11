import type { OtlpMetricsDocument } from "./types.js";
import type { OtlpResultBenchmark, OtlpResultMetric } from "./build-otlp-result.js";
import { buildOtlpResult } from "./build-otlp-result.js";
import { inferDirection } from "./infer-direction.js";

/**
 * Parse Hyperfine JSON output into an OtlpMetricsDocument.
 *
 * Input format (hyperfine --export-json):
 * {
 *   "results": [
 *     {
 *       "command": "sort input.txt",
 *       "mean": 0.123,
 *       "stddev": 0.005,
 *       "median": 0.121,
 *       "min": 0.115,
 *       "max": 0.135,
 *       "times": [0.121, 0.123, ...]
 *     }
 *   ]
 * }
 */

interface HyperfineResult {
  command: string;
  mean: number;
  stddev: number;
  median: number;
  min: number;
  max: number;
  times?: number[];
}

export function parseHyperfine(input: string): OtlpMetricsDocument {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new Error(
      `[parse-hyperfine] Failed to parse input as JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!parsed.results || !Array.isArray(parsed.results)) {
    throw new Error("[parse-hyperfine] Hyperfine format must have a 'results' array.");
  }

  const benchmarks: OtlpResultBenchmark[] = (parsed.results as HyperfineResult[]).map(
    (result) => {
      if (typeof result.command !== "string") {
        throw new Error("[parse-hyperfine] Each Hyperfine result must have a 'command' string.");
      }

      const timeDirection = inferDirection("s");
      const metrics: Record<string, OtlpResultMetric> = {
        mean: {
          value: result.mean,
          unit: "s",
          direction: timeDirection,
        },
        stddev: {
          value: result.stddev,
          unit: "s",
          direction: timeDirection,
        },
        median: {
          value: result.median,
          unit: "s",
          direction: timeDirection,
        },
        min: {
          value: result.min,
          unit: "s",
          direction: timeDirection,
        },
        max: {
          value: result.max,
          unit: "s",
          direction: timeDirection,
        },
      };

      return {
        name: result.command,
        metrics,
      };
    },
  );

  return buildOtlpResult({
    benchmarks,
    context: { sourceFormat: "hyperfine" },
  });
}
