// ── XOR-Delta (Gorilla) codec ───────────────────────────────────────
//
// Encodes timestamps + values (or values only) using:
//   - Timestamps: delta-of-delta with 4-tier prefix coding
//   - Values: XOR with leading/trailing zero tracking
//
// Reference: Pelkonen et al., VLDB 2015.

use crate::bitio::{BitReader, BitWriter, zigzag_decode, zigzag_encode};

// ── Combined chunk encode/decode ─────────────────────────────────────

/// Encode timestamps + values into a compressed chunk.
/// Layout: 16-bit count, 64-bit first ts, 64-bit first value, then
/// interleaved DoD timestamps + XOR values.
#[no_mangle]
pub extern "C" fn encodeChunk(
    ts_ptr: *const i64,
    val_ptr: *const f64,
    count: u32,
    out_ptr: *mut u8,
    out_cap: u32,
) -> u32 {
    let n = count as usize;
    // Count is serialized as a 16-bit header field — reject larger inputs
    // so decode cannot reconstruct a truncated length.
    if n == 0 || n > u16::MAX as usize {
        return 0;
    }

    let ts = unsafe { core::slice::from_raw_parts(ts_ptr, n) };
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };

    let mut w = BitWriter::new(out);

    w.write_bits(n as u64, 16);
    w.write_bits(ts[0] as u64, 64);
    w.write_bits(f64::to_bits(vals[0]), 64);

    if n == 1 {
        return w.bytes_written() as u32;
    }

    let mut prev_ts = ts[0];
    let mut prev_delta: i64 = 0;
    let mut prev_val_bits = f64::to_bits(vals[0]);
    let mut prev_leading: u32 = 64;
    let mut prev_trailing: u32 = 0;

    for i in 1..n {
        let cur_ts = ts[i];
        let delta = cur_ts.wrapping_sub(prev_ts);
        let dod = delta.wrapping_sub(prev_delta);

        // Timestamp: delta-of-delta
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

        // Value: XOR encoding
        let val_bits = f64::to_bits(vals[i]);
        let xor = prev_val_bits ^ val_bits;

        if xor == 0 {
            w.write_bit(0);
        } else {
            let leading = xor.leading_zeros();
            let trailing = xor.trailing_zeros();
            let meaningful = 64 - leading - trailing;

            if leading >= prev_leading && trailing >= prev_trailing {
                w.write_bit(1);
                w.write_bit(0);
                let prev_meaningful = 64 - prev_leading - prev_trailing;
                w.write_bits(xor >> prev_trailing, prev_meaningful as u8);
            } else {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bits(leading as u64, 6);
                w.write_bits((meaningful - 1) as u64, 6);
                w.write_bits(xor >> trailing, meaningful as u8);
                prev_leading = leading;
                prev_trailing = trailing;
            }
        }

        prev_val_bits = val_bits;
    }

    w.bytes_written() as u32
}

/// Decode a compressed chunk into timestamps + values.
#[no_mangle]
pub extern "C" fn decodeChunk(
    in_ptr: *const u8,
    in_len: u32,
    ts_ptr: *mut i64,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    // Header is 18 bytes: 16-bit count + 64-bit ts0 + 64-bit val0.
    if input.len() < 18 {
        return 0;
    }
    let mut r = BitReader::new(input);

    let n = r.read_bits(16) as usize;
    // Reject counts that exceed the caller-allocated output capacity,
    // otherwise `from_raw_parts_mut` would produce an oversized slice
    // pointing past the caller's buffer.
    if n == 0 || n > max_samples as usize {
        return 0;
    }

    let ts_out = unsafe { core::slice::from_raw_parts_mut(ts_ptr, n) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, n) };

    ts_out[0] = r.read_bits(64) as i64;
    val_out[0] = f64::from_bits(r.read_bits(64));

    if n == 1 {
        return 1;
    }

    let mut prev_ts = ts_out[0];
    let mut prev_delta: i64 = 0;
    let mut prev_val_bits = f64::to_bits(val_out[0]);
    let mut prev_leading: u32 = 0;
    let mut prev_trailing: u32 = 0;

    for i in 1..n {
        // Timestamp: delta-of-delta
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

        // Value: XOR decoding
        if r.read_bit() == 0 {
            val_out[i] = f64::from_bits(prev_val_bits);
        } else if r.read_bit() == 0 {
            let meaningful = 64 - prev_leading - prev_trailing;
            let shifted = r.read_bits(meaningful as u8);
            let xor = shifted << prev_trailing;
            prev_val_bits ^= xor;
            val_out[i] = f64::from_bits(prev_val_bits);
        } else {
            let leading = r.read_bits(6) as u32;
            let meaningful_m1 = r.read_bits(6) as u32;
            let meaningful = meaningful_m1 + 1;
            let trailing = 64 - leading - meaningful;
            let shifted = r.read_bits(meaningful as u8);
            let xor = shifted << trailing;
            prev_val_bits ^= xor;
            val_out[i] = f64::from_bits(prev_val_bits);
            prev_leading = leading;
            prev_trailing = trailing;
        }
    }

    n as u32
}

