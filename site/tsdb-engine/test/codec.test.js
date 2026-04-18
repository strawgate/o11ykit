import { describe, it, expect } from 'vitest'
import {
  BitWriter,
  BitReader,
  encodeChunk,
  decodeChunk,
  decodeChunkAnnotated,
  floatToBits,
  bitsToFloat,
} from '../js/codec.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeTimestamps(base, count, stepNs) {
  const ts = new BigInt64Array(count)
  for (let i = 0; i < count; i++) ts[i] = base + BigInt(i) * stepNs
  return ts
}

function makeValues(count, fn) {
  const vals = new Float64Array(count)
  for (let i = 0; i < count; i++) vals[i] = fn(i)
  return vals
}

// ── BitWriter / BitReader ────────────────────────────────────────────

describe('BitWriter / BitReader', () => {
  it('round-trips a single bit (0)', () => {
    const w = new BitWriter(1)
    w.writeBit(0)
    const r = new BitReader(w.finish())
    expect(r.readBit()).toBe(0)
  })

  it('round-trips a single bit (1)', () => {
    const w = new BitWriter(1)
    w.writeBit(1)
    const r = new BitReader(w.finish())
    expect(r.readBit()).toBe(1)
  })

  it('round-trips 7-bit pattern', () => {
    const w = new BitWriter(4)
    w.writeBitsNum(0b1010110, 7)
    const r = new BitReader(w.finish())
    expect(r.readBitsNum(7)).toBe(0b1010110)
  })

  it('round-trips a 64-bit BigInt', () => {
    const val = 0xDEADBEEFCAFEBABEn
    const w = new BitWriter(16)
    w.writeBits(val, 64)
    const r = new BitReader(w.finish())
    expect(r.readBits(64)).toBe(val)
  })

  it('round-trips mixed bit widths', () => {
    const w = new BitWriter(16)
    w.writeBit(1)
    w.writeBitsNum(42, 8)
    w.writeBits(123456789n, 40)
    w.writeBit(0)

    const r = new BitReader(w.finish())
    expect(r.readBit()).toBe(1)
    expect(r.readBitsNum(8)).toBe(42)
    expect(r.readBits(40)).toBe(123456789n)
    expect(r.readBit()).toBe(0)
  })

  it('totalBits tracks position correctly', () => {
    const w = new BitWriter(4)
    expect(w.totalBits).toBe(0)
    w.writeBit(1)
    expect(w.totalBits).toBe(1)
    w.writeBitsNum(0xFF, 8)
    expect(w.totalBits).toBe(9)
  })

  it('grows buffer when writing beyond initial capacity', () => {
    const w = new BitWriter(1) // only 1 byte = 8 bits
    for (let i = 0; i < 64; i++) w.writeBit(i % 2)
    const bytes = w.finish()
    expect(bytes.length).toBe(8) // 64 bits = 8 bytes

    const r = new BitReader(bytes)
    for (let i = 0; i < 64; i++) {
      expect(r.readBit()).toBe(i % 2)
    }
  })

  it('finish returns empty array when nothing written', () => {
    const w = new BitWriter(4)
    const bytes = w.finish()
    expect(bytes.length).toBe(0)
  })

  it('finish includes partial byte', () => {
    const w = new BitWriter(4)
    w.writeBit(1)
    const bytes = w.finish()
    expect(bytes.length).toBe(1)
  })
})

describe('BitReader EOF', () => {
  it('reading past the buffer returns NaN-ish values (no throw)', () => {
    const r = new BitReader(new Uint8Array([0b10000000]))
    expect(r.readBit()).toBe(1) // valid
    // Reading past end doesn't throw, it returns garbage from undefined bytes
    const bit = r.readBit()
    expect(typeof bit).toBe('number')
  })
})

// ── encodeChunk / decodeChunk ────────────────────────────────────────

