//! o11y-codec-rt-core — bit I/O, zigzag, bit-width helpers.
//!
//! Foundation for every codec in the workspace. Provides:
//!   - `BitWriter` / `BitReader`: variable-width bit packing with
//!     byte-aligned fast paths and a single-`u64`-load fast read.
//!   - `zigzag_encode` / `zigzag_decode`: signed → unsigned mapping.
//!   - `bits_needed(v)`: minimum bit width for `v`.
//!   - `extract_packed` / `extract_packed_safe`: random-access reads
//!     into a bit-packed array.
//!
//! No std, no allocator. Each consumer crate brings its own.

#![cfg_attr(not(test), no_std)]

// ── Bit Writer ───────────────────────────────────────────────────────

pub struct BitWriter<'a> {
    pub buf: &'a mut [u8],
    pub byte_pos: usize,
    pub bit_pos: u8, // 0-7, bits consumed in current byte
}

impl<'a> BitWriter<'a> {
    pub fn new(buf: &'a mut [u8]) -> Self {
        // Zero-fill using ptr::write_bytes (compiles to memory.fill on WASM).
        unsafe {
            core::ptr::write_bytes(buf.as_mut_ptr(), 0, buf.len());
        }
        BitWriter {
            buf,
            byte_pos: 0,
            bit_pos: 0,
        }
    }

    #[inline(always)]
    pub fn write_bit(&mut self, bit: u8) {
        if bit != 0 {
            self.buf[self.byte_pos] |= 0x80 >> self.bit_pos;
        }
        self.bit_pos += 1;
        if self.bit_pos == 8 {
            self.bit_pos = 0;
            self.byte_pos += 1;
        }
    }

    #[inline(always)]
    pub fn write_bits(&mut self, value: u64, count: u8) {
        if count == 0 {
            return;
        }
        // Fast path: byte-aligned writes for 8, 16, 32, 64 bits.
        if self.bit_pos == 0 {
            match count {
                64 => {
                    let bytes = value.to_be_bytes();
                    self.buf[self.byte_pos..self.byte_pos + 8].copy_from_slice(&bytes);
                    self.byte_pos += 8;
                    return;
                }
                16 => {
                    let bytes = (value as u16).to_be_bytes();
                    self.buf[self.byte_pos..self.byte_pos + 2].copy_from_slice(&bytes);
                    self.byte_pos += 2;
                    return;
                }
                8 => {
                    self.buf[self.byte_pos] = value as u8;
                    self.byte_pos += 1;
                    return;
                }
                _ => {}
            }
        }

        // Medium path: if count <= remaining bits in current byte, pack directly.
        let remaining = 8 - self.bit_pos;
        if count <= remaining {
            self.buf[self.byte_pos] |= (value as u8) << (remaining - count);
            self.bit_pos += count;
            if self.bit_pos == 8 {
                self.bit_pos = 0;
                self.byte_pos += 1;
            }
            return;
        }

        // General path: fill current byte, write whole bytes, handle remainder.
        let mut bits_left = count;

        // Fill remainder of current byte.
        if self.bit_pos > 0 {
            let fill = remaining;
            self.buf[self.byte_pos] |= (value >> (bits_left - fill)) as u8;
            bits_left -= fill;
            self.byte_pos += 1;
            self.bit_pos = 0;
        }

        // Write whole bytes.
        while bits_left >= 8 {
            bits_left -= 8;
            self.buf[self.byte_pos] = (value >> bits_left) as u8;
            self.byte_pos += 1;
        }

        // Write remaining bits.
        if bits_left > 0 {
            self.buf[self.byte_pos] =
                ((value & ((1u64 << bits_left) - 1)) << (8 - bits_left)) as u8;
            self.bit_pos = bits_left;
        }
    }

    pub fn bytes_written(&self) -> usize {
        if self.bit_pos > 0 {
            self.byte_pos + 1
        } else {
            self.byte_pos
        }
    }
}

// ── Bit Reader ───────────────────────────────────────────────────────

pub struct BitReader<'a> {
    pub buf: &'a [u8],
    pub byte_pos: usize,
    pub bit_pos: u8,
}

