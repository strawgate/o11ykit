// ── Fused range decode (ALP + timestamps) ───────────────────────────
//
// Decodes timestamps + ALP values, binary searches for [startT, endT],
// and returns only the matching range. ALP's fixed-width bit-packing
// enables random access — we skip decoding values outside the range.

use o11y_codec_rt_alp::{decode_values_alp_range, ALP_MAX_CHUNK};
use o11y_codec_rt_xor_delta::decode_timestamps as decode_timestamps_inner;

/// Binary search: first index where ts_buf[i] >= target.
#[inline]
pub(crate) fn lower_bound_i64(buf: &[i64], len: usize, target: i64) -> usize {
    let mut lo = 0usize;
    let mut hi = len;
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if buf[mid] < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Binary search: first index where ts_buf[i] > target.
#[inline]
pub(crate) fn upper_bound_i64(buf: &[i64], len: usize, target: i64) -> usize {
    let mut lo = 0usize;
    let mut hi = len;
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if buf[mid] <= target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Fused range decode: decode timestamps, binary search, partial ALP decode.
#[no_mangle]
pub extern "C" fn rangeDecodeALP(
    ts_ptr: *const u8,
    ts_len: u32,
    val_ptr: *const u8,
    val_len: u32,
    start_t: i64,
    end_t: i64,
    out_ts_ptr: *mut i64,
    out_val_ptr: *mut f64,
    max_out: u32,
) -> u32 {
    let ts_input = unsafe { core::slice::from_raw_parts(ts_ptr, ts_len as usize) };
    // Stack-local timestamp buffer: 16 KB, fine on the wasm32 1 MB stack.
    let mut ts_buf_arr = [0i64; ALP_MAX_CHUNK];
    let ts_buf = &mut ts_buf_arr[..];
    let ts_count = decode_timestamps_inner(ts_input, ts_buf);
    if ts_count == 0 {
        return 0;
    }

    // Binary search assumes ascending timestamps. The codec itself accepts
    // arbitrary sequences, so validate monotonicity here before trusting
    // lower_bound_i64 / upper_bound_i64.
    if ts_buf[..ts_count].windows(2).any(|w| w[0] > w[1]) {
        return 0;
    }

    let lo = lower_bound_i64(ts_buf, ts_count, start_t);
    let hi = upper_bound_i64(ts_buf, ts_count, end_t);
    if lo >= hi {
        return 0;
    }

    let requested_count = hi - lo;
    if requested_count > max_out as usize {
        return 0;
    }

    let val_input = unsafe { core::slice::from_raw_parts(val_ptr, val_len as usize) };
    let out_vals = unsafe { core::slice::from_raw_parts_mut(out_val_ptr, requested_count) };
    // Decode values first so we can bail out without mutating the ts output
    // if the value blob is malformed.
    let range_count = decode_values_alp_range(val_input, lo, hi, out_vals);
    if range_count == 0 {
        return 0;
    }

    let out_ts = unsafe { core::slice::from_raw_parts_mut(out_ts_ptr, range_count) };
    out_ts.copy_from_slice(&ts_buf[lo..lo + range_count]);

    range_count as u32
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use o11y_codec_rt_alp::alp_encode;
    fn alp_encode_inner(vals: &[f64], out: &mut [u8]) -> usize {
        alp_encode(vals, out, false)
    }
    use crate::timestamp::encodeTimestamps;

    #[test]
    fn lower_bound_basic() {
        let buf = [10i64, 20, 30, 40, 50];
        assert_eq!(lower_bound_i64(&buf, 5, 10), 0);
        assert_eq!(lower_bound_i64(&buf, 5, 25), 2);
        assert_eq!(lower_bound_i64(&buf, 5, 50), 4);
        assert_eq!(lower_bound_i64(&buf, 5, 51), 5);
        assert_eq!(lower_bound_i64(&buf, 5, 1), 0);
    }

    #[test]
    fn upper_bound_basic() {
        let buf = [10i64, 20, 30, 40, 50];
        assert_eq!(upper_bound_i64(&buf, 5, 10), 1);
        assert_eq!(upper_bound_i64(&buf, 5, 25), 2);
        assert_eq!(upper_bound_i64(&buf, 5, 50), 5);
        assert_eq!(upper_bound_i64(&buf, 5, 1), 0);
    }

    #[test]
    fn lower_upper_bound_duplicates() {
        let buf = [10i64, 20, 20, 20, 30];
        assert_eq!(lower_bound_i64(&buf, 5, 20), 1); // first 20
        assert_eq!(upper_bound_i64(&buf, 5, 20), 4); // past last 20
    }

    #[test]
    fn range_decode_full() {
        let n = 100;
        let ts: std::vec::Vec<i64> = (0..n).map(|i| 1000 + i * 15).collect();
        let vals: std::vec::Vec<f64> = (0..n).map(|i| (i as f64) * 0.1).collect();

        let mut ts_buf = [0u8; 4096];
        let ts_bytes = encodeTimestamps(ts.as_ptr(), n as u32, ts_buf.as_mut_ptr(), 4096);
        assert!(ts_bytes > 0);

        let mut val_buf = [0u8; 65536];
        let val_bytes = alp_encode_inner(&vals, &mut val_buf);
        assert!(val_bytes > 0);

        // Query full range.
        let mut out_ts = [0i64; 100];
        let mut out_vals = [0f64; 100];
        let count = rangeDecodeALP(
            ts_buf.as_ptr(), ts_bytes,
            val_buf.as_ptr(), val_bytes as u32,
            1000, 1000 + 99 * 15,
            out_ts.as_mut_ptr(), out_vals.as_mut_ptr(), 100,
        );
        assert_eq!(count, 100);
        assert_eq!(&out_ts[..100], ts.as_slice());
        for i in 0..100 {
            assert_eq!(out_vals[i], vals[i], "val mismatch at {i}");
        }
    }

    #[test]
    fn range_decode_partial() {
        let n = 100;
        let ts: std::vec::Vec<i64> = (0..n).map(|i| 1000 + i * 15).collect();
        let vals: std::vec::Vec<f64> = (0..n).map(|i| (i as f64) * 0.1).collect();

        let mut ts_buf = [0u8; 4096];
        let ts_bytes = encodeTimestamps(ts.as_ptr(), n as u32, ts_buf.as_mut_ptr(), 4096);

        let mut val_buf = [0u8; 65536];
        let val_bytes = alp_encode_inner(&vals, &mut val_buf);

        // Query middle range: [1150, 1300] → indices 10..21 (ts[10]=1150, ts[20]=1300).
        let mut out_ts = [0i64; 100];
        let mut out_vals = [0f64; 100];
        let count = rangeDecodeALP(
            ts_buf.as_ptr(), ts_bytes,
            val_buf.as_ptr(), val_bytes as u32,
            1150, 1300,
            out_ts.as_mut_ptr(), out_vals.as_mut_ptr(), 100,
        );
        assert_eq!(count, 11); // indices 10..20 inclusive
        assert_eq!(out_ts[0], 1150);
        assert_eq!(out_ts[10], 1300);
    }

    #[test]
    fn range_decode_no_match() {
        let ts: [i64; 5] = [100, 200, 300, 400, 500];
        let vals = [1.0f64; 5];

        let mut ts_buf = [0u8; 256];
        let ts_bytes = encodeTimestamps(ts.as_ptr(), 5, ts_buf.as_mut_ptr(), 256);

        let mut val_buf = [0u8; 1024];
        let val_bytes = alp_encode_inner(&vals, &mut val_buf);

        let mut out_ts = [0i64; 10];
        let mut out_vals = [0f64; 10];
        let count = rangeDecodeALP(
            ts_buf.as_ptr(), ts_bytes,
            val_buf.as_ptr(), val_bytes as u32,
            600, 700,
            out_ts.as_mut_ptr(), out_vals.as_mut_ptr(), 10,
        );
        assert_eq!(count, 0);
    }

    #[test]
    fn range_decode_single_match() {
        let ts: [i64; 5] = [100, 200, 300, 400, 500];
        let vals: [f64; 5] = [1.0, 2.0, 3.0, 4.0, 5.0];

        let mut ts_buf = [0u8; 256];
        let ts_bytes = encodeTimestamps(ts.as_ptr(), 5, ts_buf.as_mut_ptr(), 256);

        let mut val_buf = [0u8; 1024];
        let val_bytes = alp_encode_inner(&vals, &mut val_buf);

        let mut out_ts = [0i64; 10];
        let mut out_vals = [0f64; 10];
        let count = rangeDecodeALP(
            ts_buf.as_ptr(), ts_bytes,
            val_buf.as_ptr(), val_bytes as u32,
            300, 300,
            out_ts.as_mut_ptr(), out_vals.as_mut_ptr(), 10,
        );
        assert_eq!(count, 1);
        assert_eq!(out_ts[0], 300);
        assert_eq!(out_vals[0], 3.0);
    }

    #[test]
    fn range_decode_boundary_timestamps() {
        // Encode a chunk with known timestamps.
        let ts: std::vec::Vec<i64> = (0..100).map(|i| 1000i64 + i * 10).collect();
        let vals: std::vec::Vec<f64> = (0..100).map(|i| i as f64 * 0.1).collect();

        let mut ts_buf = [0u8; 4096];
        let ts_bytes = encodeTimestamps(ts.as_ptr(), 100, ts_buf.as_mut_ptr(), 4096);
        assert!(ts_bytes > 0);

        let mut val_buf = [0u8; 65536];
        let val_bytes = alp_encode_inner(&vals, &mut val_buf);
        assert!(val_bytes > 0);

        // Query for exact boundaries.
        let mut out_ts = [0i64; 100];
        let mut out_vals = [0f64; 100];
        let count = rangeDecodeALP(
            ts_buf.as_ptr(), ts_bytes,
            val_buf.as_ptr(), val_bytes as u32,
            1000, 1990,  // exact start and end
            out_ts.as_mut_ptr(), out_vals.as_mut_ptr(), 100,
        );
        assert_eq!(count, 100);
    }
}
