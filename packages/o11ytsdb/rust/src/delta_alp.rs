// ── Delta-ALP codec + ALP dispatch layer ────────────────────────────
//
// For monotonically non-decreasing integer-valued series (counters),
// delta-encoding before ALP dramatically reduces Frame-of-Reference
// bit-width: e.g. monotonicCounter(640) drops from bw=17 to bw=8.
//
// Format:
//   [0xDA]                 — tag byte (distinguishes from regular ALP)
//   [base_f64 (8B BE)]     — first value stored as raw f64
//   [ALP block (variable)] — ALP-compressed deltas (n-1 values)
//
// This module also contains the top-level ALP dispatch functions
// (decode_values_alp_inner, encodeValuesALP*, decodeValuesALP)
// since they must know about both regular ALP and delta-ALP.

use crate::alp::{
    alp_decode_regular, alp_encode_inner, sortable_u64_to_f64, ALP_EXC_U64,
    ALP_HEADER_SIZE, ALP_MAX_CHUNK, POW10,
};
use crate::bitio::BitReader;
use crate::gorilla::compute_stats;

pub(crate) const DELTA_ALP_TAG: u8 = 0xDA;

static mut DELTA_VALS: [f64; ALP_MAX_CHUNK] = [0.0; ALP_MAX_CHUNK];

/// Detect if a value array is a monotonic integer counter suitable for
/// delta-ALP encoding.
pub(crate) fn is_delta_alp_candidate(vals: &[f64], reset_count: u32) -> bool {
    let n = vals.len();
    if n < 2 || reset_count != 0 {
        return false;
    }
    if vals[0] >= vals[n - 1] {
        return false;
    }
    for i in 0..n {
        let v = vals[i];
        if v != (v as i64) as f64 || v.is_nan() || v.is_infinite() {
            return false;
        }
    }
    true
}

/// Encode values using delta-before-ALP. Returns bytes written, or 0 on failure.
pub(crate) fn delta_alp_encode_inner(vals: &[f64], out: &mut [u8]) -> usize {
    let n = vals.len();
    if n < 2 || n > ALP_MAX_CHUNK {
        return 0;
    }

    let mut pos: usize = 0;
    out[pos] = DELTA_ALP_TAG;
    pos += 1;

    let base_bytes = f64::to_bits(vals[0]).to_be_bytes();
    out[pos..pos + 8].copy_from_slice(&base_bytes);
    pos += 8;

    let deltas = unsafe { &mut DELTA_VALS[..n - 1] };
    for i in 0..n - 1 {
        deltas[i] = vals[i + 1] - vals[i];
    }

    let bytes_written = alp_encode_inner(deltas, &mut out[pos..]);
    if bytes_written == 0 {
        return 0;
    }
    pos += bytes_written;
    pos
}

/// Decode delta-ALP values. Input must start with DELTA_ALP_TAG (0xDA).
fn delta_alp_decode_inner(input: &[u8], val_out: &mut [f64]) -> usize {
    if input.len() < 23 || input[0] != DELTA_ALP_TAG {
        return 0;
    }

    let mut base_bytes = [0u8; 8];
    base_bytes.copy_from_slice(&input[1..9]);
    let base = f64::from_bits(u64::from_be_bytes(base_bytes));
    val_out[0] = base;

    // Use alp_decode_regular for the inner ALP block (not the dispatcher).
    let deltas = unsafe { &mut DELTA_VALS[..ALP_MAX_CHUNK] };
    let delta_count = alp_decode_regular(&input[9..], deltas);
    if delta_count == 0 {
        return 1;
    }

    let mut acc = base;
    for i in 0..delta_count {
        acc += deltas[i];
        val_out[i + 1] = acc;
    }
    delta_count + 1
}

