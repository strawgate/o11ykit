export function parseMinDatapoints(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min-datapoints must be a non-negative integer, got "${raw}".`);
  }
  return parsed;
}

export function enforceDatapointPolicy(options: {
  readonly dataPoints: number;
  readonly failOnZeroDatapoints: boolean;
  readonly minDatapoints: number;
}): void {
  if (options.failOnZeroDatapoints && options.dataPoints === 0) {
    throw new Error(
      "Parsed 0 datapoints and fail-on-zero-datapoints=true. " +
        "Verify format/source content or disable the guardrail."
    );
  }
  if (options.dataPoints < options.minDatapoints) {
    throw new Error(
      `Parsed ${options.dataPoints} datapoints, below min-datapoints=${options.minDatapoints}.`
    );
  }
}
