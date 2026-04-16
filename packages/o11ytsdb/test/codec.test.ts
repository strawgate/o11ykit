import { describe, expect, it } from 'vitest';

import { BitWriter, BitReader, encodeChunk, decodeChunk } from '../src/codec.js';

describe('BitWriter / BitReader', () => {
  it('round-trips individual bits', () => {
    const w = new BitWriter();
    w.writeBit(1);
    w.writeBit(0);
    w.writeBit(1);
    w.writeBit(1);
    w.writeBit(0);
    w.writeBit(0);
    w.writeBit(1);
    w.writeBit(0);
    const buf = w.finish();
    const r = new BitReader(buf);
    expect(r.readBit()).toBe(1);
    expect(r.readBit()).toBe(0);
    expect(r.readBit()).toBe(1);
    expect(r.readBit()).toBe(1);
    expect(r.readBit()).toBe(0);
    expect(r.readBit()).toBe(0);
    expect(r.readBit()).toBe(1);
    expect(r.readBit()).toBe(0);
  });

  it('round-trips multi-bit values', () => {
    const w = new BitWriter();
    w.writeBits(0xDEADn, 16);
    w.writeBitsNum(42, 7);
    const buf = w.finish();
    const r = new BitReader(buf);
    expect(r.readBits(16)).toBe(0xDEADn);
    expect(r.readBitsNum(7)).toBe(42);
  });
});

describe('encodeChunk / decodeChunk', () => {
  it('encodes and decodes empty array', () => {
    const result = encodeChunk(new BigInt64Array(0), new Float64Array(0));
    expect(result.byteLength).toBe(0);
  });

  it('round-trips a single sample', () => {
    const ts = BigInt64Array.from([1_700_000_000_000n]);
    const vals = Float64Array.from([42.5]);
    const compressed = encodeChunk(ts, vals);
    const decoded = decodeChunk(compressed);
    expect(decoded.timestamps[0]).toBe(ts[0]);
    expect(decoded.values[0]).toBe(vals[0]);
  });

  it('round-trips constant values (all XOR == 0)', () => {
    const n = 100;
    const ts = new BigInt64Array(n);
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ts[i] = 1_700_000_000_000n + BigInt(i) * 15_000n;
      vals[i] = 42.0;
    }
    const decoded = decodeChunk(encodeChunk(ts, vals));
    expect(decoded.timestamps.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i]);
      expect(decoded.values[i]).toBe(42.0);
    }
  });

  it('round-trips monotonic counter values', () => {
    const n = 500;
    const ts = new BigInt64Array(n);
    const vals = new Float64Array(n);
    let counter = 0;
    for (let i = 0; i < n; i++) {
      ts[i] = 1_700_000_000_000n + BigInt(i) * 15_000n;
      counter += Math.floor(Math.random() * 10) + 1;
      vals[i] = counter;
    }
    const decoded = decodeChunk(encodeChunk(ts, vals));
    for (let i = 0; i < n; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i]);
      expect(decoded.values[i]).toBe(vals[i]);
    }
  });

  it('round-trips high-entropy float values', () => {
    const n = 200;
    const ts = new BigInt64Array(n);
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ts[i] = 1_700_000_000_000n + BigInt(i) * 15_000n;
      vals[i] = Math.random() * 1000 - 500;
    }
    const decoded = decodeChunk(encodeChunk(ts, vals));
    for (let i = 0; i < n; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i]);
      expect(decoded.values[i]).toBe(vals[i]);
    }
  });

  it('handles irregular timestamp intervals (large DoD)', () => {
    const ts = BigInt64Array.from([
      1_000_000n,
      1_015_000n,  // delta=15000
      1_030_000n,  // delta=15000, dod=0
      1_100_000n,  // delta=70000, dod=55000 (large)
      5_000_000n,  // delta=3900000, dod=3830000 (huge)
    ]);
    const vals = Float64Array.from([1.0, 2.0, 3.0, 4.0, 5.0]);
    const decoded = decodeChunk(encodeChunk(ts, vals));
    for (let i = 0; i < 5; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i]);
      expect(decoded.values[i]).toBe(vals[i]);
    }
  });

  it('achieves good compression on constant data', () => {
    const n = 1000;
    const ts = new BigInt64Array(n);
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ts[i] = BigInt(i) * 15_000n;
      vals[i] = 42.0;
    }
    const compressed = encodeChunk(ts, vals);
    const rawSize = n * 16; // 8 bytes ts + 8 bytes val
    // Constant data should compress very well — at least 4× better
    expect(compressed.byteLength).toBeLessThan(rawSize / 4);
  });

  it('rejects mismatched array lengths', () => {
    expect(() => encodeChunk(
      BigInt64Array.from([1n, 2n]),
      Float64Array.from([1.0]),
    )).toThrow('same length');
  });

  it('rejects arrays exceeding 65535 samples', () => {
    const big = new BigInt64Array(70000);
    const bigV = new Float64Array(70000);
    expect(() => encodeChunk(big, bigV)).toThrow('65535');
  });
});
