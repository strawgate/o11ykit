// ── Timestamp-only codec: delta-of-delta encoding ───────────────────
//
// Encodes/decodes timestamps using delta-of-delta with 4-tier prefix:
//   0         → dod == 0
//   10 + 7b   → |dod| ≤ 63    (zigzag ≤ 127)
//   110 + 9b  → |dod| ≤ 255   (zigzag ≤ 511)
//   1110 + 12b → |dod| ≤ 2047  (zigzag ≤ 4095)
//   1111 + 64b → all other values

use crate::bitio::{BitReader, BitWriter, zigzag_decode, zigzag_encode};

/// Encode timestamps only using delta-of-delta encoding.
/// Layout: 16-bit count + 64-bit first timestamp + delta-of-delta bitstream.
#[no_mangle]
pub extern "C" fn encodeTimestamps(
    ts_ptr: *const i64,
    count: u32,
    out_ptr: *mut u8,
    out_cap: u32,
) -> u32 {
    let n = count as usize;
    // Header serializes `n` as 16 bits — reject anything that would wrap.
    if n == 0 || n > u16::MAX as usize {
        return 0;
    }
    // 10-byte header (16-bit count + 64-bit first timestamp) is the minimum
    // footprint. Tiny buffers would make BitWriter panic on the header writes.
    if (out_cap as usize) < 10 {
        return 0;
    }

    let ts = unsafe { core::slice::from_raw_parts(ts_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };

    let mut w = BitWriter::new(out);

    w.write_bits(n as u64, 16);
    w.write_bits(ts[0] as u64, 64);

    if n == 1 {
        return w.bytes_written() as u32;
    }

    let mut prev_ts = ts[0];
    let mut prev_delta: i64 = 0;

    for i in 1..n {
        let cur_ts = ts[i];
        let delta = cur_ts.wrapping_sub(prev_ts);
        let dod = delta.wrapping_sub(prev_delta);

        if dod == 0 {
            w.write_bit(0);
        } else {
            let abs_dod = if dod < 0 { dod.wrapping_neg() } else { dod };
            if abs_dod <= 63 {
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 7);
            } else if abs_dod <= 255 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 9);
            } else if abs_dod <= 2047 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 12);
            } else {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bits(dod as u64, 64);
            }
        }

        prev_delta = delta;
        prev_ts = cur_ts;
    }

    w.bytes_written() as u32
}

/// Decode timestamps from delta-of-delta encoding.
/// Returns the number of timestamps decoded.
#[no_mangle]
pub extern "C" fn decodeTimestamps(
    in_ptr: *const u8,
    in_len: u32,
    ts_ptr: *mut i64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let ts_out = unsafe { core::slice::from_raw_parts_mut(ts_ptr, max_samples as usize) };
    decode_timestamps_inner(input, ts_out) as u32
}

/// Internal: decode timestamps into a buffer. Returns count.
pub(crate) fn decode_timestamps_inner(input: &[u8], ts_out: &mut [i64]) -> usize {
    // Header is 10 bytes: 16-bit count + 64-bit first timestamp.
    if input.len() < 10 {
        return 0;
    }
    let mut r = BitReader::new(input);
    let n = r.read_bits(16) as usize;
    if n == 0 || n > ts_out.len() {
        return 0;
    }

    ts_out[0] = r.read_bits(64) as i64;
    if n == 1 {
        return 1;
    }

    let mut prev_ts = ts_out[0];
    let mut prev_delta: i64 = 0;

    for i in 1..n {
        let dod: i64;
        if r.read_bit() == 0 {
            dod = 0;
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(7));
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(9));
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(12));
        } else {
            dod = r.read_bits(64) as i64;
        }

        let delta = prev_delta.wrapping_add(dod);
        let cur_ts = prev_ts.wrapping_add(delta);
        ts_out[i] = cur_ts;
        prev_delta = delta;
        prev_ts = cur_ts;
    }
    n
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    fn roundtrip(ts: &[i64]) {
        let mut buf = [0u8; 4096];
        let mut decoded = [0i64; 2048];

        let bytes = encodeTimestamps(ts.as_ptr(), ts.len() as u32, buf.as_mut_ptr(), 4096);
        assert!(bytes > 0, "encode failed for input {:?}", ts);

        let count = decode_timestamps_inner(&buf[..bytes as usize], &mut decoded);
        assert_eq!(count, ts.len(), "count mismatch");
        assert_eq!(&decoded[..count], ts, "timestamps mismatch");
    }

    #[test]
    fn single_timestamp() {
        roundtrip(&[1_700_000_000_000i64]);
    }

    #[test]
    fn two_timestamps() {
        roundtrip(&[1000, 2000]);
    }

    #[test]
    fn regular_15s_intervals() {
        let ts: std::vec::Vec<i64> = (0..100).map(|i| 1_000_000 + i * 15_000).collect();
        roundtrip(&ts);
    }

    #[test]
    fn dod_tier_boundaries() {
        let dods: &[i64] = &[
            0, 1, -1,
            63, -63, 64, -64,
            255, -255, 256, -256,
            2047, -2047, 2048, -2048,
            10000, -10000,
        ];
        for &target_dod in dods {
            let ts: [i64; 3] = [1000, 1100, 1200 + target_dod];
            roundtrip(&ts);
        }
    }

    #[test]
    fn nanosecond_otel_timestamps() {
        let ts: [i64; 6] = [
            1_700_000_000_000_000_000,
            1_700_000_000_010_000_000,  // +10ms
            1_700_000_000_020_000_064,  // dod=64
            1_700_000_000_030_000_320,  // dod=256
            1_700_000_000_040_002_368,  // dod=2048
            1_700_000_000_040_002_368,  // dod=−10_002_368 (large fallback)
        ];
        roundtrip(&ts);
    }

    #[test]
    fn identical_timestamps() {
        let ts = [42i64; 10];
        roundtrip(&ts);
    }

    #[test]
    fn large_gap() {
        let ts = [0i64, 1_000_000_000_000];
        roundtrip(&ts);
    }

    #[test]
    fn monotonic_decreasing() {
        let ts: std::vec::Vec<i64> = (0..50).rev().map(|i| i * 1000).collect();
        roundtrip(&ts);
    }

    #[test]
    fn irregular_intervals() {
        let ts = [100i64, 200, 250, 500, 501, 502, 600, 10000, 10001];
        roundtrip(&ts);
    }

    #[test]
    fn max_chunk_size() {
        let ts: std::vec::Vec<i64> = (0..2048).map(|i| 1000 + i * 15).collect();
        roundtrip(&ts);
    }
}