impl<'a> BitReader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        BitReader {
            buf,
            byte_pos: 0,
            bit_pos: 0,
        }
    }

    #[inline(always)]
    pub fn read_bit(&mut self) -> u8 {
        let byte = self.buf[self.byte_pos];
        let bit = (byte >> (7 - self.bit_pos)) & 1;
        self.bit_pos += 1;
        if self.bit_pos == 8 {
            self.bit_pos = 0;
            self.byte_pos += 1;
        }
        bit
    }

    #[inline(always)]
    pub fn read_bits(&mut self, count: u8) -> u64 {
        // Fast path: load a single u64 and extract bits with 2 shifts.
        // Works for count ≤ 57 (max bit_pos=7 + count=57 = 64 bits in one u64).
        if count <= 57 && self.byte_pos + 8 <= self.buf.len() {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&self.buf[self.byte_pos..self.byte_pos + 8]);
            let raw = u64::from_be_bytes(bytes);
            let value = (raw << self.bit_pos) >> (64 - count);
            let total = self.bit_pos as usize + count as usize;
            self.byte_pos += total / 8;
            self.bit_pos = (total % 8) as u8;
            return value;
        }

        // Medium path: fits within current byte.
        let remaining = 8 - self.bit_pos;
        if count <= remaining {
            let val = ((self.buf[self.byte_pos] >> (remaining - count)) as u64)
                & ((1u64 << count) - 1);
            self.bit_pos += count;
            if self.bit_pos == 8 {
                self.bit_pos = 0;
                self.byte_pos += 1;
            }
            return val;
        }

        // General path: read across byte boundaries (count > 57 or near end of buffer).
        let mut value: u64 = 0;
        let mut bits_left = count;

        if self.bit_pos > 0 {
            let fill = remaining;
            value = (self.buf[self.byte_pos] as u64) & ((1u64 << fill) - 1);
            bits_left -= fill;
            self.byte_pos += 1;
            self.bit_pos = 0;
        }

        while bits_left >= 8 {
            value = (value << 8) | (self.buf[self.byte_pos] as u64);
            self.byte_pos += 1;
            bits_left -= 8;
        }

        if bits_left > 0 {
            value = (value << bits_left)
                | ((self.buf[self.byte_pos] >> (8 - bits_left)) as u64
                    & ((1u64 << bits_left) - 1));
            self.bit_pos = bits_left;
        }

        value
    }
}

// ── Zigzag encoding ──────────────────────────────────────────────────

#[inline(always)]
pub fn zigzag_encode(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

#[inline(always)]
pub fn zigzag_decode(v: u64) -> i64 {
    ((v >> 1) as i64) ^ (-((v & 1) as i64))
}

// ── Bit-width helpers ────────────────────────────────────────────────

#[inline(always)]
pub fn bits_needed(val: u64) -> u8 {
    if val == 0 {
        return 0;
    }
    64 - val.leading_zeros() as u8
}

/// Direct-index bit extraction: reads `bw` bits starting at bit `i * bw`
/// from a packed byte buffer. No sequential state — each call is independent.
/// Requires: bw ≤ 57 and buf has ≥ 8 bytes past the start of each value.
#[inline(always)]
pub fn extract_packed(buf: &[u8], i: usize, bw: u8) -> u64 {
    let bit_offset = i * bw as usize;
    let byte_pos = bit_offset >> 3;
    let bit_pos = (bit_offset & 7) as u8;
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&buf[byte_pos..byte_pos + 8]);
    let raw = u64::from_be_bytes(bytes);
    (raw << bit_pos) >> (64 - bw)
}

