/**
 * Shared utility functions used across o11ykit engines.
 */

// Pre-built byte→hex lookup table. Faster than per-byte toString(16).
const hexLookup: string[] = (() => {
  const hex = "0123456789abcdef";
  const out = new Array<string>(256);
  for (let b = 0; b < 256; b++) {
    out[b] = (hex[b >> 4] as string) + (hex[b & 0xf] as string);
  }
  return out;
})();

/** Convert a Uint8Array to a lowercase hex string. */
export function bytesToHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) out += hexLookup[buf[i] as number];
  return out;
}

/** Format 16 bytes as canonical lowercase UUID — 8-4-4-4-12. */
export function bytesToUuid(b: Uint8Array): string {
  return (
    hexLookup[b[0] as number]! +
    hexLookup[b[1] as number]! +
    hexLookup[b[2] as number]! +
    hexLookup[b[3] as number]! +
    "-" +
    hexLookup[b[4] as number]! +
    hexLookup[b[5] as number]! +
    "-" +
    hexLookup[b[6] as number]! +
    hexLookup[b[7] as number]! +
    "-" +
    hexLookup[b[8] as number]! +
    hexLookup[b[9] as number]! +
    "-" +
    hexLookup[b[10] as number]! +
    hexLookup[b[11] as number]! +
    hexLookup[b[12] as number]! +
    hexLookup[b[13] as number]! +
    hexLookup[b[14] as number]! +
    hexLookup[b[15] as number]!
  );
}

function hexNibble(ch: number): number {
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
  if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10;
  if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10;
  return 0;
}

/** Parse a UUID string (with or without dashes) into 16 bytes. */
export function uuidToBytes(s: string): Uint8Array {
  const out = new Uint8Array(16);
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x2d) continue; // dash
    const hi = hexNibble(ch);
    i++;
    const lo = hexNibble(s.charCodeAt(i));
    out[cur++] = (hi << 4) | lo;
  }
  return out;
}

/** Convert a hex string to a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const len = hex.length >>> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const hi = hexNibble(hex.charCodeAt(i * 2));
    const lo = hexNibble(hex.charCodeAt(i * 2 + 1));
    out[i] = (hi << 4) | lo;
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

/**
 * FNV-1a 32-bit hash over a byte array.
 * Used by interners, bloom filters, and hash tables across all engines.
 */
export function fnv1aBytes(input: Uint8Array): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input[i] as number;
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}

/** Compare two byte arrays for equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Half-open time-range overlap check for chunk pruning.
 * Returns true if the chunk time range [chunkMin, chunkMax] overlaps
 * the query window [queryFrom, queryTo).
 */
export function timeRangeOverlaps(
  chunkMin: bigint,
  chunkMax: bigint,
  queryFrom: bigint | undefined,
  queryTo: bigint | undefined
): boolean {
  if (queryFrom !== undefined && chunkMax < queryFrom) return false;
  if (queryTo !== undefined && chunkMin >= queryTo) return false;
  return true;
}