/// Decode only values[lo..hi] from a delta-ALP blob.
pub(crate) fn delta_alp_decode_range(input: &[u8], lo: usize, hi: usize, out: &mut [f64]) {
    if input.len() < 23 || input[0] != DELTA_ALP_TAG {
        return;
    }

    let mut base_bytes = [0u8; 8];
    base_bytes.copy_from_slice(&input[1..9]);
    let base = f64::from_bits(u64::from_be_bytes(base_bytes));

    let deltas = unsafe { &mut DELTA_VALS[..ALP_MAX_CHUNK] };
    let delta_count = alp_decode_regular(&input[9..], deltas);
    let total_n = delta_count + 1;
    if lo >= total_n {
        return;
    }

    let mut acc = base;
    let effective_hi = if hi < total_n { hi } else { total_n };

    for i in 0..lo {
        if i < delta_count {
            acc += deltas[i];
        }
    }

    if lo == 0 {
        out[0] = base;
        for i in 1..(effective_hi - lo) {
            acc += deltas[lo + i - 1];
            out[i] = acc;
        }
    } else {
        out[0] = acc;
        for i in 1..(effective_hi - lo) {
            acc += deltas[lo + i - 1];
            out[i] = acc;
        }
    }
}

// ── Top-level ALP dispatch: handles both regular ALP and delta-ALP ──

/// Decode ALP values from a compressed blob.
/// Handles both regular ALP and delta-ALP (tag 0xDA) transparently.
pub(crate) fn decode_values_alp_inner(input: &[u8], val_out: &mut [f64]) -> usize {
    if input.is_empty() {
        return 0;
    }
    if input[0] == DELTA_ALP_TAG {
        return delta_alp_decode_inner(input, val_out);
    }
    alp_decode_regular(input, val_out)
}

/// Decode only values[lo..hi] from an ALP-compressed blob.
/// Handles both regular ALP and delta-ALP transparently.
pub(crate) fn decode_values_alp_range(input: &[u8], lo: usize, hi: usize, out: &mut [f64]) {
    if input.is_empty() {
        return;
    }
    if input[0] == DELTA_ALP_TAG {
        delta_alp_decode_range(input, lo, hi, out);
        return;
    }

    if input.len() < ALP_HEADER_SIZE {
        return;
    }

    let mut pos: usize = 0;
    let n = ((input[0] as usize) << 8) | (input[1] as usize);
    pos += 2;
    if n == 0 || lo >= n {
        return;
    }
    let e = input[pos] as usize;
    pos += 1;
    let bw = input[pos];
    pos += 1;
    let mut min_bytes = [0u8; 8];
    min_bytes.copy_from_slice(&input[pos..pos + 8]);
    let min_int = i64::from_be_bytes(min_bytes);
    pos += 8;
    let exc_count = ((input[pos] as usize) << 8) | (input[pos + 1] as usize);
    pos += 2;

    let factor = POW10[e];
    let bit_packed_start = pos;

    if bw > 0 {
        let start_bit = lo * bw as usize;
        let byte_offset = start_bit / 8;
        let bit_offset = (start_bit % 8) as u8;
        let mut r = BitReader {
            buf: &input[bit_packed_start + byte_offset..],
            byte_pos: 0,
            bit_pos: bit_offset,
        };
        for i in 0..(hi - lo) {
            let offset = r.read_bits(bw) as i64;
            out[i] = (min_int + offset) as f64 / factor;
        }
        pos = bit_packed_start + (n * bw as usize + 7) / 8;
    } else {
        let base = min_int as f64 / factor;
        for i in 0..(hi - lo) {
            out[i] = base;
        }
    }

    // Patch exceptions within [lo..hi].
    if exc_count > 0 {
        decode_range_exceptions(input, &mut pos, n, exc_count, lo, hi, out);
    }
}

