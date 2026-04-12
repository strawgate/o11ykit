import type { OtlpMetricsDocument } from "./types.js";
import type { OtlpResultBenchmark } from "./build-otlp-result.js";
import { buildOtlpResult } from "./build-otlp-result.js";
import { inferDirection } from "./infer-direction.js";
import { unitToMetricName } from "./parser-utils.js";

/**
 * Parse Go benchmark text output into an OtlpMetricsDocument.
 *
 * Handles the standard format:
 *   BenchmarkName-8   N   value unit [value unit ...]
 *
 * Multiple value/unit pairs per line produce multiple metrics per benchmark.
 * The -P suffix is extracted as a "procs" tag.
 */
export function parseGoBench(input: string): OtlpMetricsDocument {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("[parse-go] Input must be a non-empty string.");
  }

  try {
    const benchmarks: OtlpResultBenchmark[] = [];

    const re = /^(?<fullName>Benchmark\S+)\s+(?<iters>\d+)\s+(?<rest>.+)$/;

    for (const line of input.split(/\r?\n/)) {
      const m = line.match(re);
      if (!m?.groups) continue;

      const { fullName, iters: _iters, rest } = m.groups;
      const procsMatch = fullName.match(/^(?<name>.+?)-(?<procs>\d+)$/);
      const name = procsMatch?.groups?.name ?? fullName;
      const procs = procsMatch?.groups?.procs;
      const tags: Record<string, string> = {};
      if (procs) tags.procs = procs;

      const pieces = rest.trim().split(/\s+/);
      const metrics: Record<string, { value: number; unit: string; direction: "bigger_is_better" | "smaller_is_better" }> = {};

      // Pieces come in (value, unit) pairs
      for (let i = 0; i + 1 < pieces.length; i += 2) {
        const value = parseFloat(pieces[i]);
        const unit = pieces[i + 1];
        if (isNaN(value)) continue;

        const metricName = unitToMetricName(unit);
        metrics[metricName] = {
          value,
          unit,
          direction: inferDirection(unit),
        };
      }

      if (Object.keys(metrics).length > 0) {
        benchmarks.push({
          name,
          tags: Object.keys(tags).length > 0 ? tags : undefined,
          metrics,
        });
      }
    }

    return buildOtlpResult({
      benchmarks,
      context: { sourceFormat: "go" },
    });
  } catch (err) {
    throw new Error(
      `[parse-go] Failed to parse Go benchmark output: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

