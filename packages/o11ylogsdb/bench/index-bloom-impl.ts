/**
 * Minimal Bloom filter and Binary Fuse 8 implementations in pure TS,
 * sized for the ngram-bloom bench .
 *
 * Hashing: we use a 64-bit splitmix-style mixer over Math.imul-friendly
 * 32-bit halves. BigInt is used only at the boundary for binary-fuse
 * key hashing (where the 64-bit interpretation matters); the inner
 * loops stick to 32-bit ops.
 *
 * Bloom: classic m bits, k hashes, double-hashing trick
 * (h_i(x) = h1(x) + i*h2(x)) so we only do two real hashes per insert/
 * query.
 *
 * Binary Fuse 8: follows Graf & Lemire 2022 (the
 * `xor_singleheader.h` algorithm). Segment-based; ~9 bits/key at
 * ~0.4 % FPR, immutable, peeling-based construction with retries on
 * a different seed if peeling fails.
 *
 * This file is also a starting point for `src/index-bloom.ts` — if
 * the experiment shows the cost is acceptable, M6 can promote a
 * cleaned-up version into the public `o11ylogsdb` API.
 */

// ---------- 64-bit hashing ----------

const MASK64 = (1n << 64n) - 1n;

function mix64(z: bigint): bigint {
  z = (z + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = (z ^ (z >> 31n)) & MASK64;
  return z;
}

function fingerprintOf(hash: bigint): bigint {
  return (hash ^ (hash >> 32n)) & MASK64;
}

function mixSeed(s: bigint): bigint {
  return mix64(s);
}

/**
 * Strong 64-bit mix of a string to a (hi, lo) pair. Uses splitmix64 in
 * BigInt over the string's UTF-16 code units. Slightly slower than a
 * Math.imul-only path but the avalanche behavior is essential for
 * Binary Fuse 8 peeling.
 */
function hash64HalvesSplit(s: string): { hi: number; lo: number } {
  let z = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    z = (z ^ BigInt(s.charCodeAt(i) & 0xff)) & MASK64;
    z = mix64(z);
  }
  z = mix64(z ^ BigInt(s.length));
  return {
    hi: Number(z >> 32n),
    lo: Number(z & 0xffffffffn),
  };
}

function hash64Halves(s: string): { hi: number; lo: number } {
  return hash64HalvesSplit(s);
}

// ---------- Bloom filter ----------

export class Bloom {
  readonly bits: Uint8Array;
  readonly mBits: number;
  readonly k: number;

  /**
   * @param n expected key count
   * @param bitsPerKey storage budget (~10 → ~1 % FPR for k=7)
   * @param k hash count
   */
  constructor(n: number, bitsPerKey: number, k: number) {
    const m = Math.max(8, Math.ceil(n * bitsPerKey));
    // Round to next multiple of 8 so byteLength is exact.
    const mRounded = ((m + 7) >>> 3) << 3;
    this.mBits = mRounded;
    this.k = k;
    this.bits = new Uint8Array(mRounded >>> 3);
  }

  get byteLength(): number {
    return this.bits.length;
  }

  addStr(s: string): void {
    const { hi, lo } = hash64Halves(s);
    const m = this.mBits;
    for (let i = 0; i < this.k; i++) {
      const h = (lo + Math.imul(i, hi)) >>> 0;
      const idx = h % m;
      this.bits[idx >>> 3]! |= 1 << (idx & 7);
    }
  }

  hasStr(s: string): boolean {
    const { hi, lo } = hash64Halves(s);
    const m = this.mBits;
    for (let i = 0; i < this.k; i++) {
      const h = (lo + Math.imul(i, hi)) >>> 0;
      const idx = h % m;
      if (((this.bits[idx >>> 3]! >>> (idx & 7)) & 1) === 0) return false;
    }
    return true;
  }
}

// ---------- Binary Fuse 8 ----------

/**
 * Binary Fuse 8 filter (Graf & Lemire, 2022). Static; built once from
 * a deduplicated set of 64-bit keys.
 *
 * Storage: a fingerprint table of `arrayLength` u8 entries.
 * Query: 3 lookups, AND fingerprint XORs against the key fingerprint.
 *
 * This implementation follows the public-domain `xor_singleheader.h`
 * algorithm; the constants come from §3 of the paper. It uses BigInt
 * for the 64-bit operations because correctness matters more than
 * speed in this experiment.
 */