fn decode_range_exceptions(
    input: &[u8],
    pos: &mut usize,
    n: usize,
    exc_count: usize,
    lo: usize,
    hi: usize,
    out: &mut [f64],
) {
    let mut exc_positions = [0u16; ALP_MAX_CHUNK];
    if exc_count < n {
        for i in 0..exc_count {
            exc_positions[i] = ((input[*pos] as u16) << 8) | (input[*pos + 1] as u16);
            *pos += 2;
        }
    }

    let mut header_bytes = [0u8; 8];
    header_bytes.copy_from_slice(&input[*pos..*pos + 8]);
    let header_u64 = u64::from_be_bytes(header_bytes);
    *pos += 8;
    let raw_bw = input[*pos];
    *pos += 1;

    let is_delta = raw_bw & 0x80 != 0;
    let actual_bw = raw_bw & 0x7F;

    if is_delta {
        let exc_u64 = unsafe { &mut ALP_EXC_U64[..exc_count] };
        exc_u64[0] = header_u64;

        if actual_bw > 0 {
            let mut r = BitReader::new(&input[*pos..]);
            let mut prev = header_u64;
            for i in 1..exc_count {
                let zz = r.read_bits(actual_bw);
                let d = ((zz >> 1) as i64) ^ (-((zz & 1) as i64));
                let cur = (prev as i128 + d as i128) as u64;
                exc_u64[i] = cur;
                prev = cur;
            }
        } else {
            for i in 1..exc_count {
                exc_u64[i] = header_u64;
            }
        }

        if exc_count == n {
            for i in lo..hi {
                out[i - lo] = sortable_u64_to_f64(exc_u64[i]);
            }
        } else {
            for i in 0..exc_count {
                let idx = exc_positions[i] as usize;
                if idx >= lo && idx < hi {
                    out[idx - lo] = sortable_u64_to_f64(exc_u64[i]);
                }
            }
        }
    } else {
        let min_su64 = header_u64;
        let exc_bw = actual_bw;

        if exc_count == n {
            if exc_bw > 0 {
                let start_bit = lo * exc_bw as usize;
                let byte_offset = start_bit / 8;
                let bit_offset = (start_bit % 8) as u8;
                let mut r = BitReader {
                    buf: &input[*pos + byte_offset..],
                    byte_pos: 0,
                    bit_pos: bit_offset,
                };
                for i in 0..(hi - lo) {
                    out[i] = sortable_u64_to_f64(min_su64 + r.read_bits(exc_bw));
                }
            } else {
                let base = sortable_u64_to_f64(min_su64);
                for i in 0..(hi - lo) {
                    out[i] = base;
                }
            }
        } else {
            if exc_bw > 0 {
                let mut r = BitReader::new(&input[*pos..]);
                for i in 0..exc_count {
                    let val = sortable_u64_to_f64(min_su64 + r.read_bits(exc_bw));
                    let idx = exc_positions[i] as usize;
                    if idx >= lo && idx < hi {
                        out[idx - lo] = val;
                    }
                }
            } else {
                let base = sortable_u64_to_f64(min_su64);
                for i in 0..exc_count {
                    let idx = exc_positions[i] as usize;
                    if idx >= lo && idx < hi {
                        out[idx - lo] = base;
                    }
                }
            }
        }
    }
}

// ── WASM exports ─────────────────────────────────────────────────────

/// Encode values using ALP. Returns bytes written.
#[no_mangle]
pub extern "C" fn encodeValuesALP(
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
    alp_encode_inner(vals, out) as u32
}

/// Decode ALP-encoded values. Returns number of samples decoded.
#[no_mangle]
pub extern "C" fn decodeValuesALP(
    in_ptr: *const u8,
    in_len: u32,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, max_samples as usize) };
    decode_values_alp_inner(input, val_out) as u32
}

