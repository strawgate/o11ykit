import type { OtlpMetricsDocument } from "./types.js";
import type { OtlpResultBenchmark, OtlpResultMetric } from "./build-otlp-result.js";
import { buildOtlpResult } from "./build-otlp-result.js";
import { inferDirection } from "./infer-direction.js";

/**
 * Parse pytest-benchmark JSON output into an OtlpMetricsDocument.
 *
 * Input format (pytest-benchmark --benchmark-json):
 * {
 *   "benchmarks": [
 *     {
 *       "name": "test_sort",
 *       "fullname": "tests/test_perf.py::test_sort",
 *       "stats": {
 *         "min": 0.000123,
 *         "max": 0.000156,
 *         "mean": 0.000134,
 *         "stddev": 0.0000089,
 *         "rounds": 1000,
 *         "median": 0.000132,
 *         "ops": 7462.68
 *       }
 *     }
 *   ]
 * }
 */

interface PytestBenchmarkStats {
  min: number;
  max: number;
  mean: number;
  stddev: number;
  rounds: number;
  median: number;
  ops: number;
}

interface PytestBenchmarkEntry {
  name: string;
  fullname?: string;
  stats: PytestBenchmarkStats;
}

interface PytestBenchmarkOutput {
  benchmarks: PytestBenchmarkEntry[];
}

export function parsePytestBenchmark(input: string): OtlpMetricsDocument {
  let parsed;
  try {
    parsed = JSON.parse(input) as PytestBenchmarkOutput;
  } catch (err) {
    throw new Error(
      `[parse-pytest-benchmark] Failed to parse input as JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!parsed.benchmarks || !Array.isArray(parsed.benchmarks)) {
    throw new Error("[parse-pytest-benchmark] pytest-benchmark format must have a 'benchmarks' array.");
  }

  const benchmarks: OtlpResultBenchmark[] = parsed.benchmarks.map((entry) => {
    if (typeof entry.name !== "string") {
      throw new Error("[parse-pytest-benchmark] Each pytest-benchmark entry must have a 'name' string.");
    }
    if (!entry.stats || typeof entry.stats !== "object") {
      throw new Error(
        `[parse-pytest-benchmark] pytest-benchmark entry '${entry.name}' must have a 'stats' object.`,
      );
    }

    const stats = entry.stats;
    const timeDirection = inferDirection("s");
    const metrics: Record<string, OtlpResultMetric> = {
      mean: {
        value: stats.mean,
        unit: "s",
        direction: timeDirection,
      },
      median: {
        value: stats.median,
        unit: "s",
        direction: timeDirection,
      },
      min: {
        value: stats.min,
        unit: "s",
        direction: timeDirection,
      },
      max: {
        value: stats.max,
        unit: "s",
        direction: timeDirection,
      },
      stddev: {
        value: stats.stddev,
        unit: "s",
        direction: timeDirection,
      },
      ops: {
        value: stats.ops,
        unit: "ops/s",
        direction: inferDirection("ops/s"),
      },
      rounds: {
        value: stats.rounds,
        direction: "bigger_is_better",
      },
    };

    return {
      name: entry.name,
      metrics,
    };
  });

  return buildOtlpResult({
    benchmarks,
    context: { sourceFormat: "pytest-benchmark" },
  });
}
