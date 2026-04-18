// ── XOR-Delta Codec ──────────────────────────────────────────────────

const f64Buf = new ArrayBuffer(8);
const f64View = new DataView(f64Buf);

export function floatToBits(f) {
  f64View.setFloat64(0, f, false);
  const hi = f64View.getUint32(0, false);
  const lo = f64View.getUint32(4, false);
  return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
}

export function bitsToFloat(bits) {
  f64View.setUint32(0, Number((bits >> 32n) & 0xFFFFFFFFn), false);
  f64View.setUint32(4, Number(bits & 0xFFFFFFFFn), false);
  return f64View.getFloat64(0, false);
}

export function clz64(x) {
  if (x === 0n) return 64;
  let n = 0;
  if ((x & 0xFFFFFFFF00000000n) === 0n) { n += 32; x <<= 32n; }
  if ((x & 0xFFFF000000000000n) === 0n) { n += 16; x <<= 16n; }
  if ((x & 0xFF00000000000000n) === 0n) { n += 8; x <<= 8n; }
  if ((x & 0xF000000000000000n) === 0n) { n += 4; x <<= 4n; }
  if ((x & 0xC000000000000000n) === 0n) { n += 2; x <<= 2n; }
  if ((x & 0x8000000000000000n) === 0n) { n += 1; }
  return n;
}

export function ctz64(x) {
  if (x === 0n) return 64;
  let n = 0;
  if ((x & 0xFFFFFFFFn) === 0n) { n += 32; x >>= 32n; }
  if ((x & 0xFFFFn) === 0n) { n += 16; x >>= 16n; }
  if ((x & 0xFFn) === 0n) { n += 8; x >>= 8n; }
  if ((x & 0xFn) === 0n) { n += 4; x >>= 4n; }
  if ((x & 0x3n) === 0n) { n += 2; x >>= 2n; }
  if ((x & 0x1n) === 0n) { n += 1; }
  return n;
}

export class BitWriter {
  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.bytePos = 0;
    this.bitPos = 0;
  }
  writeBit(bit) {
    if (this.bytePos >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    if (bit) this.buf[this.bytePos] |= 0x80 >>> this.bitPos;
    this.bitPos++;
    if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
  }
  writeBits(value, count) {
    for (let i = count - 1; i >= 0; i--) this.writeBit(Number((value >> BigInt(i)) & 1n));
  }
  writeBitsNum(value, count) {
    for (let i = count - 1; i >= 0; i--) this.writeBit((value >>> i) & 1);
  }
  finish() {
    const len = this.bitPos > 0 ? this.bytePos + 1 : this.bytePos;
    return this.buf.slice(0, len);
  }
  // Current bit position (useful for annotated encoding)
  get totalBits() {
    return this.bytePos * 8 + this.bitPos;
  }
}