describe('encodeChunk / decodeChunk', () => {
  it('round-trips regular timestamps and values', () => {
    const baseTs = 1_700_000_000_000_000_000n
    const ts = makeTimestamps(baseTs, 10, 1_000_000_000n) // 1 second apart
    const vals = makeValues(10, i => 42.5 + i * 0.1)

    const encoded = encodeChunk(ts, vals)
    expect(encoded).toBeInstanceOf(Uint8Array)
    expect(encoded.length).toBeGreaterThan(0)

    const decoded = decodeChunk(encoded)
    expect(decoded.timestamps.length).toBe(10)
    expect(decoded.values.length).toBe(10)

    for (let i = 0; i < 10; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i])
      expect(decoded.values[i]).toBeCloseTo(vals[i], 10)
    }
  })

  it('round-trips all-same values (zero XOR deltas)', () => {
    const ts = makeTimestamps(1000n, 5, 100n)
    const vals = new Float64Array([7.5, 7.5, 7.5, 7.5, 7.5])

    const decoded = decodeChunk(encodeChunk(ts, vals))
    for (let i = 0; i < 5; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i])
      expect(decoded.values[i]).toBe(7.5)
    }
  })

  it('round-trips monotonically increasing timestamps with constant delta', () => {
    const ts = makeTimestamps(0n, 20, 1000n) // constant delta = 1000
    const vals = makeValues(20, i => i * 10.0)

    const decoded = decodeChunk(encodeChunk(ts, vals))
    for (let i = 0; i < 20; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i])
      expect(decoded.values[i]).toBeCloseTo(vals[i], 10)
    }
  })

  it('round-trips with large timestamp gaps', () => {
    const ts = new BigInt64Array([
      1_000_000_000_000n,
      1_000_000_000_000n + 1_000_000_000n,
      1_000_000_000_000n + 100_000_000_000n, // big jump
      1_000_000_000_000n + 100_000_000_001n,
    ])
    const vals = new Float64Array([1.0, 2.0, 3.0, 4.0])

    const decoded = decodeChunk(encodeChunk(ts, vals))
    for (let i = 0; i < 4; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i])
      expect(decoded.values[i]).toBeCloseTo(vals[i], 10)
    }
  })

  it('round-trips diverse value patterns', () => {
    const ts = makeTimestamps(0n, 6, 1000n)
    const vals = new Float64Array([0, -1.5, 1e10, 1e-10, Math.PI, -0])

    const decoded = decodeChunk(encodeChunk(ts, vals))
    for (let i = 0; i < 6; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i])
      expect(decoded.values[i]).toBeCloseTo(vals[i], 10)
    }
  })

  it('handles empty input', () => {
    const encoded = encodeChunk(new BigInt64Array(0), new Float64Array(0))
    expect(encoded.length).toBe(0)

    const decoded = decodeChunk(encoded)
    expect(decoded.timestamps.length).toBe(0)
    expect(decoded.values.length).toBe(0)
  })

  it('handles single sample', () => {
    const ts = new BigInt64Array([1_000_000_000_000_000_000n])
    const vals = new Float64Array([42.0])

    const decoded = decodeChunk(encodeChunk(ts, vals))
    expect(decoded.timestamps.length).toBe(1)
    expect(decoded.timestamps[0]).toBe(1_000_000_000_000_000_000n)
    expect(decoded.values[0]).toBe(42.0)
  })

  it('handles larger chunk (100 samples)', () => {
    const ts = makeTimestamps(1_000_000_000n, 100, 15_000_000_000n) // 15s apart
    const vals = makeValues(100, i => Math.sin(i * 0.1) * 100)

    const decoded = decodeChunk(encodeChunk(ts, vals))
    expect(decoded.timestamps.length).toBe(100)
    for (let i = 0; i < 100; i++) {
      expect(decoded.timestamps[i]).toBe(ts[i])
      expect(decoded.values[i]).toBeCloseTo(vals[i], 10)
    }
  })
})

// ── decodeChunkAnnotated ─────────────────────────────────────────────

describe('decodeChunkAnnotated', () => {
  it('returns correct structure with bitMap', () => {
    const ts = makeTimestamps(1000n, 3, 100n)
    const vals = new Float64Array([1.0, 2.0, 3.0])
    const encoded = encodeChunk(ts, vals)

    const result = decodeChunkAnnotated(encoded)
    expect(result.timestamps).toBeInstanceOf(BigInt64Array)
    expect(result.values).toBeInstanceOf(Float64Array)
    expect(Array.isArray(result.bitMap)).toBe(true)
    expect(result.bitMap.length).toBe(3)
  })

  it('sample 0 uses raw encoding', () => {
    const ts = new BigInt64Array([5000n])
    const vals = new Float64Array([99.9])
    const encoded = encodeChunk(ts, vals)

    const { bitMap } = decodeChunkAnnotated(encoded)
    expect(bitMap[0].sampleIndex).toBe(0)
    expect(bitMap[0].timestamp.encoding).toBe('raw')
    expect(bitMap[0].timestamp.bits).toBe(64)
    expect(bitMap[0].value.encoding).toBe('raw')
    expect(bitMap[0].value.bits).toBe(64)
    expect(bitMap[0].timestamp.decoded).toBe(5000n)
    expect(bitMap[0].value.decoded).toBeCloseTo(99.9, 10)
  })

  it('subsequent samples have encoding annotations', () => {
    const ts = makeTimestamps(1000n, 4, 100n) // constant delta → dod=0
    const vals = new Float64Array([1.0, 1.0, 2.0, 2.0])
    const encoded = encodeChunk(ts, vals)

    const { bitMap } = decodeChunkAnnotated(encoded)
    // Sample 1 should have dod and delta
    expect(bitMap[1].timestamp).toHaveProperty('dod')
    expect(bitMap[1].timestamp).toHaveProperty('delta')
    // Constant delta → dod-zero for sample 2 onwards
    expect(bitMap[2].timestamp.encoding).toBe('dod-zero')
    // Same value → xor-zero
    expect(bitMap[1].value.encoding).toBe('xor-zero')
    expect(bitMap[1].value.bits).toBe(1)
  })

  it('annotated decode matches plain decode', () => {
    const ts = makeTimestamps(0n, 10, 500n)
    const vals = makeValues(10, i => i * 1.5)
    const encoded = encodeChunk(ts, vals)

    const plain = decodeChunk(encoded)
    const annotated = decodeChunkAnnotated(encoded)

    for (let i = 0; i < 10; i++) {
      expect(annotated.timestamps[i]).toBe(plain.timestamps[i])
      expect(annotated.values[i]).toBeCloseTo(plain.values[i], 10)
    }
  })

  it('handles empty input', () => {
    const result = decodeChunkAnnotated(new Uint8Array(0))
    expect(result.timestamps.length).toBe(0)
    expect(result.values.length).toBe(0)
    expect(result.bitMap.length).toBe(0)
  })
})

// ── floatToBits / bitsToFloat ────────────────────────────────────────

describe('floatToBits / bitsToFloat', () => {
  it('round-trips common values', () => {
    for (const v of [0, 1.0, -1.0, 42.5, Math.PI, 1e100, Number.MIN_VALUE]) {
      expect(bitsToFloat(floatToBits(v))).toBe(v)
    }
  })
})
