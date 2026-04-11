export const DEFAULT_PUSH_RETRY_COUNT = 5;
export const RETRY_DELAY_MIN_MS = 500;
export const RETRY_DELAY_MAX_MS = 3000;

export function computeRetryDelayMs(
  randomValue: number,
  minMs = RETRY_DELAY_MIN_MS,
  maxMs = RETRY_DELAY_MAX_MS,
): number {
  const normalized = Math.min(1, Math.max(0, randomValue));
  return Math.round(minMs + normalized * (maxMs - minMs));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