/// Encode values using ALP AND compute block stats in one pass.
#[no_mangle]
pub extern "C" fn encodeValuesALPWithStats(
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
    let reset_count = compute_stats(vals, stats);

    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };
    if is_delta_alp_candidate(vals, reset_count) {
        let delta_size = delta_alp_encode_inner(vals, out);
        if delta_size > 0 {
            let plain_start = delta_size;
            if plain_start + n * 20 <= out.len() {
                let plain_size = alp_encode_inner(vals, &mut out[plain_start..]);
                if plain_size > 0 && plain_size < delta_size {
                    out.copy_within(plain_start..plain_start + plain_size, 0);
                    return plain_size as u32;
                }
            }
            return delta_size as u32;
        }
    }
    alp_encode_inner(vals, out) as u32
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    fn roundtrip_alp(vals: &[f64]) {
        let n = vals.len();
        let mut buf = [0u8; 65536];
        let mut decoded = [0f64; 2048];
        let written = alp_encode_inner(vals, &mut buf);
        assert!(written > 0);
        let count = decode_values_alp_inner(&buf[..written], &mut decoded);
        assert_eq!(count, n);
        for i in 0..n {
            assert_eq!(decoded[i], vals[i], "mismatch at {i}");
        }
    }

    #[test]
    fn delta_alp_candidate_detection() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        // Valid counter.
        let vals: std::vec::Vec<f64> = (0..100).map(|i| i as f64).collect();
        assert!(is_delta_alp_candidate(&vals, 0));

        // Non-monotonic.
        assert!(!is_delta_alp_candidate(&[1.0, 0.0], 1));

        // Constant.
        assert!(!is_delta_alp_candidate(&[5.0, 5.0, 5.0], 0));

        // Floats (non-integer).
        assert!(!is_delta_alp_candidate(&[1.0, 1.5, 2.0], 0));

        // Single element.
        assert!(!is_delta_alp_candidate(&[1.0], 0));
    }

    #[test]
    fn delta_alp_roundtrip() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals: std::vec::Vec<f64> = (0..640).map(|i| (i * 100) as f64).collect();
        let mut buf = [0u8; 65536];
        let written = delta_alp_encode_inner(&vals, &mut buf);
        assert!(written > 0);
        assert_eq!(buf[0], DELTA_ALP_TAG);

        let mut decoded = [0f64; 2048];
        let count = decode_values_alp_inner(&buf[..written], &mut decoded);
        assert_eq!(count, 640);
        for i in 0..640 {
            assert_eq!(decoded[i], vals[i], "mismatch at {i}");
        }
    }

    #[test]
    fn delta_alp_range_decode() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i * 10) as f64).collect();
        let mut buf = [0u8; 65536];
        let written = delta_alp_encode_inner(&vals, &mut buf);
        assert!(written > 0);

        // Decode [10..20).
        let mut out = [0f64; 10];
        delta_alp_decode_range(&buf[..written], 10, 20, &mut out);
        for i in 0..10 {
            assert_eq!(out[i], vals[10 + i], "range mismatch at {i}");
        }
    }

    #[test]
    fn dispatch_regular_alp() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        roundtrip_alp(&vals);
    }

    #[test]
    fn dispatch_delta_alp_through_stats() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        // encodeValuesALPWithStats should auto-detect counter and use delta-ALP.
        let vals: std::vec::Vec<f64> = (0..640).map(|i| (i * 100) as f64).collect();
        let mut buf = [0u8; 65536];
        let mut stats = [0.0f64; 8];
        let written = encodeValuesALPWithStats(
            vals.as_ptr(), 640, buf.as_mut_ptr(), 65536, stats.as_mut_ptr(),
        );
        assert!(written > 0);
        assert_eq!(stats[3], 640.0); // count
        assert_eq!(stats[0], 0.0);   // min
        assert_eq!(stats[5], 63900.0); // last

        let mut decoded = [0f64; 2048];
        let count = decodeValuesALP(buf.as_ptr(), written, decoded.as_mut_ptr(), 2048);
        assert_eq!(count, 640);
        for i in 0..640 {
            assert_eq!(decoded[i], vals[i], "mismatch at {i}");
        }
    }

    #[test]
    fn wasm_encode_decode_alp() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals: [f64; 10] = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9];
        let mut buf = [0u8; 1024];
        let written = encodeValuesALP(
            vals.as_ptr(), 10, buf.as_mut_ptr(), 1024,
        );
        assert!(written > 0);

        let mut decoded = [0f64; 10];
        let count = decodeValuesALP(buf.as_ptr(), written, decoded.as_mut_ptr(), 10);
        assert_eq!(count, 10);
        // ALP encodes via integer multiply/divide, which may introduce ULP
        // rounding differences for values not exactly representable in binary.
        for i in 0..10 {
            assert!((decoded[i] - vals[i]).abs() < 1e-14,
                "value {i}: decoded={} expected={}", decoded[i], vals[i]);
        }
    }

    #[test]
    fn range_decode_regular_alp() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        let mut buf = [0u8; 65536];
        let written = alp_encode_inner(&vals, &mut buf);
        assert!(written > 0);

        let mut out = [0f64; 10];
        decode_values_alp_range(&buf[..written], 10, 20, &mut out);
        for i in 0..10 {
            assert_eq!(out[i], vals[10 + i], "range mismatch at {i}");
        }
    }
}
