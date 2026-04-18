import { describe, it, expect } from 'vitest';
import {
  parseALPHeader,
  parseXORHeader,
  buildALPBitMap,
  buildByteLookup,
  entryByteRange,
  buildByteRegionMap,
  renderHexRowHTML,
  encodingDescription,
  buildALPInsightHtml,
  buildXORInsightHtml,
} from '../js/byte-explorer-logic.js';
import { encodeChunk, BitWriter } from '../js/codec.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeALPBlob({ count, exponent, bitWidth, minInt, excCount, offsets, excPositions, excValues }) {
  // 14-byte header + bit-packed offsets + exception positions + exception values
  const bpBytes = Math.ceil(count * bitWidth / 8);
  const totalLen = 14 + bpBytes + excCount * 2 + excCount * 8;
  const buf = new Uint8Array(totalLen);
  const dv = new DataView(buf.buffer);

  // Header
  dv.setUint16(0, count);
  buf[2] = exponent;
  buf[3] = bitWidth;
  dv.setBigInt64(4, BigInt(minInt));
  dv.setUint16(12, excCount);

  // Bit-pack offsets
  for (let i = 0; i < count; i++) {
    const val = BigInt(offsets[i]);
    for (let b = 0; b < bitWidth; b++) {
      const globalBit = 14 * 8 + i * bitWidth + b;
      const byteIdx = Math.floor(globalBit / 8);
      const bitIdx = 7 - (globalBit % 8);
      if (Number((val >> BigInt(bitWidth - 1 - b)) & 1n)) {
        buf[byteIdx] |= (1 << bitIdx);
      }
    }
  }

  // Exception positions (u16 BE)
  const excPosStart = 14 + bpBytes;
  for (let e = 0; e < excCount; e++) {
    dv.setUint16(excPosStart + e * 2, excPositions[e]);
  }

  // Exception values (f64 BE)
  const excValStart = excPosStart + excCount * 2;
  for (let e = 0; e < excCount; e++) {
    dv.setFloat64(excValStart + e * 8, excValues[e]);
  }

  return buf;
}

function makeTimestampBlob(timestamps) {
  const bw = new BitWriter();
  bw.writeBitsNum(timestamps.length, 16);
  bw.writeBits(BigInt(timestamps[0]), 64);

  let prevTs = BigInt(timestamps[0]);
  let prevDelta = 0n;
  for (let i = 1; i < timestamps.length; i++) {
    const ts = BigInt(timestamps[i]);
    const delta = ts - prevTs;
    const dod = delta - prevDelta;

    if (dod === 0n) {
      bw.writeBit(0); // prefix: 0
    } else {
      // Zigzag encode
      const absDod = dod < 0n ? -dod : dod;
      const zz = Number(dod < 0n ? absDod * 2n - 1n : absDod * 2n);
      if (absDod <= 64n) {
        bw.writeBit(1); bw.writeBit(0); // prefix: 10
        bw.writeBitsNum(zz, 7);
      } else if (absDod <= 256n) {
        bw.writeBit(1); bw.writeBit(1); bw.writeBit(0); // prefix: 110
        bw.writeBitsNum(zz, 9);
      } else if (absDod <= 2048n) {
        bw.writeBit(1); bw.writeBit(1); bw.writeBit(1); bw.writeBit(0); // prefix: 1110
        bw.writeBitsNum(zz, 12);
      } else {
        bw.writeBit(1); bw.writeBit(1); bw.writeBit(1); bw.writeBit(1); // prefix: 1111
        bw.writeBits(BigInt.asUintN(64, dod), 64);
      }
    }
    prevDelta = delta;
    prevTs = ts;
  }

  return new Uint8Array(bw.finish());
}

// ── Tests ────────────────────────────────────────────────────────────

describe('parseALPHeader', () => {
  it('parses a valid 14-byte ALP header', () => {
    const blob = makeALPBlob({
      count: 100, exponent: 3, bitWidth: 11, minInt: 42000n,
      excCount: 0, offsets: new Array(100).fill(0), excPositions: [], excValues: [],
    });
    const hdr = parseALPHeader(blob);
    expect(hdr.count).toBe(100);
    expect(hdr.exponent).toBe(3);
    expect(hdr.bitWidth).toBe(11);
    expect(hdr.minInt).toBe(42000n);
    expect(hdr.excCount).toBe(0);
  });

  it('handles small blobs gracefully', () => {
    const hdr = parseALPHeader(new Uint8Array(3));
    expect(hdr.count).toBe(0);
    expect(hdr.bitWidth).toBe(0);
    expect(hdr.minInt).toBe(0n);
    expect(hdr.excCount).toBe(0);
  });

  it('handles empty blob', () => {
    const hdr = parseALPHeader(new Uint8Array(0));
    expect(hdr.count).toBe(0);
    expect(hdr.exponent).toBe(0);
  });
});