/// Same as extract_packed but safe near end-of-buffer: pads with zeros.
#[inline(always)]
pub fn extract_packed_safe(buf: &[u8], i: usize, bw: u8) -> u64 {
    let bit_offset = i * bw as usize;
    let byte_pos = bit_offset >> 3;
    let bit_pos = (bit_offset & 7) as u8;
    let mut bytes = [0u8; 8];
    let avail = buf.len().saturating_sub(byte_pos).min(8);
    bytes[..avail].copy_from_slice(&buf[byte_pos..byte_pos + avail]);
    let raw = u64::from_be_bytes(bytes);
    (raw << bit_pos) >> (64 - bw)
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── BitWriter tests ──────────────────────────────────────────────

    #[test]
    fn bitwriter_single_bits() {
        let mut buf = [0u8; 4];
        {
            let mut w = BitWriter::new(&mut buf);
            w.write_bit(1);
            w.write_bit(0);
            w.write_bit(1);
            assert_eq!(w.bytes_written(), 1);
        }
        assert_eq!(buf[0], 0b10100000);
    }

    #[test]
    fn bitwriter_aligned_64() {
        let mut buf = [0u8; 16];
        let mut w = BitWriter::new(&mut buf);
        w.write_bits(0xDEADBEEF_CAFEBABE, 64);
        assert_eq!(w.bytes_written(), 8);
        assert_eq!(u64::from_be_bytes(buf[..8].try_into().unwrap()), 0xDEADBEEF_CAFEBABE);
    }

    #[test]
    fn bitwriter_aligned_16_and_8() {
        let mut buf = [0u8; 8];
        let mut w = BitWriter::new(&mut buf);
        w.write_bits(0x1234, 16);
        w.write_bits(0xAB, 8);
        assert_eq!(w.bytes_written(), 3);
        assert_eq!(&buf[..3], &[0x12, 0x34, 0xAB]);
    }

    #[test]
    fn bitwriter_cross_byte_boundary() {
        let mut buf = [0u8; 4];
        {
            let mut w = BitWriter::new(&mut buf);
            w.write_bits(0b101, 3);      // 3 bits
            w.write_bits(0b11010, 5);    // 5 bits → crosses byte
            w.write_bits(0b1111, 4);     // 4 more bits
            assert_eq!(w.bytes_written(), 2);
        }
        // byte 0: 101_11010 = 0xBA
        // byte 1: 1111_0000 = 0xF0
        assert_eq!(buf[0], 0xBA);
        assert_eq!(buf[1], 0xF0);
    }

    #[test]
    fn bitwriter_zero_width() {
        let mut buf = [0u8; 4];
        let mut w = BitWriter::new(&mut buf);
        w.write_bits(42, 0); // should write nothing
        assert_eq!(w.bytes_written(), 0);
    }

    #[test]
    fn bitwriter_fill_exactly() {
        let mut buf = [0u8; 1];
        let mut w = BitWriter::new(&mut buf);
        w.write_bits(0xFF, 8);
        assert_eq!(w.bytes_written(), 1);
        assert_eq!(buf[0], 0xFF);
    }

    // ── BitReader tests ──────────────────────────────────────────────

    #[test]
    fn bitreader_single_bits() {
        let buf = [0b10100000u8];
        let mut r = BitReader::new(&buf);
        assert_eq!(r.read_bit(), 1);
        assert_eq!(r.read_bit(), 0);
        assert_eq!(r.read_bit(), 1);
        assert_eq!(r.read_bit(), 0);
    }

    #[test]
    fn bitreader_aligned_64() {
        let val: u64 = 0xDEADBEEF_CAFEBABE;
        let buf = val.to_be_bytes();
        let mut r = BitReader::new(&buf);
        assert_eq!(r.read_bits(64), val);
    }

    #[test]
    fn bitreader_cross_byte() {
        let buf = [0xBA, 0xF0];
        let mut r = BitReader::new(&buf);
        assert_eq!(r.read_bits(3), 0b101);
        assert_eq!(r.read_bits(5), 0b11010);
        assert_eq!(r.read_bits(4), 0b1111);
    }

    #[test]
    fn bitwriter_reader_roundtrip_mixed() {
        let mut buf = [0u8; 64];
        let mut w = BitWriter::new(&mut buf);
        w.write_bits(42, 7);
        w.write_bits(u64::MAX, 64);
        w.write_bits(0, 1);
        w.write_bits(0b10101, 5);
        w.write_bits(1234567890, 31);
        let written = w.bytes_written();

        let mut r = BitReader::new(&buf[..written]);
        assert_eq!(r.read_bits(7), 42);
        assert_eq!(r.read_bits(64), u64::MAX);
        assert_eq!(r.read_bits(1), 0);
        assert_eq!(r.read_bits(5), 0b10101);
        assert_eq!(r.read_bits(31), 1234567890);
    }

    #[test]
    fn bitwriter_reader_roundtrip_various_widths() {
        // Sum of bits 1..64 = 2080, need 260 bytes.
        let mut buf = [0u8; 512];
        let mut w = BitWriter::new(&mut buf);
        // Write values at every width from 1 to 64
        for width in 1u8..=64 {
            let val = if width == 64 { u64::MAX } else { (1u64 << width) - 1 };
            w.write_bits(val, width);
        }
        let written = w.bytes_written();

        let mut r = BitReader::new(&buf[..written]);
        for width in 1u8..=64 {
            let expected = if width == 64 { u64::MAX } else { (1u64 << width) - 1 };
            let actual = r.read_bits(width);
            assert_eq!(actual, expected, "width={width}");
        }
    }

    // ── Zigzag tests ─────────────────────────────────────────────────

    #[test]
    fn zigzag_roundtrip_boundary_values() {
        let cases: &[i64] = &[
            0, 1, -1,
            62, -62, 63, -63,
            64, -64,
            254, -254, 255, -255,
            256, -256,
            2046, -2046, 2047, -2047,
            2048, -2048,
            i64::MAX, i64::MIN + 1,
        ];
        for &v in cases {
            let encoded = zigzag_encode(v);
            let decoded = zigzag_decode(encoded);
            assert_eq!(decoded, v, "zigzag roundtrip failed for {v}");
        }
    }

    #[test]
    fn zigzag_boundary_bit_widths() {
        // 7-bit bucket: |dod| ≤ 63 → zigzag ≤ 127
        for v in -63i64..=63 {
            assert!(zigzag_encode(v) <= 127, "zigzag({v}) should fit in 7 bits");
        }
        assert!(zigzag_encode(64) > 127, "64 must overflow 7 bits");

        // 9-bit bucket: |dod| ≤ 255 → zigzag ≤ 511
        for v in -255i64..=255 {
            assert!(zigzag_encode(v) <= 511, "zigzag({v}) should fit in 9 bits");
        }
        assert!(zigzag_encode(256) > 511, "256 must overflow 9 bits");

        // 12-bit bucket: |dod| ≤ 2047 → zigzag ≤ 4095
        for v in -2047i64..=2047 {
            assert!(zigzag_encode(v) <= 4095, "zigzag({v}) should fit in 12 bits");
        }
        assert!(zigzag_encode(2048) > 4095, "2048 must overflow 12 bits");
    }

    // ── bits_needed tests ────────────────────────────────────────────

    #[test]
    fn bits_needed_values() {
        assert_eq!(bits_needed(0), 0);
        assert_eq!(bits_needed(1), 1);
        assert_eq!(bits_needed(2), 2);
        assert_eq!(bits_needed(3), 2);
        assert_eq!(bits_needed(255), 8);
        assert_eq!(bits_needed(256), 9);
        assert_eq!(bits_needed(u64::MAX), 64);
    }

    // ── extract_packed tests ─────────────────────────────────────────

    #[test]
    fn extract_packed_roundtrip() {
        // Pack 10 values at bw=5, then extract each one.
        let bw: u8 = 5;
        let vals: [u64; 10] = [0, 1, 15, 31, 16, 7, 3, 0, 30, 28];
        let mut buf = [0u8; 16]; // 10*5 = 50 bits = 7 bytes, plus 8 padding
        {
            let mut w = BitWriter::new(&mut buf);
            for &v in &vals {
                w.write_bits(v, bw);
            }
        }
        for (i, &expected) in vals.iter().enumerate() {
            let got = extract_packed(&buf, i, bw);
            assert_eq!(got, expected, "extract_packed index={i}");
        }
    }

    #[test]
    fn extract_packed_safe_near_end() {
        // Write 3 values at bw=10 into a small buffer.
        let bw: u8 = 10;
        let vals: [u64; 3] = [511, 0, 1023];
        let mut buf = [0u8; 12]; // 30 bits = 4 bytes, plus some padding
        {
            let mut w = BitWriter::new(&mut buf);
            for &v in &vals {
                w.write_bits(v, bw);
            }
        }
        for (i, &expected) in vals.iter().enumerate() {
            let got = extract_packed_safe(&buf, i, bw);
            assert_eq!(got, expected, "extract_packed_safe index={i}");
        }
    }

    #[test]
    fn extract_packed_safe_minimal_buffer() {
        // Single value at bw=3 in a 1-byte buffer.
        let buf = [0b10100000u8];
        let got = extract_packed_safe(&buf, 0, 3);
        assert_eq!(got, 0b101);
    }
}