export class BinaryFuse8 {
  readonly fingerprints: Uint8Array;
  readonly seed: bigint;
  readonly segmentLength: number;
  readonly segmentLengthMask: number;
  readonly segmentCount: number;
  readonly segmentCountLength: number;
  readonly arrayLength: number;

  private constructor(args: {
    fingerprints: Uint8Array;
    seed: bigint;
    segmentLength: number;
    segmentCount: number;
  }) {
    this.fingerprints = args.fingerprints;
    this.seed = args.seed;
    this.segmentLength = args.segmentLength;
    this.segmentLengthMask = args.segmentLength - 1;
    this.segmentCount = args.segmentCount;
    this.segmentCountLength = args.segmentCount * args.segmentLength;
    this.arrayLength = this.segmentCountLength + 2 * args.segmentLength;
  }

  get byteLength(): number {
    return this.fingerprints.length;
  }

  /** Hash a string to a 64-bit BigInt key (the binary-fuse input). */
  static hashKeyStr(s: string): bigint {
    const { hi, lo } = hash64Halves(s);
    return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  }

  static build(keysIn: BigUint64Array): BinaryFuse8 {
    const size = keysIn.length;
    if (size === 0) {
      // Degenerate: an empty filter.
      return new BinaryFuse8({
        fingerprints: new Uint8Array(0),
        seed: 0n,
        segmentLength: 1,
        segmentCount: 1,
      });
    }
    // Sizing per `xor_singleheader.h` (FUSE3 / 8-bit fingerprint variant):
    //   segmentLength = 1 << max(0, ceil(log2(size) / 3.33) + 2.25 floor'd)
    //   then: sizeFactor in [1.125, 1.5] tuned by size.
    // The exact constants matter for peeling success. Use the values the
    // reference impl picks for 1K..100K range.
    let segmentLengthLog2: number;
    if (size < 1) segmentLengthLog2 = 0;
    else if (size < 1_000)
      segmentLengthLog2 = 7; // 128
    else if (size < 10_000)
      segmentLengthLog2 = 9; // 512
    else if (size < 100_000)
      segmentLengthLog2 = 12; // 4096
    else if (size < 1_000_000)
      segmentLengthLog2 = 14; // 16384
    else segmentLengthLog2 = 17;
    const segmentLength = 1 << segmentLengthLog2;
    // Inflate capacity for small inputs; tighter as the law of large
    // numbers smooths out hash placement.
    const sizeFactor = size < 1_000 ? 2.0 : size < 10_000 ? 1.5 : size < 100_000 ? 1.3 : 1.15;
    const capacity = Math.max(
      Math.ceil(size * sizeFactor),
      // Need at least 3 segments worth of slots to make h0/h1/h2 distinct.
      3 * segmentLength
    );
    let segmentCount = Math.floor((capacity + segmentLength - 1) / segmentLength) - 2;
    if (segmentCount < 1) segmentCount = 1;
    const segmentCountLength = segmentCount * segmentLength;
    const arrayLength = segmentCountLength + 2 * segmentLength;
    const fingerprints = new Uint8Array(arrayLength);

    // Build loop: pick seed; try to peel; on failure pick a new seed.
    const segmentLengthMask = segmentLength - 1;
    const segmentCountBI = BigInt(segmentCount);

    let seed = 0xdeadbeefn;
    const reverseOrder = new BigUint64Array(size + 1);
    const reverseH = new Uint8Array(size);
    const alone = new Uint32Array(arrayLength);
    const t2count = new Uint32Array(arrayLength);
    const t2hash = new BigUint64Array(arrayLength);

    const MAX_ITER = 100;
    let success = false;
    for (let iter = 0; iter < MAX_ITER && !success; iter++) {
      seed = mixSeed(seed + BigInt(iter));
      t2count.fill(0);
      t2hash.fill(0n);
      // Insert keys.
      for (let i = 0; i < size; i++) {
        const k = keysIn[i]!;
        const hash = mix64(k + seed);
        const h0 = h0Of(hash, segmentCountBI, segmentLength, segmentLengthMask);
        const h1 = h1Of(hash, segmentLength, segmentLengthMask, h0);
        const h2 = h2Of(hash, segmentLength, segmentLengthMask, h0);
        t2count[h0] = t2count[h0]! + 4;
        t2hash[h0] = t2hash[h0]! ^ hash;
        t2count[h1] = t2count[h1]! + 4;
        t2hash[h1] = t2hash[h1]! ^ hash;
        t2count[h2] = t2count[h2]! + 4;
        t2hash[h2] = t2hash[h2]! ^ hash;
        // We use the "+4 per insertion" encoding: t2count[i] >> 2 is the
        // population count at slot i. Peeling identifies "alone" slots
        // (population == 1), reads the surviving key off t2hash, and
        // recovers the slot index via direct comparison rather than
        // bit-encoded slot tags.
      }

      // Peeling: BFS frontier of locations with t2count==4 (one key only).
      let alone_count = 0;
      for (let i = 0; i < arrayLength; i++) {
        if (t2count[i]! >> 2 === 1) alone[alone_count++] = i;
      }
      let stack_size = 0;
      while (alone_count > 0) {
        const idx = alone[--alone_count]!;
        if (t2count[idx]! >> 2 === 0) continue;
        const hash = t2hash[idx]!;
        const h0 = h0Of(hash, segmentCountBI, segmentLength, segmentLengthMask);
        const h1 = h1Of(hash, segmentLength, segmentLengthMask, h0);
        const h2 = h2Of(hash, segmentLength, segmentLengthMask, h0);
        let foundSlot = 0;
        if (h0 === idx) foundSlot = 0;
        else if (h1 === idx) foundSlot = 1;
        else foundSlot = 2;
        reverseOrder[stack_size] = hash;
        reverseH[stack_size] = foundSlot;
        stack_size++;

        // Remove from each slot.
        for (const otherIdx of [h0, h1, h2]) {
          if (otherIdx === idx) {
            t2count[idx] = t2count[idx]! - 4;
            t2hash[idx] = 0n;
            continue;
          }
          t2count[otherIdx] = t2count[otherIdx]! - 4;
          t2hash[otherIdx] = t2hash[otherIdx]! ^ hash;
          if (t2count[otherIdx]! >> 2 === 1) {
            alone[alone_count++] = otherIdx;
          }
        }
      }

      if (stack_size === size) {
        // Fill fingerprints from reverse-stack.
        fingerprints.fill(0);
        for (let i = stack_size - 1; i >= 0; i--) {
          const hash = reverseOrder[i]!;
          const xor2 = Number(fingerprintOf(hash) & 0xffn);
          const slot = reverseH[i]!;
          const h0 = h0Of(hash, segmentCountBI, segmentLength, segmentLengthMask);
          const h1 = h1Of(hash, segmentLength, segmentLengthMask, h0);
          const h2 = h2Of(hash, segmentLength, segmentLengthMask, h0);
          const target = slot === 0 ? h0 : slot === 1 ? h1 : h2;
          const a = slot === 0 ? h1 : slot === 1 ? h0 : h0;
          const b = slot === 0 ? h2 : slot === 1 ? h2 : h1;
          fingerprints[target] = (xor2 ^ fingerprints[a]! ^ fingerprints[b]!) & 0xff;
        }
        success = true;
      }
    }

    if (!success) {
      throw new Error(
        `BinaryFuse8: peeling failed for size=${size}, segLen=${segmentLength}, segCount=${segmentCount}, arrayLength=${arrayLength}`
      );
    }

    return new BinaryFuse8({
      fingerprints,
      seed,
      segmentLength,
      segmentCount,
    });
  }