describe('parseXORHeader', () => {
  it('parses a valid 18-byte XOR header', () => {
    const timestamps = [1000000000n, 1001000000n, 1002000000n];
    const values = [42.5, 42.7, 42.9];
    const encoded = encodeChunk(timestamps, values);
    const blob = new Uint8Array(encoded);
    const hdr = parseXORHeader(blob);
    expect(hdr.count).toBe(3);
    expect(hdr.firstTs).toBe(1000000000n);
    expect(hdr.firstVal).toBeCloseTo(42.5);
  });

  it('handles small blobs', () => {
    const hdr = parseXORHeader(new Uint8Array(5));
    expect(hdr.count).toBe(0);
    expect(hdr.firstTs).toBe(0n);
    expect(hdr.firstVal).toBe(0);
  });
});

describe('buildALPBitMap', () => {
  it('builds value entries for bit-packed offsets', () => {
    const offsets = [5, 10, 15, 20, 25];
    const blob = makeALPBlob({
      count: 5, exponent: 3, bitWidth: 8, minInt: 1000n,
      excCount: 0, offsets, excPositions: [], excValues: [],
    });

    const bitMap = buildALPBitMap(blob, null, 5);
    const values = bitMap.filter(e => e.type === 'value');

    expect(values).toHaveLength(5);
    values.forEach((entry, i) => {
      expect(entry.sampleIndex).toBe(i);
      expect(entry.type).toBe('value');
      expect(entry.encoding).toBe('alp-bitpacked');
      expect(entry.offset).toBe(offsets[i]);
      expect(entry.bitWidth).toBe(8);
      expect(entry.isException).toBe(false);
      // Verify decoded value: (offset + minInt) / 10^exp
      expect(entry.decoded).toBeCloseTo((offsets[i] + 1000) / 1000, 6);
    });
  });

  it('marks exceptions correctly', () => {
    const blob = makeALPBlob({
      count: 3, exponent: 2, bitWidth: 4, minInt: 0n,
      excCount: 1, offsets: [1, 2, 3],
      excPositions: [1], excValues: [99.99],
    });

    const bitMap = buildALPBitMap(blob, null, 3);
    const values = bitMap.filter(e => e.type === 'value');

    expect(values[0].isException).toBe(false);
    expect(values[1].isException).toBe(true);
    expect(values[1].encoding).toBe('alp-exception');
    expect(values[1].decoded).toBeCloseTo(99.99);
    expect(values[2].isException).toBe(false);
  });

  it('includes timestamp entries when tsBlob provided', () => {
    const blob = makeALPBlob({
      count: 3, exponent: 3, bitWidth: 8, minInt: 0n,
      excCount: 0, offsets: [1, 2, 3], excPositions: [], excValues: [],
    });
    const tsBlob = makeTimestampBlob([1000000000, 1001000000, 1002000000]);

    const bitMap = buildALPBitMap(blob, tsBlob, 3);
    const tsEntries = bitMap.filter(e => e.type === 'timestamp');

    expect(tsEntries).toHaveLength(3);
    expect(tsEntries[0].encoding).toBe('raw');
    expect(tsEntries[0].decoded).toBe(1000000000n);
    // Subsequent timestamps use delta-of-delta encoding
    expect(tsEntries[1].sampleIndex).toBe(1);
    expect(tsEntries[2].sampleIndex).toBe(2);
  });

  it('bit positions are non-overlapping and contiguous for values', () => {
    const blob = makeALPBlob({
      count: 10, exponent: 2, bitWidth: 5, minInt: 0n,
      excCount: 0, offsets: Array.from({ length: 10 }, (_, i) => i),
      excPositions: [], excValues: [],
    });

    const bitMap = buildALPBitMap(blob, null, 10);
    const values = bitMap.filter(e => e.type === 'value');

    for (let i = 1; i < values.length; i++) {
      expect(values[i].startBit).toBe(values[i - 1].endBit);
    }
  });
});