export class BitReader {
  constructor(buf) { this.buf = buf; this.bytePos = 0; this.bitPos = 0; }
  readBit() {
    const bit = (this.buf[this.bytePos] >>> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
    return bit;
  }
  readBits(count) {
    let v = 0n;
    for (let i = 0; i < count; i++) v = (v << 1n) | BigInt(this.readBit());
    return v;
  }
  readBitsNum(count) {
    let v = 0;
    for (let i = 0; i < count; i++) v = (v << 1) | this.readBit();
    return v;
  }
  // Current bit position (useful for annotated decoding)
  get totalBits() {
    return this.bytePos * 8 + this.bitPos;
  }
}

export function encodeChunk(timestamps, values) {
  const n = timestamps.length;
  if (n === 0) return new Uint8Array(0);
  const w = new BitWriter(n * 2);
  w.writeBitsNum(n, 16);
  w.writeBits(BigInt(timestamps[0]) & 0xFFFFFFFFFFFFFFFFn, 64);
  w.writeBits(floatToBits(values[0]), 64);
  if (n === 1) return w.finish();

  let prevTs = timestamps[0], prevDelta = 0n;
  let prevValBits = floatToBits(values[0]), prevLeading = 64, prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    const ts = timestamps[i];
    const delta = ts - prevTs;
    const dod = delta - prevDelta;

    if (dod === 0n) {
      w.writeBit(0);
    } else {
      const absDod = dod < 0n ? -dod : dod;
      if (absDod <= 64n) {
        w.writeBit(1); w.writeBit(0);
        w.writeBitsNum(Number((dod << 1n) ^ (dod >> 63n)) & 0x7F, 7);
      } else if (absDod <= 256n) {
        w.writeBit(1); w.writeBit(1); w.writeBit(0);
        w.writeBitsNum(Number((dod << 1n) ^ (dod >> 63n)) & 0x1FF, 9);
      } else if (absDod <= 2048n) {
        w.writeBit(1); w.writeBit(1); w.writeBit(1); w.writeBit(0);
        w.writeBitsNum(Number((dod << 1n) ^ (dod >> 63n)) & 0xFFF, 12);
      } else {
        w.writeBit(1); w.writeBit(1); w.writeBit(1); w.writeBit(1);
        w.writeBits(BigInt.asUintN(64, dod), 64);
      }
    }
    prevDelta = delta;
    prevTs = ts;

    const valBits = floatToBits(values[i]);
    const xor = prevValBits ^ valBits;
    if (xor === 0n) {
      w.writeBit(0);
    } else {
      const leading = clz64(xor);
      const trailing = ctz64(xor);
      const meaningful = 64 - leading - trailing;
      if (leading >= prevLeading && trailing >= prevTrailing) {
        w.writeBit(1); w.writeBit(0);
        const prevMeaningful = 64 - prevLeading - prevTrailing;
        w.writeBits(xor >> BigInt(prevTrailing), prevMeaningful);
      } else {
        w.writeBit(1); w.writeBit(1);
        w.writeBitsNum(leading, 6);
        w.writeBitsNum(meaningful - 1, 6);
        w.writeBits(xor >> BigInt(trailing), meaningful);
        prevLeading = leading;
        prevTrailing = trailing;
      }
    }
    prevValBits = valBits;
  }
  return w.finish();
}

export function decodeChunk(buf) {
  if (buf.length === 0) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
  const r = new BitReader(buf);
  const n = r.readBitsNum(16);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  timestamps[0] = BigInt.asIntN(64, r.readBits(64));
  values[0] = bitsToFloat(r.readBits(64));
  if (n === 1) return { timestamps, values };

  let prevTs = timestamps[0], prevDelta = 0n;
  let prevValBits = floatToBits(values[0]), prevLeading = 0, prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    let dod;
    if (r.readBit() === 0) {
      dod = 0n;
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(7);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(9);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(12);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
    } else {
      dod = BigInt.asIntN(64, r.readBits(64));
    }
    const delta = prevDelta + dod;
    timestamps[i] = prevTs + delta;
    prevDelta = delta;
    prevTs = timestamps[i];

    if (r.readBit() === 0) {
      values[i] = bitsToFloat(prevValBits);
    } else if (r.readBit() === 0) {
      const meaningful = 64 - prevLeading - prevTrailing;
      const xor = r.readBits(meaningful) << BigInt(prevTrailing);
      prevValBits ^= xor;
      values[i] = bitsToFloat(prevValBits);
    } else {
      const leading = r.readBitsNum(6);
      const meaningful = r.readBitsNum(6) + 1;
      const trailing = 64 - leading - meaningful;
      const xor = r.readBits(meaningful) << BigInt(trailing);
      prevValBits ^= xor;
      values[i] = bitsToFloat(prevValBits);
      prevLeading = leading;
      prevTrailing = trailing;
    }
  }
  return { timestamps, values };
}

/**
 * Decode a XOR-delta chunk and return per-sample bit annotations.
 * Returns { timestamps, values, bitMap } where bitMap[i] describes
 * the bit range for sample i's timestamp and value encoding.
 */
