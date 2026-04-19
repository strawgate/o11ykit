/**
 * M1: XOR-Delta Codec
 *
 * Compresses time-series data using:
 * - Timestamps: delta-of-delta encoding (int64)
 * - Values: XOR encoding with leading/trailing zero tracking (float64)
 *
 * Reference: "Gorilla: A Fast, Scalable, In-Memory Time Series Database"
 * (Pelkonen et al., VLDB 2015). Implementation follows the paper's
 * algorithm without modifications.
 *
 * 64-bit handling: All bit manipulation uses DataView for float↔bits
 * conversion and BigInt for XOR/CLZ/shift on 64-bit quantities.
 * The research prototype had a precision bug here — this implementation
 * uses BigInt throughout to avoid it.
 */

// ── Bit Writer ───────────────────────────────────────────────────────

const INITIAL_CAPACITY = 256;

export class BitWriter {
  private buf: Uint8Array;
  private bytePos: number = 0;
  private bitPos: number = 0; // bits consumed in current byte (0-7)

  constructor(capacity: number = INITIAL_CAPACITY) {
    this.buf = new Uint8Array(capacity);
  }

  /** Write a single bit (0 or 1). */
  writeBit(bit: number): void {
    if (this.bytePos >= this.buf.length) this.grow();
    if (bit) {
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
      this.buf[this.bytePos]! |= 0x80 >>> this.bitPos;
    }
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
  }

  /** Write `count` bits from the low end of `value` (BigInt). */
  writeBits(value: bigint, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.writeBit(Number((value >> BigInt(i)) & 1n));
    }
  }

  /** Write `count` bits from a regular number (for small values ≤ 32 bits). */
  writeBitsNum(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.writeBit((value >>> i) & 1);
    }
  }

  /** Return a trimmed copy of the written bytes. */
  finish(): Uint8Array {
    const len = this.bitPos > 0 ? this.bytePos + 1 : this.bytePos;
    return this.buf.slice(0, len);
  }

  /** Total bits written. */
  get bitsWritten(): number {
    return this.bytePos * 8 + this.bitPos;
  }

  private grow(): void {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
}

// ── Bit Reader ───────────────────────────────────────────────────────