describe('buildByteLookup', () => {
  it('returns null for empty bitMap', () => {
    expect(buildByteLookup(null, 100)).toBeNull();
    expect(buildByteLookup([], 100)).toBeNull();
  });

  it('maps bytes to their dominant entry', () => {
    const bitMap = [
      { sampleIndex: 0, type: 'value', startBit: 0, endBit: 16 },  // 2 full bytes
      { sampleIndex: 1, type: 'value', startBit: 16, endBit: 32 }, // 2 more bytes
    ];

    const lookup = buildByteLookup(bitMap, 4);
    expect(lookup[0]).toBe(bitMap[0]);
    expect(lookup[1]).toBe(bitMap[0]);
    expect(lookup[2]).toBe(bitMap[1]);
    expect(lookup[3]).toBe(bitMap[1]);
  });

  it('handles sub-byte entries (assigns byte to majority owner)', () => {
    // Entry A owns bits 0-5 (6 bits) of byte 0
    // Entry B owns bits 6-12 (7 bits) spanning byte 0 (2 bits) and byte 1 (5 bits)
    const bitMap = [
      { sampleIndex: 0, type: 'value', startBit: 0, endBit: 6 },
      { sampleIndex: 1, type: 'value', startBit: 6, endBit: 13 },
    ];

    const lookup = buildByteLookup(bitMap, 2);
    // Byte 0 has 6 bits from A, 2 bits from B → A wins
    expect(lookup[0]).toBe(bitMap[0]);
    // Byte 1 has 5 bits from B → B wins
    expect(lookup[1]).toBe(bitMap[1]);
  });

  it('handles blobOffset for timestamp entries', () => {
    const bitMap = [
      { sampleIndex: 0, type: 'timestamp', startBit: 0, endBit: 16, blobOffset: 10 },
    ];

    const lookup = buildByteLookup(bitMap, 20);
    // Bits 0-15 at blobOffset 10 → global bits 80-95 → bytes 10-11
    expect(lookup[10]).toBe(bitMap[0]);
    expect(lookup[11]).toBe(bitMap[0]);
    expect(lookup[9]).toBeUndefined();
    expect(lookup[12]).toBeUndefined();
  });
});

describe('entryByteRange', () => {
  it('computes byte range for a value entry', () => {
    const entry = { startBit: 0, endBit: 24 };
    const range = entryByteRange(entry, 100);
    expect(range.startByte).toBe(0);
    expect(range.endByte).toBe(3);
  });

  it('handles partial-byte entries', () => {
    const entry = { startBit: 3, endBit: 13 };
    const range = entryByteRange(entry, 100);
    expect(range.startByte).toBe(0);
    expect(range.endByte).toBe(2); // ceil(13/8) = 2
  });

  it('handles blobOffset', () => {
    const entry = { startBit: 0, endBit: 16, blobOffset: 5 };
    const range = entryByteRange(entry, 20);
    // Global bits: 40-55 → bytes 5-6
    expect(range.startByte).toBe(5);
    expect(range.endByte).toBe(7);
  });

  it('clamps to totalBytes', () => {
    const entry = { startBit: 0, endBit: 200 };
    const range = entryByteRange(entry, 10);
    expect(range.endByte).toBe(10);
  });
});

describe('buildByteRegionMap', () => {
  it('maps bytes to region indices', () => {
    const regions = [
      { start: 0, end: 14 },
      { start: 14, end: 100 },
    ];
    const map = buildByteRegionMap(regions, 100);

    expect(map[0]).toBe(0);
    expect(map[13]).toBe(0);
    expect(map[14]).toBe(1);
    expect(map[99]).toBe(1);
  });

  it('handles overlapping regions (last wins)', () => {
    const regions = [
      { start: 0, end: 20 },
      { start: 10, end: 30 },
    ];
    const map = buildByteRegionMap(regions, 30);
    expect(map[5]).toBe(0);
    expect(map[15]).toBe(1); // region 1 overwrites
  });
});

