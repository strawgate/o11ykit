/**
 * Shared utility functions used across o11ykit engines.
 */

const hexLookup: string[] = [];
for (let i = 0; i < 256; i++) hexLookup[i] = i.toString(16).padStart(2, "0");

/** Convert a Uint8Array to a lowercase hex string. */
export function bytesToHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) out += hexLookup[buf[i] as number];
  return out;
}

/** Convert a hex string to a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const len = hex.length >>> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * High-resolution millisecond timer. Uses `performance.now()` when
 * available (browsers + Node), falls back to `process.hrtime.bigint()`.
 */
export function nowMillis(): number {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Number(process.hrtime.bigint()) / 1_000_000;
}
