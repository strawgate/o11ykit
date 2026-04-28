// ── XOR-Delta Codec (re-exported from o11ytsdb) ─────────────────────

import {
  BitReader as _BitReader,
  BitWriter as _BitWriter,
  bitsToFloat,
  clz64,
  ctz64,
  decodeChunk,
  encodeChunk,
  floatToBits,
} from "o11ytsdb";

// Subclasses add a `totalBits` getter used by decodeChunkAnnotated and the
// byte-explorer visualizations.  The real classes expose `bitsWritten` / `bitsRead`.
class BitWriter extends _BitWriter {
  get totalBits() {
    return this.bitsWritten;
  }
}

class BitReader extends _BitReader {
  get totalBits() {
    return this.bitsRead;
  }
}

export { BitReader, BitWriter, bitsToFloat, clz64, ctz64, decodeChunk, encodeChunk, floatToBits };

/**
 * Decode a XOR-delta chunk and return per-sample bit annotations.
 * Returns { timestamps, values, bitMap } where bitMap[i] describes
 * the bit range for sample i's timestamp and value encoding.
 * @param {Uint8Array} buf
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
  const _headerEnd = r.totalBits; // 16

  // Sample 0: raw ts (64 bits) + raw value (64 bits)
  const ts0Start = r.totalBits;
  timestamps[0] = BigInt.asIntN(64, r.readBits(64));
  const ts0End = r.totalBits;

  const val0Start = r.totalBits;
  values[0] = bitsToFloat(r.readBits(64));
  const val0End = r.totalBits;

  bitMap.push({
    sampleIndex: 0,
    timestamp: {
      startBit: ts0Start,
      endBit: ts0End,
      encoding: "raw",
      bits: 64,
      decoded: timestamps[0],
    },
    value: { startBit: val0Start, endBit: val0End, encoding: "raw", bits: 64, decoded: values[0] },
  });

  if (n === 1) return { timestamps, values, bitMap };

  let prevTs = timestamps[0],
    prevDelta = 0n;
  let prevValBits = floatToBits(values[0]),
    prevLeading = 0,
    prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    // ── Timestamp ──
    const tsStart = r.totalBits;
    let dod;
    let tsEncoding;
    let tsBits;
    if (r.readBit() === 0) {
      dod = 0n;
      tsEncoding = "dod-zero";
      tsBits = 1;
      // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(7);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
      tsEncoding = "dod-7bit";
      tsBits = 9; // 2 prefix + 7 data
      // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(9);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
      tsEncoding = "dod-9bit";
      tsBits = 12; // 3 prefix + 9 data
      // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
    } else if (r.readBit() === 0) {
      const zz = r.readBitsNum(12);
      dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
      tsEncoding = "dod-12bit";
      tsBits = 16; // 4 prefix + 12 data
    } else {
      dod = BigInt.asIntN(64, r.readBits(64));
      tsEncoding = "dod-64bit";
      tsBits = 68; // 4 prefix + 64 data
    }
    const delta = prevDelta + dod;
    timestamps[i] = prevTs + delta;
    prevDelta = delta;
    prevTs = /** @type {bigint} */ (timestamps[i]);
    const tsEnd = r.totalBits;

    // ── Value ──
    const valStart = r.totalBits;
    let valEncoding;
    let valBits;
    let xorBits = 0n;
    let leading = 0,
      trailing = 0,
      meaningful = 0;

    if (r.readBit() === 0) {
      values[i] = bitsToFloat(prevValBits);
      valEncoding = "xor-zero";
      valBits = 1;
      // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
    } else if (r.readBit() === 0) {
      meaningful = 64 - prevLeading - prevTrailing;
      xorBits = r.readBits(meaningful) << BigInt(prevTrailing);
      prevValBits ^= xorBits;
      values[i] = bitsToFloat(prevValBits);
      valEncoding = "xor-reuse";
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
      valEncoding = "xor-new";
      valBits = 2 + 6 + 6 + meaningful;
      prevLeading = leading;
      prevTrailing = trailing;
    }
    const valEnd = r.totalBits;

    bitMap.push({
      sampleIndex: i,
      timestamp: {
        startBit: tsStart,
        endBit: tsEnd,
        encoding: tsEncoding,
        bits: tsBits,
        decoded: timestamps[i],
        dod: dod,
        delta: delta,
      },
      value: {
        startBit: valStart,
        endBit: valEnd,
        encoding: valEncoding,
        bits: valBits,
        decoded: values[i],
        xor: xorBits,
        leading,
        trailing,
        meaningful,
      },
    });
  }

  return { timestamps, values, bitMap };
}