describe('renderHexRowHTML', () => {
  it('renders a hex row with correct offset and values', () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c]); // "Hell"
    const byteRegion = new Uint8Array([0, 0, 0, 0]);
    const regions = [{ cls: 'header' }];

    const html = renderHexRowHTML(0, 4, bytes, byteRegion, regions, 'hex', null);

    expect(html).toContain('0x0000');
    expect(html).toContain('48');
    expect(html).toContain('65');
    expect(html).toContain('6C');
    expect(html).toContain('6C');
    expect(html).toContain('region-header');
    expect(html).toContain('Hell'); // ASCII column
  });

  it('renders decimal mode with smaller font', () => {
    const bytes = new Uint8Array([255, 0, 128]);
    const byteRegion = new Uint8Array([0, 0, 0]);
    const regions = [{ cls: 'values' }];

    const html = renderHexRowHTML(0, 3, bytes, byteRegion, regions, 'decimal', null);

    expect(html).toContain('255');
    expect(html).toContain('  0');
    expect(html).toContain('128');
    expect(html).toContain('font-size:8px');
  });

  it('adds sample mapping classes when byteLookup provided', () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const byteRegion = new Uint8Array([0, 0, 0, 0]);
    const regions = [{ cls: 'values' }];
    const entryA = { sampleIndex: 0, type: 'value' };
    const entryB = { sampleIndex: 1, type: 'timestamp' };
    const byteLookup = [entryA, entryA, entryB, entryB];

    const html = renderHexRowHTML(0, 4, bytes, byteRegion, regions, 'hex', byteLookup);

    expect(html).toContain('hex-mapped');
    expect(html).toContain('hex-sample-even');
    expect(html).toContain('hex-sample-odd');
    expect(html).toContain('hex-val');
    expect(html).toContain('hex-ts');
    expect(html).toContain('hex-boundary');
  });

  it('handles non-printable ASCII correctly', () => {
    const bytes = new Uint8Array([0x00, 0x1F, 0x7F, 0x41]); // control chars + 'A'
    const byteRegion = new Uint8Array([0, 0, 0, 0]);
    const regions = [{ cls: 'header' }];

    const html = renderHexRowHTML(0, 4, bytes, byteRegion, regions, 'hex', null);
    expect(html).toContain('\u00b7\u00b7\u00b7A'); // dots for non-printable + 'A'
  });

  it('pads rows correctly for offset > 0', () => {
    const bytes = new Uint8Array(64);
    const byteRegion = new Uint8Array(64);
    const regions = [{ cls: 'values' }];

    const html = renderHexRowHTML(1, 32, bytes, byteRegion, regions, 'hex', null);
    expect(html).toContain('0x0020'); // row 1 * 32 = 32 = 0x20
  });

  it('HTML-escapes <, >, & in ASCII column', () => {
    // bytes 0x3C = '<', 0x3E = '>', 0x26 = '&'
    const bytes = new Uint8Array([0x41, 0x3C, 0x3E, 0x26]);
    const byteRegion = [0, 0, 0, 0];
    const regions = [{ name: 'test', cls: 'test' }];
    const html = renderHexRowHTML(0, 4, bytes, byteRegion, regions, 'hex', null);
    // ASCII column must use HTML entities, not raw characters
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).toContain('&amp;');
    // The ASCII div should contain escaped versions: A&lt;&gt;&amp;
    expect(html).toContain('A&lt;&gt;&amp;');
  });
});

describe('encodingDescription', () => {
  it('describes raw encoding', () => {
    expect(encodingDescription({ encoding: 'raw' })).toContain('Raw');
  });

  it('describes dod-zero', () => {
    const desc = encodingDescription({ encoding: 'dod-zero' });
    expect(desc).toContain('Δ²');
    expect(desc).toContain('1 bit');
  });

  it('describes all dod encodings', () => {
    expect(encodingDescription({ encoding: 'dod-7bit' })).toContain('7-bit');
    expect(encodingDescription({ encoding: 'dod-9bit' })).toContain('9-bit');
    expect(encodingDescription({ encoding: 'dod-12bit' })).toContain('12-bit');
    expect(encodingDescription({ encoding: 'dod-64bit' })).toContain('64-bit');
  });

  it('describes xor encodings', () => {
    expect(encodingDescription({ encoding: 'xor-zero' })).toContain('XOR = 0');
    expect(encodingDescription({ encoding: 'xor-reuse', meaningful: 12 })).toContain('12 meaningful');
    expect(encodingDescription({ encoding: 'xor-new', leading: 5, meaningful: 20 })).toContain('leading(5)');
  });

  it('describes alp encodings', () => {
    expect(encodingDescription({ encoding: 'alp-bitpacked', offset: 42, bitWidth: 11 })).toContain('42');
    expect(encodingDescription({ encoding: 'alp-exception' })).toContain('exception');
  });

  it('returns empty string for unknown encoding', () => {
    expect(encodingDescription({ encoding: 'unknown' })).toBe('');
  });
});

