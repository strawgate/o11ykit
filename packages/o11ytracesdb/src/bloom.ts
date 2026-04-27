/**
 * BF8 — a compact bloom filter optimized for trace ID lookups.
 * Uses 7 hash functions derived from two base hashes (double hashing).
 * Target: ~10 bits/element → ~0.1% false positive rate.
 */

/**
 * Create a bloom filter for the given set of trace IDs.
 * Returns a Uint8Array bitmap that can be stored in the chunk header.
 *
 * @param traceIds — array of 16-byte trace IDs
 * @param bitsPerElement — bits per element (default 10 for ~0.1% FPR)
 */
export function createBloomFilter(traceIds: Uint8Array[], bitsPerElement = 10): Uint8Array {
  // Deduplicate trace IDs
  const unique = new Set<string>();
  const uniqueIds: Uint8Array[] = [];
  for (const id of traceIds) {
    const hex = bufToHex(id);
    if (!unique.has(hex)) {
      unique.add(hex);
      uniqueIds.push(id);
    }
  }

  const nElements = uniqueIds.length;
  if (nElements === 0) return new Uint8Array(0);

  const nBits = Math.max(8, nElements * bitsPerElement);
  const nBytes = Math.ceil(nBits / 8);
  const effectiveBits = nBytes * 8; // use full byte capacity for consistency
  const filter = new Uint8Array(nBytes);
  const k = 7; // number of hash functions

  for (const id of uniqueIds) {
    const [h1, h2] = dualHash(id);
    for (let i = 0; i < k; i++) {
      const bit = ((h1 + i * h2) >>> 0) % effectiveBits;
      const byteIdx = bit >>> 3;
      filter[byteIdx] = (filter[byteIdx] ?? 0) | (1 << (bit & 7));
    }
  }

  return filter;
}

/**
 * Test if a trace ID might be in the bloom filter.
 * Returns false if definitely not present, true if possibly present.
 */
export function bloomMayContain(filter: Uint8Array, traceId: Uint8Array): boolean {
  if (filter.length === 0) return true; // empty filter = no filtering
  const nBits = filter.length * 8;
  const k = 7;

  const [h1, h2] = dualHash(traceId);
  for (let i = 0; i < k; i++) {
    const bit = ((h1 + i * h2) >>> 0) % nBits;
    const bitmapByte = filter[bit >>> 3];
    if (bitmapByte === undefined || !(bitmapByte & (1 << (bit & 7)))) return false;
  }
  return true;
}

/**
 * Serialize a bloom filter to a base64 string (for JSON chunk header).
 */
export function bloomToBase64(filter: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < filter.length; i++) {
    binary += String.fromCharCode(filter[i] ?? 0);
  }
  return btoa(binary);
}

/**
 * Deserialize a bloom filter from base64 string.
 */
export function bloomFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const filter = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    filter[i] = binary.charCodeAt(i);
  }
  return filter;
}

// ─── Internal hash functions ────────────────────────────────────────

/** FNV-1a 32-bit hash over a byte array. */
function fnv1a32(data: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Murmur-inspired hash for the second hash function. */
function murmur32(data: Uint8Array): number {
  let h = 0x9747b28c;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i] ?? 0;
    h = Math.imul(h, 0xcc9e2d51);
    h = (h << 15) | (h >>> 17);
    h = Math.imul(h, 0x1b873593);
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Double hashing: returns two independent 32-bit hash values
 * from which k hash functions can be derived as h1 + i*h2.
 */
function dualHash(traceId: Uint8Array): [number, number] {
  return [fnv1a32(traceId), murmur32(traceId)];
}

function bufToHex(buf: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === undefined) continue;
    hex += ((b >> 4) & 0xf).toString(16) + (b & 0xf).toString(16);
  }
  return hex;
}