  hasKey(key: bigint): boolean {
    const hash = mix64(key + this.seed);
    const fp = Number(fingerprintOf(hash) & 0xffn);
    const segmentCountBI = BigInt(this.segmentCount);
    const h0 = h0Of(hash, segmentCountBI, this.segmentLength, this.segmentLengthMask);
    const h1 = h1Of(hash, this.segmentLength, this.segmentLengthMask, h0);
    const h2 = h2Of(hash, this.segmentLength, this.segmentLengthMask, h0);
    return (fp ^ this.fingerprints[h0]! ^ this.fingerprints[h1]! ^ this.fingerprints[h2]!) === 0;
  }
}

// 64-bit helpers for binary fuse.

/**
 * h0 returns the *segment-aligned* slot for the first hash, in
 * [0, segmentCount) * segmentLength + (sub_hash & segmentLengthMask).
 * Picks a segment in [0, segmentCount) via top-32 hash, then a
 * slot within using middle bits of the hash (so h0/h1/h2 sub-offsets
 * are independent).
 */
/**
 * h0 returns the *segment-aligned* slot for the first hash:
 *   segment = (hash_hi * segmentCount) >> 32  in [0, segmentCount)
 *   slot    = segment * segmentLength + (low32(hash) & segmentLengthMask)
 * Note: ToUint32 of `Number(bigint)` is lossy for BigInts > 2^53, so we
 * mask down to 32 bits *as a BigInt* before converting.
 */
