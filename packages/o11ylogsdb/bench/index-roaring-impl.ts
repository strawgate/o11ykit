/**
 * Minimal Roaring32 implementation for Experiment S.
 *
 * Tests Husky's design: per-chunk per-token-hash Roaring postings —
 * keyed by `hash(token) % 64K`, value is a bitmap of row indices that
 * "possibly contain" that token-hash. Storage and AND-cardinality
 * are the load-bearing operations; we don't need run containers (RLE)
 * or complex iteration patterns at chunk scale (≤2 K rows).
 *
 * Two container types:
 *   - ARRAY: sorted Uint16Array, used while cardinality ≤ 4096
 *     (≤ 8 KB, the breakeven vs the dense bitmap)
 *   - BITMAP: Uint8Array of 8 KB (65 536 bits), used at higher
 *     cardinality. We always pick the cheaper of the two when
 *     serializing.
 *
 * Serialization is a small custom layout (NOT the official CRoaring
 * spec — that adds run-container handling we don't need). Format:
 *
 *   [u16 container_count]
 *   for each container:
 *     [u16 high_key]            // top 16 bits of value
 *     [u8  type]                // 0 = ARRAY, 1 = BITMAP
 *     [u16 cardinality_minus_1]
 *     [if ARRAY:  cardinality * u16 sorted low-bits]
 *     [if BITMAP: 8192 bytes (raw bitmap)]
 *
 * Round-trip is verified on every chunk in the bench harness.
 *
 * The 32-bit value space splits into 65 536 high keys × 65 536 low
 * keys. For row indices in [0, 2 000) we always end up with exactly
 * one container (high_key = 0); the multi-container path exists for
 * future use (per-stream postings across millions of rows).
 */

const ARRAY_TO_BITMAP_THRESHOLD = 4096; // > 4096 → bitmap is smaller
const BITMAP_BYTES = 8192; // 65 536 bits / 8

type ContainerType = 0 | 1; // 0 = ARRAY, 1 = BITMAP

interface ArrayContainer {
  type: 0;
  /** Sorted, distinct u16 low bits. */
  values: Uint16Array;
  size: number;
}

interface BitmapContainer {
  type: 1;
  /** 8 KB raw bitmap. */
  bits: Uint8Array;
  size: number;
}

type Container = ArrayContainer | BitmapContainer;

function makeArrayContainer(): ArrayContainer {
  return { type: 0, values: new Uint16Array(8), size: 0 };
}

function makeBitmapContainer(): BitmapContainer {
  return { type: 1, bits: new Uint8Array(BITMAP_BYTES), size: 0 };
}

function arrayContains(c: ArrayContainer, lo: number): boolean {
  // Linear scan: at <4 096 entries this matches binary-search speed in
  // V8 due to predictable cache behavior on a small Uint16Array.
  for (let i = 0; i < c.size; i++) {
    if (c.values[i] === lo) return true;
    if ((c.values[i] ?? 0) > lo) return false;
  }
  return false;
}

function arrayInsert(c: ArrayContainer, lo: number): boolean {
  // Returns true if inserted (was not present). Maintains sort.
  let i = 0;
  while (i < c.size && (c.values[i] ?? 0) < lo) i++;
  if (i < c.size && c.values[i] === lo) return false;
  if (c.size === c.values.length) {
    const next = new Uint16Array(c.values.length * 2);
    next.set(c.values);
    c.values = next;
  }
  // shift right
  for (let j = c.size; j > i; j--) {
    c.values[j] = c.values[j - 1] ?? 0;
  }
  c.values[i] = lo;
  c.size++;
  return true;
}

function bitmapInsert(c: BitmapContainer, lo: number): boolean {
  const idx = lo >>> 3;
  const bit = 1 << (lo & 7);
  const cur = c.bits[idx] ?? 0;
  if ((cur & bit) !== 0) return false;
  c.bits[idx] = cur | bit;
  c.size++;
  return true;
}

function bitmapContains(c: BitmapContainer, lo: number): boolean {
  return ((c.bits[lo >>> 3] ?? 0) & (1 << (lo & 7))) !== 0;
}

function arrayToBitmap(c: ArrayContainer): BitmapContainer {
  const out = makeBitmapContainer();
  for (let i = 0; i < c.size; i++) {
    const v = c.values[i] ?? 0;
    out.bits[v >>> 3] = (out.bits[v >>> 3] ?? 0) | (1 << (v & 7));
  }
  out.size = c.size;
  return out;
}

/** AND cardinality between two containers. */
function andCardinality(a: Container, b: Container): number {
  if (a.type === 0 && b.type === 0) {
    // Two-pointer merge over sorted u16 arrays.
    let i = 0;
    let j = 0;
    let n = 0;
    while (i < a.size && j < b.size) {
      const av = a.values[i] ?? 0;
      const bv = b.values[j] ?? 0;
      if (av === bv) {
        n++;
        i++;
        j++;
      } else if (av < bv) i++;
      else j++;
    }
    return n;
  }
  if (a.type === 1 && b.type === 1) {
    let n = 0;
    for (let k = 0; k < BITMAP_BYTES; k++) {
      n += popcnt8((a.bits[k] ?? 0) & (b.bits[k] ?? 0));
    }
    return n;
  }
  // Array vs bitmap: probe array against bitmap.
  const arr = (a.type === 0 ? a : b) as ArrayContainer;
  const bm = (a.type === 1 ? a : b) as BitmapContainer;
  let n = 0;
  for (let i = 0; i < arr.size; i++) {
    if (bitmapContains(bm, arr.values[i] ?? 0)) n++;
  }
  return n;
}