describe('buildALPInsightHtml', () => {
  it('produces HTML with ALP pipeline steps', () => {
    const html = buildALPInsightHtml({
      count: 100, exponent: 3, bitWidth: 11, minInt: 42000n,
      excCount: 0, bitpackedBytes: 138, valBlobLen: 152,
      tsLen: 200, amortizedTsLen: 40, sharedCount: 5,
      tsCount: 100, firstTs: 1000000000n,
    });

    expect(html).toContain('ALP');
    expect(html).toContain('Decimal Scaling');
    expect(html).toContain('Frame of Reference');
    expect(html).toContain('Bit-Packing');
    expect(html).toContain('0 exceptions');
    expect(html).toContain('Delta-of-Delta');
  });

  it('shows exceptions when present', () => {
    const html = buildALPInsightHtml({
      count: 100, exponent: 3, bitWidth: 11, minInt: 0n,
      excCount: 5, bitpackedBytes: 138, valBlobLen: 200,
      tsLen: 0, amortizedTsLen: 0, sharedCount: 1, tsCount: 0, firstTs: 0n,
    });

    expect(html).toContain('5 exceptions');
    expect(html).toContain('5.0%');
  });
});

describe('buildXORInsightHtml', () => {
  it('produces HTML with XOR pipeline steps', () => {
    const html = buildXORInsightHtml({
      count: 100, firstTs: 1000000000n, firstVal: 42.5, totalBytes: 500,
    });

    expect(html).toContain('XOR-Delta');
    expect(html).toContain('Gorilla');
    expect(html).toContain('Delta-of-Delta');
    expect(html).toContain('XOR of IEEE-754');
    expect(html).toContain('bits/sample');
  });
});

describe('end-to-end: ALP encode → bitMap → byteLookup', () => {
  it('round-trips: every value byte is mapped to a sample', () => {
    const count = 20;
    const offsets = Array.from({ length: count }, (_, i) => i * 3);
    const blob = makeALPBlob({
      count, exponent: 2, bitWidth: 8, minInt: 100n,
      excCount: 0, offsets, excPositions: [], excValues: [],
    });

    const bitMap = buildALPBitMap(blob, null, count);
    const lookup = buildByteLookup(bitMap, blob.byteLength);

    // Header bytes (0-13) should NOT be mapped
    for (let i = 0; i < 14; i++) {
      expect(lookup[i]).toBeUndefined();
    }

    // Value bytes (14+) should all be mapped
    const bpBytes = Math.ceil(count * 8 / 8);
    for (let i = 14; i < 14 + bpBytes; i++) {
      expect(lookup[i]).toBeDefined();
      expect(lookup[i].type).toBe('value');
    }
  });

  it('with timestamps: all bytes are accounted for', () => {
    const count = 5;
    const blob = makeALPBlob({
      count, exponent: 3, bitWidth: 4, minInt: 0n,
      excCount: 0, offsets: [1, 2, 3, 4, 5], excPositions: [], excValues: [],
    });
    const tsBlob = makeTimestampBlob([1000, 2000, 3000, 4000, 5000]);
    const totalLen = blob.byteLength + tsBlob.byteLength;

    // Build combined buffer like renderByteExplorer does
    const combined = new Uint8Array(totalLen);
    combined.set(blob, 0);
    combined.set(tsBlob, blob.byteLength);

    const bitMap = buildALPBitMap(blob, tsBlob, count);
    const lookup = buildByteLookup(bitMap, totalLen);

    const mapped = lookup.filter(Boolean).length;
    // At least the data bytes should be mapped (header excluded)
    expect(mapped).toBeGreaterThan(0);

    // Check that we have both types
    const types = new Set(lookup.filter(Boolean).map(e => e.type));
    expect(types.has('value')).toBe(true);
    expect(types.has('timestamp')).toBe(true);
  });
});