export class BitReader {
  private buf: Uint8Array;
  private bytePos: number = 0;
  private bitPos: number = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  /** Read a single bit. */
  readBit(): number {
    if (this.bytePos >= this.buf.length) {
      throw new RangeError(
        `BitReader: read past end of buffer (bytePos=${this.bytePos}, length=${this.buf.length})`
      );
    }
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked above
    const byte = this.buf[this.bytePos]!;
    const bit = (byte >>> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
    return bit;
  }

  /** Read `count` bits as a BigInt. */
  readBits(count: number): bigint {
    let value = 0n;
    for (let i = 0; i < count; i++) {
      value = (value << 1n) | BigInt(this.readBit());
    }
    return value;
  }

  /** Read `count` bits as a regular number (for small values ≤ 32 bits). */
  readBitsNum(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }
}

// ── Float64 ↔ Bits (BigInt) ─────────────────────────────────────────

const f64Buf = new ArrayBuffer(8);
const f64View = new DataView(f64Buf);

function floatToBits(f: number): bigint {
  f64View.setFloat64(0, f, false); // big-endian
  const hi = f64View.getUint32(0, false);
  const lo = f64View.getUint32(4, false);
  return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
}

function bitsToFloat(bits: bigint): number {
  const hi = Number((bits >> 32n) & 0xffffffffn);
  const lo = Number(bits & 0xffffffffn);
  f64View.setUint32(0, hi, false);
  f64View.setUint32(4, lo, false);
  return f64View.getFloat64(0, false);
}

/** Count leading zeros of a 64-bit BigInt. */
function clz64(x: bigint): number {
  if (x === 0n) return 64;
  let n = 0;
  if ((x & 0xffffffff00000000n) === 0n) {
    n += 32;
    x <<= 32n;
  }
  if ((x & 0xffff000000000000n) === 0n) {
    n += 16;
    x <<= 16n;
  }
  if ((x & 0xff00000000000000n) === 0n) {
    n += 8;
    x <<= 8n;
  }
  if ((x & 0xf000000000000000n) === 0n) {
    n += 4;
    x <<= 4n;
  }
  if ((x & 0xc000000000000000n) === 0n) {
    n += 2;
    x <<= 2n;
  }
  if ((x & 0x8000000000000000n) === 0n) {
    n += 1;
  }
  return n;
}

/** Count trailing zeros of a 64-bit BigInt. */
function ctz64(x: bigint): number {
  if (x === 0n) return 64;
  let n = 0;
  if ((x & 0xffffffffn) === 0n) {
    n += 32;
    x >>= 32n;
  }
  if ((x & 0xffffn) === 0n) {
    n += 16;
    x >>= 16n;
  }
  if ((x & 0xffn) === 0n) {
    n += 8;
    x >>= 8n;
  }
  if ((x & 0xfn) === 0n) {
    n += 4;
    x >>= 4n;
  }
  if ((x & 0x3n) === 0n) {
    n += 2;
    x >>= 2n;
  }
  if ((x & 0x1n) === 0n) {
    n += 1;
  }
  return n;
}

// ── Encoder ──────────────────────────────────────────────────────────

/**
 * Encode a chunk of time-series data.
 *
 * Format:
 *   Header:
 *     - 16 bits: sample count (max 65535)
 *     - 64 bits: first timestamp (big-endian)
 *     - 64 bits: first value as float64 bits (big-endian)
 *
 *   For each subsequent sample:
 *     Timestamp (delta-of-delta):
 *       - If DoD == 0:       write '0'
 *       - If DoD in [-63, 64]:   write '10' + 7 bits (zigzag)
 *       - If DoD in [-255, 256]:  write '110' + 9 bits (zigzag)
 *       - If DoD in [-2047, 2048]: write '1110' + 12 bits (zigzag)
 *       - Otherwise:         write '1111' + 64 bits (raw)
 *
 *     Value (XOR with previous):
 *       - If XOR == 0:       write '0'
 *       - If leading >= prevLeading && trailing >= prevTrailing:
 *                            write '10' + meaningful bits
 *       - Otherwise:         write '11' + 6 bits leading + 6 bits
 *                            meaningful-length + meaningful bits
 */
export function encodeChunk(timestamps: BigInt64Array, values: Float64Array): Uint8Array {
  const n = timestamps.length;
  if (n === 0) return new Uint8Array(0);
  if (n > 65535) throw new RangeError("Chunk exceeds 65535 samples");
  if (timestamps.length !== values.length) {
    throw new RangeError("timestamps and values must have the same length");
  }

  const w = new BitWriter(n * 2); // rough estimate

  // Header: count + first sample.
  w.writeBitsNum(n, 16);
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  w.writeBits(BigInt(timestamps[0]!) & 0xffffffffffffffffn, 64);
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  w.writeBits(floatToBits(values[0]!), 64);

  if (n === 1) return w.finish();

  // State for delta-of-delta timestamps.
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  let prevTs = timestamps[0]!;
  let prevDelta = 0n;

  // State for XOR values.
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  let prevValBits = floatToBits(values[0]!);
  let prevLeading = 64; // force full write on first XOR
  let prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const ts = timestamps[i]!;
    const delta = ts - prevTs;
    const dod = delta - prevDelta;

    // ── Timestamp: delta-of-delta ──
    if (dod === 0n) {
      w.writeBit(0);
    } else {
      // Zigzag encode for signed values.
      const absDod = dod < 0n ? -dod : dod;
      if (absDod <= 64n) {
        w.writeBit(1);
        w.writeBit(0);
        // 7-bit zigzag: (dod << 1) ^ (dod >> 63)
        const zz = Number((dod << 1n) ^ (dod >> 63n)) & 0x7f;
        w.writeBitsNum(zz, 7);
      } else if (absDod <= 256n) {
        w.writeBit(1);
        w.writeBit(1);
        w.writeBit(0);
        const zz = Number((dod << 1n) ^ (dod >> 63n)) & 0x1ff;
        w.writeBitsNum(zz, 9);
      } else if (absDod <= 2048n) {
        w.writeBit(1);
        w.writeBit(1);
        w.writeBit(1);
        w.writeBit(0);
        const zz = Number((dod << 1n) ^ (dod >> 63n)) & 0xfff;
        w.writeBitsNum(zz, 12);
      } else {
        w.writeBit(1);
        w.writeBit(1);
        w.writeBit(1);
        w.writeBit(1);
        // Raw 64-bit BigInt.
        w.writeBits(BigInt.asUintN(64, dod), 64);
      }
    }

    prevDelta = delta;
    prevTs = ts;

    // ── Value: XOR encoding ──
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
    const valBits = floatToBits(values[i]!);
    const xor = prevValBits ^ valBits;

    if (xor === 0n) {
      w.writeBit(0);
    } else {
      const leading = clz64(xor);
      const trailing = ctz64(xor);
      const meaningful = 64 - leading - trailing;

      if (leading >= prevLeading && trailing >= prevTrailing) {
        // Reuse previous window.
        w.writeBit(1);
        w.writeBit(0);
        const prevMeaningful = 64 - prevLeading - prevTrailing;
        const shifted = xor >> BigInt(prevTrailing);
        w.writeBits(shifted, prevMeaningful);
      } else {
        // New window.
        w.writeBit(1);
        w.writeBit(1);
        w.writeBitsNum(leading, 6);
        // meaningful length: 0 means 64 (can't have 0 meaningful bits
        // when xor != 0), so store (meaningful - 1) in 6 bits.
        w.writeBitsNum(meaningful - 1, 6);
        const shifted = xor >> BigInt(trailing);
        w.writeBits(shifted, meaningful);
        prevLeading = leading;
        prevTrailing = trailing;
      }
    }

    prevValBits = valBits;
  }