function popcnt8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}

/**
 * Roaring bitmap over u32 values. For this experiment we only ever
 * insert u16 row indices (so a single high-key=0 container), but the
 * layout supports the full u32 space.
 */
export class Roaring32 {
  /** Map from high16 → container. */
  private containers: Map<number, Container> = new Map();

  add(value: number): void {
    const v = value >>> 0;
    const hi = (v >>> 16) & 0xffff;
    const lo = v & 0xffff;
    let c = this.containers.get(hi);
    if (!c) {
      c = makeArrayContainer();
      this.containers.set(hi, c);
    }
    if (c.type === 0) {
      arrayInsert(c, lo);
      if (c.size > ARRAY_TO_BITMAP_THRESHOLD) {
        this.containers.set(hi, arrayToBitmap(c));
      }
    } else {
      bitmapInsert(c, lo);
    }
  }

  /** Inclusive lower bound, exclusive upper bound. */
  addRange(start: number, end: number): void {
    for (let v = start; v < end; v++) this.add(v);
  }

  has(value: number): boolean {
    const v = value >>> 0;
    const hi = (v >>> 16) & 0xffff;
    const lo = v & 0xffff;
    const c = this.containers.get(hi);
    if (!c) return false;
    return c.type === 0 ? arrayContains(c, lo) : bitmapContains(c, lo);
  }

  cardinality(): number {
    let n = 0;
    for (const c of this.containers.values()) n += c.size;
    return n;
  }

  /** Return cardinality of intersection with `other`, no allocation. */
  andCardinality(other: Roaring32): number {
    let n = 0;
    for (const [hi, a] of this.containers) {
      const b = other.containers.get(hi);
      if (!b) continue;
      n += andCardinality(a, b);
    }
    return n;
  }

  /** Iterate all values (for round-trip verification). */
  toArray(): number[] {
    const out: number[] = [];
    const sortedHi = [...this.containers.keys()].sort((a, b) => a - b);
    for (const hi of sortedHi) {
      const c = this.containers.get(hi)!;
      const base = hi << 16;
      if (c.type === 0) {
        for (let i = 0; i < c.size; i++) out.push((base | (c.values[i] ?? 0)) >>> 0);
      } else {
        for (let lo = 0; lo < 65536; lo++) {
          if (bitmapContains(c, lo)) out.push((base | lo) >>> 0);
        }
      }
    }
    return out;
  }

  /** Estimated serialized size in bytes — chosen container per slot. */
  serializedSize(): number {
    let bytes = 2; // container_count
    for (const c of this.containers.values()) {
      bytes += 2 + 1 + 2; // hi + type + card-1
      const arrayBytes = c.size * 2;
      const useBitmap = arrayBytes > BITMAP_BYTES;
      bytes += useBitmap ? BITMAP_BYTES : arrayBytes;
    }
    return bytes;
  }

  serialize(): Uint8Array {
    const sortedHi = [...this.containers.keys()].sort((a, b) => a - b);
    const size = this.serializedSize();
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let off = 0;
    dv.setUint16(off, sortedHi.length, true);
    off += 2;
    for (const hi of sortedHi) {
      const c = this.containers.get(hi)!;
      const arrayBytes = c.size * 2;
      const useBitmap = arrayBytes > BITMAP_BYTES;
      dv.setUint16(off, hi, true);
      off += 2;
      dv.setUint8(off, useBitmap ? 1 : 0);
      off += 1;
      dv.setUint16(off, (c.size - 1) & 0xffff, true);
      off += 2;
      if (useBitmap) {
        // Serialize as bitmap: convert array to bitmap if needed.
        if (c.type === 0) {
          const bm = arrayToBitmap(c);
          out.set(bm.bits, off);
        } else {
          out.set(c.bits, off);
        }
        off += BITMAP_BYTES;
      } else {
        // Serialize as sorted u16 array.
        if (c.type === 0) {
          for (let i = 0; i < c.size; i++) {
            dv.setUint16(off, c.values[i] ?? 0, true);
            off += 2;
          }
        } else {
          // Bitmap with cardinality < threshold (rare; can happen if
          // user inserted then removed). Walk and emit.
          for (let lo = 0; lo < 65536; lo++) {
            if (bitmapContains(c, lo)) {
              dv.setUint16(off, lo, true);
              off += 2;
            }
          }
        }
      }
    }
    return out;
  }

