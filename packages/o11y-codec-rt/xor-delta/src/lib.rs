//! o11y-codec-rt-xor-delta — Gorilla XOR-delta codec.
//!
//! Encodes timestamps + f64 values (or values only, or timestamps only)
//! using:
//!   - Timestamps: delta-of-delta with 4-tier prefix coding
//!   - Values: XOR with leading/trailing zero tracking
//!
//! Reference: Pelkonen et al., VLDB 2015 (Gorilla).
//!
//! Pure-Rust slice-in / slice-out API. The WASM `extern "C"` surface
//! lives in each consuming engine's binding crate.

#![cfg_attr(not(test), no_std)]

use o11y_codec_rt_core::{BitReader, BitWriter, zigzag_decode, zigzag_encode};

// ── Combined chunk (timestamps + values) ─────────────────────────────

/// Encode timestamps + values into a compressed chunk.
/// Layout: 16-bit count, 64-bit first ts, 64-bit first value, then
/// interleaved DoD timestamps + XOR values.
///
/// Header is 18 bytes (16-bit count + 64-bit ts0 + 64-bit val0). The
/// caller must supply at least that much output capacity.
pub fn encode_chunk(ts: &[i64], vals: &[f64], out: &mut [u8]) -> usize {
    let n = ts.len();
    debug_assert_eq!(n, vals.len());
    // Count is serialized as a 16-bit header field — reject larger inputs
    // so decode cannot reconstruct a truncated length. Reject too-small
    // output buffers up front so BitWriter doesn't panic on the header.
    if n == 0 || n > u16::MAX as usize || out.len() < 18 {
        return 0;
    }

    let mut w = BitWriter::new(out);

    w.write_bits(n as u64, 16);
    w.write_bits(ts[0] as u64, 64);
    w.write_bits(f64::to_bits(vals[0]), 64);

    if n == 1 {
        return w.bytes_written();
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

        write_dod(&mut w, dod);

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

    w.bytes_written()
}

/// Decode a compressed chunk into timestamps + values. Returns the
/// number of decoded samples.
pub fn decode_chunk(input: &[u8], ts_out: &mut [i64], val_out: &mut [f64]) -> usize {
    // Header is 18 bytes: 16-bit count + 64-bit ts0 + 64-bit val0.
    if input.len() < 18 {
        return 0;
    }
    let mut r = BitReader::new(input);

    let n = r.read_bits(16) as usize;
    // Reject counts that exceed the caller-allocated output capacity.
    if n == 0 || n > ts_out.len() || n > val_out.len() {
        return 0;
    }

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
        let dod = read_dod(&mut r);

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

    n
}

// ── Values-only ──────────────────────────────────────────────────────

/// Encode values only (no timestamps) using XOR encoding.
/// Layout: 16-bit count + 64-bit first value + XOR-encoded subsequent values.
///
/// Header is 10 bytes (16-bit count + 64-bit val0). The caller must
/// supply at least that much output capacity.
pub fn encode_values(vals: &[f64], out: &mut [u8]) -> usize {
    let n = vals.len();
    if n == 0 || n > u16::MAX as usize || out.len() < 10 {
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

/// Decode values from a values-only XOR blob. Returns count.
pub fn decode_values(input: &[u8], val_out: &mut [f64]) -> usize {
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

// ── Timestamps-only ──────────────────────────────────────────────────

/// Encode timestamps only using delta-of-delta encoding.
/// Layout: 16-bit count + 64-bit first timestamp + DoD bitstream.
pub fn encode_timestamps(ts: &[i64], out: &mut [u8]) -> usize {
    let n = ts.len();
    if n == 0 || n > u16::MAX as usize {
        return 0;
    }
    // 10-byte header (16-bit count + 64-bit first timestamp) is the minimum
    // footprint. Tiny buffers would make BitWriter panic on the header writes.
    if out.len() < 10 {
        return 0;
    }

    let mut w = BitWriter::new(out);

    w.write_bits(n as u64, 16);
    w.write_bits(ts[0] as u64, 64);

    if n == 1 {
        return w.bytes_written();
    }

    let mut prev_ts = ts[0];
    let mut prev_delta: i64 = 0;

    for i in 1..n {
        let cur_ts = ts[i];
        let delta = cur_ts.wrapping_sub(prev_ts);
        let dod = delta.wrapping_sub(prev_delta);

        write_dod(&mut w, dod);

        prev_delta = delta;
        prev_ts = cur_ts;
    }

    w.bytes_written()
}

/// Decode timestamps from a delta-of-delta bitstream. Returns count.
pub fn decode_timestamps(input: &[u8], ts_out: &mut [i64]) -> usize {
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
        let dod = read_dod(&mut r);

        let delta = prev_delta.wrapping_add(dod);
        let cur_ts = prev_ts.wrapping_add(delta);
        ts_out[i] = cur_ts;
        prev_delta = delta;
        prev_ts = cur_ts;
    }
    n
}

// ── Block statistics ─────────────────────────────────────────────────

/// Compute block stats from a values slice and write to 8-element f64 buffer.
/// Stats: [min, max, sum, count, first, last, sum_of_squares, reset_count].
/// Returns the reset_count separately for callers that want it directly.
///
/// Panics if `vals` is empty or `stats.len() < 8` — callers must guard.
pub fn compute_stats(vals: &[f64], stats: &mut [f64]) -> u32 {
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

// ── Internal: 4-tier delta-of-delta prefix coder ─────────────────────

#[inline(always)]
fn write_dod(w: &mut BitWriter<'_>, dod: i64) {
    if dod == 0 {
        w.write_bit(0);
        return;
    }
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

#[inline(always)]
fn read_dod(r: &mut BitReader<'_>) -> i64 {
    if r.read_bit() == 0 {
        0
    } else if r.read_bit() == 0 {
        zigzag_decode(r.read_bits(7))
    } else if r.read_bit() == 0 {
        zigzag_decode(r.read_bits(9))
    } else if r.read_bit() == 0 {
        zigzag_decode(r.read_bits(12))
    } else {
        r.read_bits(64) as i64
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk_roundtrip(ts: &[i64], vals: &[f64]) {
        let n = ts.len();
        assert_eq!(n, vals.len());
        let mut buf = [0u8; 8192];
        let mut dec_ts = [0i64; 2048];
        let mut dec_vals = [0f64; 2048];

        let bytes = encode_chunk(ts, vals, &mut buf);
        assert!(bytes > 0, "chunk encode failed");

        let count = decode_chunk(&buf[..bytes], &mut dec_ts, &mut dec_vals);
        assert_eq!(count, n);
        assert_eq!(&dec_ts[..n], ts);
        assert_eq!(&dec_vals[..n], vals);
    }

    fn values_roundtrip(vals: &[f64]) {
        let n = vals.len();
        let mut buf = [0u8; 8192];
        let mut decoded = [0f64; 2048];

        let bytes = encode_values(vals, &mut buf);
        assert!(bytes > 0, "values encode failed");

        let count = decode_values(&buf[..bytes], &mut decoded);
        assert_eq!(count, n);
        assert_eq!(&decoded[..n], vals);
    }

    fn ts_roundtrip(ts: &[i64]) {
        let mut buf = [0u8; 4096];
        let mut decoded = [0i64; 2048];

        let bytes = encode_timestamps(ts, &mut buf);
        assert!(bytes > 0, "ts encode failed for {:?}", ts);

        let count = decode_timestamps(&buf[..bytes], &mut decoded);
        assert_eq!(count, ts.len());
        assert_eq!(&decoded[..count], ts);
    }

    // ── Combined chunk ───────────────────────────────────────────────

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
    fn chunk_zero_count_returns_zero() {
        let mut buf = [0u8; 128];
        assert_eq!(encode_chunk(&[], &[], &mut buf), 0);
    }

    #[test]
    fn chunk_count_overflow_rejected() {
        // 65536 exceeds the 16-bit count header.
        let ts = [0i64; 65536];
        let vals = [0f64; 65536];
        let mut buf = [0u8; 1024];
        assert_eq!(encode_chunk(&ts, &vals, &mut buf), 0);
    }

    // ── Values only ──────────────────────────────────────────────────

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

        let bytes = encode_values(&vals, &mut buf);
        assert!(bytes > 0);

        let count = decode_values(&buf[..bytes], &mut decoded);
        assert_eq!(count, 6);

        assert!(decoded[0].is_nan());
        assert_eq!(decoded[1], f64::INFINITY);
        assert_eq!(decoded[2], f64::NEG_INFINITY);
        assert!(decoded[3].is_sign_negative() && decoded[3] == 0.0);
        assert_eq!(decoded[4], f64::MIN);
        assert_eq!(decoded[5], f64::MAX);
    }

    #[test]
    fn values_monotonic_counter() {
        let vals: std::vec::Vec<f64> = (0..640).map(|i| i as f64 * 100.0).collect();
        values_roundtrip(&vals);
    }

    #[test]
    fn values_empty_returns_zero() {
        let mut buf = [0u8; 128];
        assert_eq!(encode_values(&[], &mut buf), 0);
    }

    // ── Timestamps only ──────────────────────────────────────────────

    #[test]
    fn ts_single() {
        ts_roundtrip(&[1_700_000_000_000i64]);
    }

    #[test]
    fn ts_two() {
        ts_roundtrip(&[1000, 2000]);
    }

    #[test]
    fn ts_regular_15s_intervals() {
        let ts: std::vec::Vec<i64> = (0..100).map(|i| 1_000_000 + i * 15_000).collect();
        ts_roundtrip(&ts);
    }

    #[test]
    fn ts_dod_tier_boundaries() {
        let dods: &[i64] = &[
            0, 1, -1,
            63, -63, 64, -64,
            255, -255, 256, -256,
            2047, -2047, 2048, -2048,
            10000, -10000,
        ];
        for &target_dod in dods {
            let ts: [i64; 3] = [1000, 1100, 1200 + target_dod];
            ts_roundtrip(&ts);
        }
    }

    #[test]
    fn ts_otel_nanos() {
        let ts: [i64; 6] = [
            1_700_000_000_000_000_000,
            1_700_000_000_010_000_000,
            1_700_000_000_020_000_064,
            1_700_000_000_030_000_320,
            1_700_000_000_040_002_368,
            1_700_000_000_040_002_368,
        ];
        ts_roundtrip(&ts);
    }

    #[test]
    fn ts_identical() {
        let ts = [42i64; 10];
        ts_roundtrip(&ts);
    }

    #[test]
    fn ts_large_gap() {
        let ts = [0i64, 1_000_000_000_000];
        ts_roundtrip(&ts);
    }

    #[test]
    fn ts_monotonic_decreasing() {
        let ts: std::vec::Vec<i64> = (0..50).rev().map(|i| i * 1000).collect();
        ts_roundtrip(&ts);
    }

    #[test]
    fn ts_irregular() {
        let ts = [100i64, 200, 250, 500, 501, 502, 600, 10000, 10001];
        ts_roundtrip(&ts);
    }

    #[test]
    fn ts_max_chunk_size() {
        let ts: std::vec::Vec<i64> = (0..2048).map(|i| 1000 + i * 15).collect();
        ts_roundtrip(&ts);
    }

    #[test]
    fn ts_tiny_output_buffer_returns_zero() {
        let mut buf = [0u8; 9];
        assert_eq!(encode_timestamps(&[1000], &mut buf), 0);
    }

    // ── Minimum-buffer contract (parity across encoders) ─────────────

    #[test]
    fn encode_chunk_tiny_output_buffer_returns_zero() {
        // Header is 18 bytes: 16-bit count + 64-bit ts0 + 64-bit val0.
        let mut buf = [0u8; 17];
        assert_eq!(encode_chunk(&[1], &[1.0], &mut buf), 0);
    }

    #[test]
    fn encode_values_tiny_output_buffer_returns_zero() {
        // Header is 10 bytes: 16-bit count + 64-bit val0.
        let mut buf = [0u8; 9];
        assert_eq!(encode_values(&[1.0], &mut buf), 0);
    }

    // ── Block stats ──────────────────────────────────────────────────

    #[test]
    fn stats_basic() {
        let vals: [f64; 5] = [3.0, 1.0, 4.0, 1.0, 5.0];
        let mut stats = [0.0f64; 8];
        let reset_count = compute_stats(&vals, &mut stats);

        assert_eq!(stats[0], 1.0);  // min
        assert_eq!(stats[1], 5.0);  // max
        assert_eq!(stats[2], 14.0); // sum
        assert_eq!(stats[3], 5.0);  // count
        assert_eq!(stats[4], 3.0);  // first
        assert_eq!(stats[5], 5.0);  // last
        assert_eq!(stats[6], 52.0); // sum_of_squares
        assert_eq!(stats[7], 2.0);  // reset_count
        assert_eq!(reset_count, 2);
    }

    #[test]
    fn stats_monotonic_no_resets() {
        let vals: std::vec::Vec<f64> = (0..100).map(|i| i as f64).collect();
        let mut stats = [0f64; 8];
        let resets = compute_stats(&vals, &mut stats);
        assert_eq!(stats[0], 0.0);
        assert_eq!(stats[1], 99.0);
        assert_eq!(stats[4], 0.0);
        assert_eq!(stats[5], 99.0);
        assert_eq!(resets, 0);
    }
}
