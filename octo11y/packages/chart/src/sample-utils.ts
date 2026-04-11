import type { Sample } from "@benchkit/format";

/** Returns every metric key present in the sample array (all keys except `t`). */
export function extractSampleMetrics(samples: Sample[]): string[] {
  const keys = new Set<string>();
  for (const sample of samples) {
    for (const key of Object.keys(sample)) {
      if (key !== "t") keys.add(key);
    }
  }
  return [...keys];
}