  static deserialize(buf: Uint8Array): Roaring32 {
    const r = new Roaring32();
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 0;
    const containerCount = dv.getUint16(off, true);
    off += 2;
    for (let i = 0; i < containerCount; i++) {
      const hi = dv.getUint16(off, true);
      off += 2;
      const type = dv.getUint8(off) as ContainerType;
      off += 1;
      const card = dv.getUint16(off, true) + 1;
      off += 2;
      if (type === 1) {
        const bm = makeBitmapContainer();
        bm.bits.set(buf.subarray(off, off + BITMAP_BYTES));
        bm.size = card;
        r.containers.set(hi, bm);
        off += BITMAP_BYTES;
      } else {
        const ac = makeArrayContainer();
        ac.values = new Uint16Array(Math.max(8, card));
        for (let j = 0; j < card; j++) {
          ac.values[j] = dv.getUint16(off, true);
          off += 2;
        }
        ac.size = card;
        r.containers.set(hi, ac);
      }
    }
    return r;
  }
}

// ---------- token / n-gram extraction ----------

function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Yield each alphanumeric token in `line` (stable order, with dups). */
export function* eachToken(line: string): Generator<string> {
  let i = 0;
  while (i < line.length) {
    while (i < line.length && !isAlnum(line.charCodeAt(i))) i++;
    const start = i;
    while (i < line.length && isAlnum(line.charCodeAt(i))) i++;
    if (i > start) yield line.slice(start, i);
  }
}

/** Yield each n-gram in `s`. Short strings emit themselves. */
export function* eachNGram(s: string, n: number): Generator<string> {
  if (s.length < n) {
    yield s;
    return;
  }
  for (let i = 0; i <= s.length - n; i++) yield s.slice(i, i + n);
}

// ---------- 32-bit hash for token / gram → bucket ----------

/**
 * FNV-1a-like 32-bit string hash, bucketed to [0, modulus). Suitable
 * for picking a posting bucket; we don't need cryptographic strength.
 */
export function hashStr32(s: string, modulus: number): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = h ^ (s.charCodeAt(i) & 0xff);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // xor-shift finalizer for better avalanche on short inputs.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h % modulus;
}

// ---------- per-chunk postings index ----------

export interface PostingsIndex {
  /** bucket → bitmap of row indices */
  buckets: Map<number, Roaring32>;
  /** number of buckets in [0, modulus) */
  modulus: number;
}

/**
 * Build a per-chunk postings index by extracting items from each row
 * via `extract`. `extract(rowIdx, line)` is called once per row and
 * yields the strings to bucket-and-post.
 */
export function buildPostings(
  lines: string[],
  modulus: number,
  extract: (line: string) => Iterable<string>
): PostingsIndex {
  const buckets = new Map<number, Roaring32>();
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row] ?? "";
    const seen = new Set<number>(); // dedupe per row
    for (const item of extract(line)) {
      const b = hashStr32(item, modulus);
      if (seen.has(b)) continue;
      seen.add(b);
      let r = buckets.get(b);
      if (!r) {
        r = new Roaring32();
        buckets.set(b, r);
      }
      r.add(row);
    }
  }
  return { buckets, modulus };
}

/**
 * Serialize a postings index to bytes. Layout:
 *   [u32 bucket_count]
 *   for each bucket: [u32 bucket_id] [u32 byte_len] [byte_len bytes]
 */
export function serializePostings(idx: PostingsIndex): Uint8Array {
  const sortedBuckets = [...idx.buckets.keys()].sort((a, b) => a - b);
  const serialized: Array<{ b: number; bytes: Uint8Array }> = [];
  let total = 4; // bucket_count
  for (const b of sortedBuckets) {
    const bytes = idx.buckets.get(b)!.serialize();
    serialized.push({ b, bytes });
    total += 4 + 4 + bytes.length;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  dv.setUint32(off, sortedBuckets.length, true);
  off += 4;
  for (const { b, bytes } of serialized) {
    dv.setUint32(off, b, true);
    off += 4;
    dv.setUint32(off, bytes.length, true);
    off += 4;
    out.set(bytes, off);
    off += bytes.length;
  }
  return out;
}

/**
 * Resolve a query to the union of row indices that "possibly contain"
 * the query. For an n-gram postings index, this AND-intersects the
 * row sets of every gram in the query. For a token postings index,
 * AND-intersects every whole-token in the query.
 *
 * Returns null if any required bucket is missing (definitely-absent).
 */
export function lookupAnd(
  idx: PostingsIndex,
  parts: string[],
  rowCount: number
): Set<number> | null {
  if (parts.length === 0) {
    const all = new Set<number>();
    for (let i = 0; i < rowCount; i++) all.add(i);
    return all;
  }
  // First part seeds the candidate set; subsequent parts intersect.
  let candidate: Set<number> | null = null;
  for (const p of parts) {
    const b = hashStr32(p, idx.modulus);
    const r = idx.buckets.get(b);
    if (!r) return null; // bucket empty → query definitely absent
    const rows = new Set(r.toArray());
    if (candidate === null) {
      candidate = rows;
    } else {
      const next = new Set<number>();
      for (const v of candidate) if (rows.has(v)) next.add(v);
      candidate = next;
      if (candidate.size === 0) return candidate;
    }
  }
  return candidate;
}