export function decodeChunkAnnotated(buf) {
  if (buf.length === 0) {
    return { timestamps: new BigInt64Array(0), values: new Float64Array(0), bitMap: [] };
  }
  const r = new BitReader(buf);
  const n = r.readBitsNum(16);
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  const bitMap = [];

  // Header: 16 bits count
  const headerEnd = r.totalBits; // 16

  // Sample 0: raw ts (64 bits) + raw value (64 bits)
  const ts0Start = r.totalBits;
  timestamps[0] = BigInt.asIntN(64, r.readBits(64));
  const ts0End = r.totalBits;

  const val0Start = r.totalBits;
  values[0] = bitsToFloat(r.readBits(64));
  const val0End = r.totalBits;

  bitMap.push({
    sampleIndex: 0,
    timestamp: { startBit: ts0Start, endBit: ts0End, encoding: 'raw', bits: 64, decoded: timestamps[0] },
    value: { startBit: val0Start, endBit: val0End, encoding: 'raw', bits: 64, decoded: values[0] },
  });

  if (n === 1) return { timestamps, values, bitMap };

  let prevTs = timestamps[0], prevDelta = 0n;
  let prevValBits = floatToBits(values[0]), prevLeading = 0, prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    // ── Timestamp ──
    const tsStart = r.totalBits;
    let dod;
    let tsEncoding;
    let tsBits;
    if (r.readBit() === 0) {
      dod = 0n;
      tsEncoding = 'dod-zero';
      tsBits = 1;
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(7);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
      tsEncoding = 'dod-7bit';
      tsBits = 9; // 2 prefix + 7 data
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(9);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
      tsEncoding = 'dod-9bit';
      tsBits = 12; // 3 prefix + 9 data
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(12);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
      tsEncoding = 'dod-12bit';
      tsBits = 16; // 4 prefix + 12 data
    } else {
      dod = BigInt.asIntN(64, r.readBits(64));
      tsEncoding = 'dod-64bit';
      tsBits = 68; // 4 prefix + 64 data
    }
    const delta = prevDelta + dod;
    timestamps[i] = prevTs + delta;
    prevDelta = delta;
    prevTs = timestamps[i];
    const tsEnd = r.totalBits;

    // ── Value ──
    const valStart = r.totalBits;
    let valEncoding;
    let valBits;
    let xorBits = 0n;
    let leading = 0, trailing = 0, meaningful = 0;

    if (r.readBit() === 0) {
      values[i] = bitsToFloat(prevValBits);
      valEncoding = 'xor-zero';
      valBits = 1;
    } else if (r.readBit() === 0) {
      meaningful = 64 - prevLeading - prevTrailing;
      xorBits = r.readBits(meaningful) << BigInt(prevTrailing);
      prevValBits ^= xorBits;
      values[i] = bitsToFloat(prevValBits);
      valEncoding = 'xor-reuse';
      valBits = 2 + meaningful;
      leading = prevLeading;
      trailing = prevTrailing;
    } else {
      leading = r.readBitsNum(6);
      meaningful = r.readBitsNum(6) + 1;
      trailing = 64 - leading - meaningful;
      xorBits = r.readBits(meaningful) << BigInt(trailing);
      prevValBits ^= xorBits;
      values[i] = bitsToFloat(prevValBits);
      valEncoding = 'xor-new';
      valBits = 2 + 6 + 6 + meaningful;
      prevLeading = leading;
      prevTrailing = trailing;
    }
    const valEnd = r.totalBits;

    bitMap.push({
      sampleIndex: i,
      timestamp: {
        startBit: tsStart, endBit: tsEnd, encoding: tsEncoding,
        bits: tsBits, decoded: timestamps[i], dod: dod, delta: delta,
      },
      value: {
        startBit: valStart, endBit: valEnd, encoding: valEncoding,
        bits: valBits, decoded: values[i], xor: xorBits,
        leading, trailing, meaningful,
      },
    });
  }

  return { timestamps, values, bitMap };
}