// ── Block statistics helper ──────────────────────────────────────────

/// Compute block stats from a values slice and write to 8-element f64 buffer.
/// Stats: [min, max, sum, count, first, last, sum_of_squares, reset_count]
pub(crate) fn compute_stats(vals: &[f64], stats: &mut [f64]) -> u32 {
    let n = vals.len();
    let mut min_v = vals[0];
    let mut max_v = vals[0];
    let mut sum = vals[0];
    let mut sum_sq = vals[0] * vals[0];
    let mut reset_count: u32 = 0;

    for i in 1..n {
        let v = vals[i];
        if v < min_v {
            min_v = v;
        }
        if v > max_v {
            max_v = v;
        }
        sum += v;
        sum_sq += v * v;
        if v < vals[i - 1] {
            reset_count += 1;
        }
    }

    stats[0] = min_v;
    stats[1] = max_v;
    stats[2] = sum;
    stats[3] = n as f64;
    stats[4] = vals[0];
    stats[5] = vals[n - 1];
    stats[6] = sum_sq;
    stats[7] = reset_count as f64;
    reset_count
}

// ── Encode with block stats ──────────────────────────────────────────

/// Encode timestamps + values with block stats. Stats written to stats_ptr.
#[no_mangle]
pub extern "C" fn encodeChunkWithStats(
    ts_ptr: *const i64,
    val_ptr: *const f64,
    count: u32,
    out_ptr: *mut u8,
    out_cap: u32,
    stats_ptr: *mut f64,
) -> u32 {
    let n = count as usize;
    if n == 0 {
        return 0;
    }

    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let stats = unsafe { core::slice::from_raw_parts_mut(stats_ptr, 8) };
    compute_stats(vals, stats);

    encodeChunk(ts_ptr, val_ptr, count, out_ptr, out_cap)
}

// ── Values-only encode/decode ────────────────────────────────────────

/// Encode values only (no timestamps) using XOR encoding.
/// Layout: 16-bit count + 64-bit first value + XOR-encoded subsequent values.
#[no_mangle]
pub extern "C" fn encodeValues(
    val_ptr: *const f64,
    count: u32,
    out_ptr: *mut u8,
    out_cap: u32,
) -> u32 {
    let n = count as usize;
    if n == 0 {
        return 0;
    }
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };
    encode_values_inner(vals, out) as u32
}

/// Decode values-only encoding back to Float64 array.
#[no_mangle]
pub extern "C" fn decodeValues(
    in_ptr: *const u8,
    in_len: u32,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, max_samples as usize) };
    decode_values_inner(input, val_out) as u32
}

/// Encode values only AND compute block stats in one pass.
#[no_mangle]
pub extern "C" fn encodeValuesWithStats(
    val_ptr: *const f64,
    count: u32,
    out_ptr: *mut u8,
    out_cap: u32,
    stats_ptr: *mut f64,
) -> u32 {
    let n = count as usize;
    if n == 0 {
        return 0;
    }

    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let stats = unsafe { core::slice::from_raw_parts_mut(stats_ptr, 8) };
    compute_stats(vals, stats);

    encodeValues(val_ptr, count, out_ptr, out_cap)
}

/// Internal: encode a single values array. Shared by encodeValues and batch.
pub(crate) fn encode_values_inner(vals: &[f64], out: &mut [u8]) -> usize {
    let n = vals.len();
    // Same 16-bit count guard as encodeChunk.
    if n == 0 || n > u16::MAX as usize {
        return 0;
    }

    let mut w = BitWriter::new(out);

    w.write_bits(n as u64, 16);
    w.write_bits(f64::to_bits(vals[0]), 64);

    if n == 1 {
        return w.bytes_written();
    }

    let mut prev_val_bits = f64::to_bits(vals[0]);
    let mut prev_leading: u32 = 64;
    let mut prev_trailing: u32 = 0;

    for i in 1..n {
        let val_bits = f64::to_bits(vals[i]);
        let xor = prev_val_bits ^ val_bits;

        if xor == 0 {
            w.write_bit(0);
        } else {
            let leading = xor.leading_zeros();
            let trailing = xor.trailing_zeros();
            let meaningful = 64 - leading - trailing;

            if leading >= prev_leading && trailing >= prev_trailing {
                w.write_bit(1);
                w.write_bit(0);
                let prev_meaningful = 64 - prev_leading - prev_trailing;
                w.write_bits(xor >> prev_trailing, prev_meaningful as u8);
            } else {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bits(leading as u64, 6);
                w.write_bits((meaningful - 1) as u64, 6);
                w.write_bits(xor >> trailing, meaningful as u8);
                prev_leading = leading;
                prev_trailing = trailing;
            }
        }

        prev_val_bits = val_bits;
    }

    w.bytes_written()
}