  return w.finish();
}

// ── Decoder ──────────────────────────────────────────────────────────

export interface DecodedChunk {
  timestamps: BigInt64Array;
  values: Float64Array;
}

/**
 * Decode a compressed chunk back to timestamps + values.
 */
export function decodeChunk(buf: Uint8Array): DecodedChunk {
  if (buf.length === 0) {
    return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  }

  const r = new BitReader(buf);

  const n = r.readBitsNum(16);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);

  // First sample.
  timestamps[0] = BigInt.asIntN(64, r.readBits(64));
  values[0] = bitsToFloat(r.readBits(64));

  if (n === 1) return { timestamps, values };

  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  let prevTs = timestamps[0]!;
  let prevDelta = 0n;
  // biome-ignore lint/style/noNonNullAssertion: bounds-checked by construction
  let prevValBits = floatToBits(values[0]!);
  let prevLeading = 0;
  let prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    // ── Timestamp: delta-of-delta ──
    let dod: bigint;
    if (r.readBit() === 0) {
      dod = 0n;
      // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
    } else if (r.readBit() === 0) {
      // 7-bit zigzag
      const zz = r.readBitsNum(7);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
      // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
    } else if (r.readBit() === 0) {
      // 9-bit zigzag
      const zz = r.readBitsNum(9);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
      // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
    } else if (r.readBit() === 0) {
      // 12-bit zigzag
      const zz = r.readBitsNum(12);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
    } else {
      // Raw 64 bits.
      dod = BigInt.asIntN(64, r.readBits(64));
    }

    const delta = prevDelta + dod;
    const ts = prevTs + delta;
    timestamps[i] = ts;
    prevDelta = delta;
    prevTs = ts;

    // ── Value: XOR decoding ──
    if (r.readBit() === 0) {
      // Same as previous.
      values[i] = bitsToFloat(prevValBits);
      // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
    } else if (r.readBit() === 0) {
      // Reuse previous leading/trailing window.
      const meaningful = 64 - prevLeading - prevTrailing;
      const shifted = r.readBits(meaningful);
      const xor = shifted << BigInt(prevTrailing);
      prevValBits = prevValBits ^ xor;
      values[i] = bitsToFloat(prevValBits);
    } else {
      // New window.
      const leading = r.readBitsNum(6);
      const meaningfulMinus1 = r.readBitsNum(6);
      const meaningful = meaningfulMinus1 + 1;
      const trailing = 64 - leading - meaningful;
      const shifted = r.readBits(meaningful);
      const xor = shifted << BigInt(trailing);
      prevValBits = prevValBits ^ xor;
      values[i] = bitsToFloat(prevValBits);
      prevLeading = leading;
      prevTrailing = trailing;
    }
  }

  return { timestamps, values };
}