function h0Of(hash: bigint, segmentCountBI: bigint, segLen: number, segMask: number): number {
  const hi = hash >> 32n;
  const seg = Number((hi * segmentCountBI) >> 32n); // [0, segCount)
  const sub = Number(hash & 0xffffffffn);
  return (seg * segLen + (sub & segMask)) | 0;
}

function h1Of(hash: bigint, segLen: number, segMask: number, h0: number): number {
  // Different sub-offset from h0 — use a different slice of the hash.
  const h = Number((hash >> 18n) & 0xffffffffn);
  const segStart = h0 - (h0 & segMask);
  return (segStart + segLen + (h & segMask)) | 0;
}

function h2Of(hash: bigint, segLen: number, segMask: number, h0: number): number {
  const h = Number((hash >> 36n) & 0xffffffffn);
  const segStart = h0 - (h0 & segMask);
  return (segStart + 2 * segLen + (h & segMask)) | 0;
}

// ---------- gram + token extraction ----------

/** Build the set of distinct n-grams across a corpus of lines. */
export function buildNGramSet(lines: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    if (line.length < n) {
      out.add(line);
      continue;
    }
    for (let i = 0; i <= line.length - n; i++) {
      out.add(line.slice(i, i + n));
    }
  }
  return out;
}

/** Loki-style token extraction: split on non-alphanumeric. */
export function buildTokenSet(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    let i = 0;
    while (i < line.length) {
      // skip non-alnum
      while (i < line.length && !isAlnum(line.charCodeAt(i))) i++;
      const start = i;
      while (i < line.length && isAlnum(line.charCodeAt(i))) i++;
      if (i > start) out.add(line.slice(start, i));
    }
  }
  return out;
}

function isAlnum(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) // a-z
  );
}

/**
 * Test if a query string is "possibly present" under an n-gram filter:
 * AND of `has(g)` over every n-gram of the query. Short queries
 * (length < n) get a single-gram lookup of the full query.
 */
export function containsNGram(query: string, n: number, has: (g: string) => boolean): boolean {
  if (query.length < n) {
    return has(query);
  }
  for (let i = 0; i <= query.length - n; i++) {
    if (!has(query.slice(i, i + n))) return false;
  }
  return true;
}

/**
 * Test if a query is "possibly present" under a token filter. The
 * query is split on non-alphanumeric and every full token must hit.
 * Returns false (definitely-absent) only if a token is absent. If
 * the query has *no* alphanumeric run (e.g. ":[]"), we can't say —
 * return true (the calling code treats this as a fallback to scan).
 */
export function containsToken(query: string, has: (t: string) => boolean): boolean {
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    while (i < query.length && !isAlnum(query.charCodeAt(i))) i++;
    const start = i;
    while (i < query.length && isAlnum(query.charCodeAt(i))) i++;
    if (i > start) tokens.push(query.slice(start, i));
  }
  if (tokens.length === 0) return true;
  for (const t of tokens) {
    if (!has(t)) return false;
  }
  return true;
}