/// Internal: decode XOR values from a compressed blob.
pub(crate) fn decode_values_inner(input: &[u8], val_out: &mut [f64]) -> usize {
    // Header is 10 bytes: 16-bit count + 64-bit first value.
    if input.len() < 10 {
        return 0;
    }
    let mut r = BitReader::new(input);
    let n = r.read_bits(16) as usize;
    if n == 0 || n > val_out.len() {
        return 0;
    }

    val_out[0] = f64::from_bits(r.read_bits(64));
    if n == 1 {
        return 1;
    }

    let mut prev_val_bits = f64::to_bits(val_out[0]);
    let mut prev_leading: u32 = 0;
    let mut prev_trailing: u32 = 0;

    for i in 1..n {
        if r.read_bit() == 0 {
            val_out[i] = f64::from_bits(prev_val_bits);
        } else if r.read_bit() == 0 {
            let meaningful = 64 - prev_leading - prev_trailing;
            let shifted = r.read_bits(meaningful as u8);
            let xor = shifted << prev_trailing;
            prev_val_bits ^= xor;
            val_out[i] = f64::from_bits(prev_val_bits);
        } else {
            let leading = r.read_bits(6) as u32;
            let meaningful_m1 = r.read_bits(6) as u32;
            let meaningful = meaningful_m1 + 1;
            let trailing = 64 - leading - meaningful;
            let shifted = r.read_bits(meaningful as u8);
            let xor = shifted << trailing;
            prev_val_bits ^= xor;
            val_out[i] = f64::from_bits(prev_val_bits);
            prev_leading = leading;
            prev_trailing = trailing;
        }
    }
    n
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    fn chunk_roundtrip(ts: &[i64], vals: &[f64]) {
        let n = ts.len();
        assert_eq!(n, vals.len());
        let mut buf = [0u8; 8192];
        let mut dec_ts = [0i64; 2048];
        let mut dec_vals = [0f64; 2048];

        let bytes = encodeChunk(
            ts.as_ptr(), vals.as_ptr(), n as u32, buf.as_mut_ptr(), 8192,
        );
        assert!(bytes > 0, "chunk encode failed");

        let count = decodeChunk(
            buf.as_ptr(), bytes, dec_ts.as_mut_ptr(), dec_vals.as_mut_ptr(), n as u32,
        );
        assert_eq!(count, n as u32);
        assert_eq!(&dec_ts[..n], ts);
        assert_eq!(&dec_vals[..n], vals);
    }

    fn values_roundtrip(vals: &[f64]) {
        let n = vals.len();
        let mut buf = [0u8; 8192];
        let mut decoded = [0f64; 2048];

        let bytes = encodeValues(
            vals.as_ptr(), n as u32, buf.as_mut_ptr(), 8192,
        );
        assert!(bytes > 0, "values encode failed");

        let count = decodeValues(buf.as_ptr(), bytes, decoded.as_mut_ptr(), n as u32);
        assert_eq!(count, n as u32);
        assert_eq!(&decoded[..n], vals);
    }

    #[test]
    fn chunk_roundtrip_boundary_dods() {
        let dods: &[i64] = &[63, -63, 64, -64, 255, -255, 256, -256, 2047, -2047, 2048, -2048];
        for &target_dod in dods {
            let ts: [i64; 3] = [1000, 1100, 1200 + target_dod];
            let vals: [f64; 3] = [1.0, 2.0, 3.0];
            chunk_roundtrip(&ts, &vals);
        }
    }

    #[test]
    fn chunk_single_sample() {
        chunk_roundtrip(&[42], &[3.14]);
    }

    #[test]
    fn chunk_constant_values() {
        let ts: [i64; 5] = [100, 200, 300, 400, 500];
        let vals = [42.0f64; 5];
        chunk_roundtrip(&ts, &vals);
    }

    #[test]
    fn values_only_roundtrip() {
        let vals: [f64; 5] = [1.0, 1.5, 2.0, 1.5, 1.0];
        values_roundtrip(&vals);
    }

    #[test]
    fn values_single() {
        values_roundtrip(&[99.99]);
    }

    #[test]
    fn values_constant() {
        let vals = [0.0f64; 100];
        values_roundtrip(&vals);
    }

    #[test]
    fn values_special_floats() {
        // NaN and Inf should roundtrip through XOR encoding.
        let vals = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0, f64::MIN, f64::MAX];
        let mut buf = [0u8; 1024];
        let mut decoded = [0f64; 8];

        let bytes = encodeValues(vals.as_ptr(), 6, buf.as_mut_ptr(), 1024);
        assert!(bytes > 0);

        let count = decodeValues(buf.as_ptr(), bytes, decoded.as_mut_ptr(), 8);
        assert_eq!(count, 6);

        // NaN doesn't equal itself, check bit pattern.
        assert!(decoded[0].is_nan());
        assert_eq!(decoded[1], f64::INFINITY);
        assert_eq!(decoded[2], f64::NEG_INFINITY);
        assert!(decoded[3].is_sign_negative() && decoded[3] == 0.0); // -0.0
        assert_eq!(decoded[4], f64::MIN);
        assert_eq!(decoded[5], f64::MAX);
    }

    #[test]
    fn values_monotonic_counter() {
        let vals: std::vec::Vec<f64> = (0..640).map(|i| i as f64 * 100.0).collect();
        values_roundtrip(&vals);
    }

    #[test]
    fn stats_computation() {
        let vals: [f64; 5] = [3.0, 1.0, 4.0, 1.0, 5.0];
        let mut stats = [0.0f64; 8];
        let reset_count = compute_stats(&vals, &mut stats);

        assert_eq!(stats[0], 1.0);       // min
        assert_eq!(stats[1], 5.0);       // max
        assert_eq!(stats[2], 14.0);      // sum
        assert_eq!(stats[3], 5.0);       // count
        assert_eq!(stats[4], 3.0);       // first
        assert_eq!(stats[5], 5.0);       // last
        // sum_of_squares: 9+1+16+1+25 = 52
        assert_eq!(stats[6], 52.0);
        assert_eq!(stats[7], 2.0);       // reset_count (3→1, 4→1)
        assert_eq!(reset_count, 2);
    }

    #[test]
    fn encode_with_stats_roundtrip() {
        let ts: [i64; 4] = [100, 200, 300, 400];
        let vals: [f64; 4] = [10.0, 20.0, 15.0, 25.0];
        let mut buf = [0u8; 1024];
        let mut stats = [0.0f64; 8];

        let bytes = encodeChunkWithStats(
            ts.as_ptr(), vals.as_ptr(), 4, buf.as_mut_ptr(), 1024, stats.as_mut_ptr(),
        );
        assert!(bytes > 0);
        assert_eq!(stats[0], 10.0); // min
        assert_eq!(stats[1], 25.0); // max
        assert_eq!(stats[7], 1.0);  // reset_count

        let mut dec_ts = [0i64; 4];
        let mut dec_vals = [0f64; 4];
        let count = decodeChunk(buf.as_ptr(), bytes, dec_ts.as_mut_ptr(), dec_vals.as_mut_ptr(), 4);
        assert_eq!(count, 4);
        assert_eq!(dec_ts, ts);
        assert_eq!(dec_vals, vals);
    }

    #[test]
    fn values_with_stats_roundtrip() {
        let vals: [f64; 3] = [1.0, 2.0, 3.0];
        let mut buf = [0u8; 1024];
        let mut stats = [0.0f64; 8];

        let bytes = encodeValuesWithStats(
            vals.as_ptr(), 3, buf.as_mut_ptr(), 1024, stats.as_mut_ptr(),
        );
        assert!(bytes > 0);
        assert_eq!(stats[0], 1.0); // min
        assert_eq!(stats[1], 3.0); // max
        assert_eq!(stats[2], 6.0); // sum

        let mut decoded = [0f64; 3];
        let count = decodeValues(buf.as_ptr(), bytes, decoded.as_mut_ptr(), 3);
        assert_eq!(count, 3);
        assert_eq!(decoded, vals);
    }

    #[test]
    fn compute_stats_monotonic_no_resets() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals: std::vec::Vec<f64> = (0..100).map(|i| i as f64).collect();
        let mut stats = [0f64; 8];
        let resets = compute_stats(&vals, &mut stats);
        assert_eq!(stats[0], 0.0, "min");
        assert_eq!(stats[1], 99.0, "max");
        assert_eq!(stats[4], 0.0, "first");
        assert_eq!(stats[5], 99.0, "last");
        assert_eq!(resets, 0);
    }

    #[test]
    fn values_empty_returns_zero() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let mut buf = [0u8; 128];
        let written = encodeValues(core::ptr::null(), 0, buf.as_mut_ptr(), 128);
        assert_eq!(written, 0);
    }
}
