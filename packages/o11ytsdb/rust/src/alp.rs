// ── ALP (Adaptive Lossless floating-Point) codec ─────────────────────
//
// Three-step pipeline inspired by CWI's ALP (SIGMOD 2024):
//   1. Find best decimal exponent e such that value × 10^e round-trips
//   2. Frame-of-Reference: subtract min integer, compute bit-width
//   3. Bit-pack offsets; FoR or delta-FoR encode exceptions
//
// Header (14 bytes):
//   [0-1]   count (u16 BE)
//   [2]     exponent (u8)
//   [3]     bit_width (u8, 0-64)
//   [4-11]  min_int (i64 BE, frame of reference)
//   [12-13] exception_count (u16 BE)
// Payload:
//   bit-packed offsets (⌈count × bit_width / 8⌉ bytes)
//   exception positions (exc_count × u16 BE) — omitted when exc_count == count
//   exception min_u64 (8 bytes BE) — sortable u64 representation
//   exception bit_width (1 byte, 0-64, bit 7 = delta-FoR flag)
//   FoR bit-packed exception u64 offsets

use core::sync::atomic::Ordering;

use crate::alloc::ALP_EXC_MODE;
use o11y_codec_rt_alp::{
    alp_try, f64_to_sortable_u64, i64_range_u64, packed_safe_limit, ALP_HEADER_SIZE,
    ALP_MAX_CHUNK, ALP_MAX_EXP, POW10,
};
#[cfg(test)]
use o11y_codec_rt_alp::sortable_u64_to_f64;
use o11y_codec_rt_core::{bits_needed, extract_packed, extract_packed_safe, BitReader, BitWriter};

// ── Static temp storage (avoids stack/heap allocation) ───────────────
//
// Process-global scratch buffers, used by the encode/decode paths. Lift
// to the workspace crate is deferred until a refactor passes them in
// explicitly.

pub(crate) static mut ALP_INTS: [i64; ALP_MAX_CHUNK] = [0; ALP_MAX_CHUNK];
static mut ALP_EXC: [u8; ALP_MAX_CHUNK] = [0; ALP_MAX_CHUNK];
pub(crate) static mut ALP_EXC_U64: [u64; ALP_MAX_CHUNK] = [0; ALP_MAX_CHUNK];

/// Sample values to find the best decimal exponent, using a cost model.
pub(crate) fn alp_find_exponent(vals: &[f64]) -> u8 {
    let n = vals.len();
    let sample = if n <= 32 { n } else { 32 };
    let step = if n <= 32 { 1 } else { n / 32 };

    let mut best_e: u8 = 0;
    let mut best_cost: usize = usize::MAX;

    for e in 0..=ALP_MAX_EXP {
        let mut match_count: usize = 0;
        let mut min_int: i64 = i64::MAX;
        let mut max_int: i64 = i64::MIN;
        let mut min_su64: u64 = u64::MAX;
        let mut max_su64: u64 = 0;

        for s in 0..sample {
            let v = vals[s * step];
            if let Some(iv) = alp_try(v, e) {
                match_count += 1;
                if iv < min_int {
                    min_int = iv;
                }
                if iv > max_int {
                    max_int = iv;
                }
            } else {
                let su = f64_to_sortable_u64(v);
                if su < min_su64 {
                    min_su64 = su;
                }
                if su > max_su64 {
                    max_su64 = su;
                }
            }
        }

        let exc_count = sample - match_count;

        let bw = if match_count >= 2 {
            bits_needed(i64_range_u64(min_int, max_int)) as usize
        } else {
            0
        };

        let exc_bw = if exc_count >= 2 {
            bits_needed(max_su64 - min_su64) as usize
        } else {
            0
        };

        let exc_full = exc_count * n / sample;
        let match_bytes = (n * bw + 7) / 8;
        let pos_bytes = if exc_full == n { 0 } else { exc_full * 2 };
        let exc_val_bytes = if exc_full > 0 {
            9 + (exc_full * exc_bw + 7) / 8
        } else {
            0
        };
        let cost = ALP_HEADER_SIZE + match_bytes + pos_bytes + exc_val_bytes;

        if cost < best_cost {
            best_cost = cost;
            best_e = e as u8;
        }
    }
    best_e
}

/// Core ALP encoding. Returns bytes written.
pub(crate) fn alp_encode_inner(vals: &[f64], out: &mut [u8]) -> usize {
    let n = vals.len();
    if n == 0 || n > ALP_MAX_CHUNK {
        return 0;
    }

    let ints = unsafe { &mut ALP_INTS[..n] };
    let exc = unsafe { &mut ALP_EXC[..n] };

    // Step 1: Find best exponent.
    let e = alp_find_exponent(vals);

    // Step 2: Convert to integers, mark exceptions.
    let mut min_int: i64 = i64::MAX;
    let mut max_int: i64 = i64::MIN;
    let mut exc_count: usize = 0;

    for i in 0..n {
        match alp_try(vals[i], e as usize) {
            Some(iv) => {
                ints[i] = iv;
                exc[i] = 0;
                if iv < min_int {
                    min_int = iv;
                }
                if iv > max_int {
                    max_int = iv;
                }
            }
            None => {
                ints[i] = 0;
                exc[i] = 1;
                exc_count += 1;
            }
        }
    }

    if exc_count == n {
        min_int = 0;
        max_int = 0;
    }

    // Step 3: Compute bit-width for FoR offsets.
    let range = i64_range_u64(min_int, max_int);
    let bw = bits_needed(range);

    // Step 4: Write header.
    let mut pos: usize = 0;
    out[pos] = (n >> 8) as u8;
    out[pos + 1] = n as u8;
    pos += 2;
    out[pos] = e;
    pos += 1;
    out[pos] = bw;
    pos += 1;
    let min_bytes = min_int.to_be_bytes();
    out[pos..pos + 8].copy_from_slice(&min_bytes);
    pos += 8;
    out[pos] = (exc_count >> 8) as u8;
    out[pos + 1] = exc_count as u8;
    pos += 2;

    // Step 5: Bit-pack offsets.
    if bw > 0 {
        let mut w = BitWriter::new(&mut out[pos..]);
        for i in 0..n {
            if exc[i] == 0 {
                // Widen to i128 so wide cross-zero blocks (range > i64::MAX)
                // do not wrap during subtraction.
                let offset = (ints[i] as i128 - min_int as i128) as u64;
                w.write_bits(offset, bw);
            } else {
                w.write_bits(0, bw);
            }
        }
        pos += w.bytes_written();
    }

    // Step 6: Write exception positions.
    if exc_count > 0 && exc_count < n {
        for i in 0..n {
            if exc[i] != 0 {
                out[pos] = (i >> 8) as u8;
                out[pos + 1] = i as u8;
                pos += 2;
            }
        }
    }

    // Step 7: Encode exception values (FoR or delta-FoR).
    if exc_count > 0 {
        let exc_u64 = unsafe { &mut ALP_EXC_U64[..exc_count] };
        let mut ei = 0;
        for i in 0..n {
            if exc[i] != 0 {
                exc_u64[ei] = f64_to_sortable_u64(vals[i]);
                ei += 1;
            }
        }

        let use_delta = ALP_EXC_MODE.load(Ordering::Relaxed) == 1;

        if use_delta && exc_count > 1 {
            let first_su64 = exc_u64[0];
            let mut max_zz: u64 = 0;
            let deltas = unsafe { &mut ALP_INTS[..exc_count - 1] };
            let mut delta_fits = true;
            for i in 0..exc_count - 1 {
                let cur = exc_u64[i + 1] as i128;
                let prev = exc_u64[i] as i128;
                let diff = cur - prev;
                if diff < i64::MIN as i128 || diff > i64::MAX as i128 {
                    delta_fits = false;
                    break;
                }
                let d64 = diff as i64;
                let zz = ((d64 << 1) ^ (d64 >> 63)) as u64;
                deltas[i] = zz as i64;
                if zz > max_zz {
                    max_zz = zz;
                }
            }

            if delta_fits {
                out[pos..pos + 8].copy_from_slice(&first_su64.to_be_bytes());
                pos += 8;
                let delta_bw = bits_needed(max_zz);
                out[pos] = delta_bw | 0x80;
                pos += 1;
                if delta_bw > 0 {
                    let mut w = BitWriter::new(&mut out[pos..]);
                    for i in 0..exc_count - 1 {
                        w.write_bits(deltas[i] as u64, delta_bw);
                    }
                    pos += w.bytes_written();
                }
            } else {
                // Delta too large — fall back to plain FoR.
                pos = write_for_exceptions(exc_u64, exc_count, out, pos);
            }
        } else {
            pos = write_for_exceptions(exc_u64, exc_count, out, pos);
        }
    }

    pos
}

/// Write plain FoR-encoded exceptions. Returns updated pos.
fn write_for_exceptions(exc_u64: &[u64], exc_count: usize, out: &mut [u8], mut pos: usize) -> usize {
    let mut min_su64: u64 = u64::MAX;
    let mut max_su64: u64 = 0;
    for i in 0..exc_count {
        if exc_u64[i] < min_su64 {
            min_su64 = exc_u64[i];
        }
        if exc_u64[i] > max_su64 {
            max_su64 = exc_u64[i];
        }
    }

    let exc_range = max_su64 - min_su64;
    let exc_bw = bits_needed(exc_range);

    out[pos..pos + 8].copy_from_slice(&min_su64.to_be_bytes());
    pos += 8;
    out[pos] = exc_bw;
    pos += 1;

    if exc_bw > 0 {
        let mut w = BitWriter::new(&mut out[pos..]);
        for i in 0..exc_count {
            w.write_bits(exc_u64[i] - min_su64, exc_bw);
        }
        pos += w.bytes_written();
    }
    pos
}

/// Decode regular ALP blob (not delta-ALP). Returns number of values decoded.
/// This is the non-dispatching version — use decode_values_alp_inner for
/// the full dispatcher that also handles delta-ALP.
pub(crate) fn alp_decode_regular(input: &[u8], val_out: &mut [f64]) -> usize {
    if input.len() < ALP_HEADER_SIZE {
        return 0;
    }

    let mut pos: usize = 0;
    let n = ((input[0] as usize) << 8) | (input[1] as usize);
    pos += 2;
    // Validate count against output capacity and codec limits before any
    // indexing. Malformed blobs should fail cleanly rather than trap.
    if n == 0 || n > ALP_MAX_CHUNK || n > val_out.len() {
        return 0;
    }
    let e = input[pos] as usize;
    pos += 1;
    // POW10 is 19 entries long (e in [0, 18]); rejects out-of-range exponents.
    if e > ALP_MAX_EXP {
        return 0;
    }
    let bw = input[pos];
    pos += 1;
    if bw > 64 {
        return 0;
    }
    let mut min_bytes = [0u8; 8];
    min_bytes.copy_from_slice(&input[pos..pos + 8]);
    let min_int = i64::from_be_bytes(min_bytes);
    pos += 8;
    let exc_count = ((input[pos] as usize) << 8) | (input[pos + 1] as usize);
    pos += 2;
    if exc_count > n {
        return 0;
    }

    let factor = POW10[e];
    // Ensure the packed payload is actually present before indexing into it.
    let packed_bytes = (n * bw as usize + 7) / 8;
    if bw > 0 && input.len() < pos + packed_bytes {
        return 0;
    }

    if bw > 0 && bw <= 57 {
        let packed = &input[pos..];
        let inv_factor = 1.0 / factor;
        let safe_limit = packed_safe_limit(packed.len(), n, bw);
        for i in 0..safe_limit {
            let offset = extract_packed(packed, i, bw);
            // Widen so offsets greater than i64::MAX reconstruct correctly.
            let value = (min_int as i128 + offset as i128) as i64;
            val_out[i] = value as f64 * inv_factor;
        }
        for i in safe_limit..n {
            let offset = extract_packed_safe(packed, i, bw);
            let value = (min_int as i128 + offset as i128) as i64;
            val_out[i] = value as f64 * inv_factor;
        }
        pos += packed_bytes;
    } else if bw > 57 {
        let mut r = BitReader::new(&input[pos..]);
        let inv_factor = 1.0 / factor;
        for i in 0..n {
            let offset = r.read_bits(bw);
            let value = (min_int as i128 + offset as i128) as i64;
            val_out[i] = value as f64 * inv_factor;
        }
        pos += packed_bytes;
    } else {
        let base = min_int as f64 / factor;
        for i in 0..n {
            val_out[i] = base;
        }
    }

    // Decode exceptions (handles both FoR and delta-FoR).
    if exc_count > 0 {
        crate::alp_exc::decode_exceptions(input, &mut pos, n, exc_count, val_out);
    }
    n
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    fn roundtrip(vals: &[f64]) {
        let n = vals.len();
        let mut buf = [0u8; 65536];
        let mut decoded = [0f64; 2048];
        let written = alp_encode_inner(vals, &mut buf);
        assert!(written > 0, "ALP encode failed for {n} values");
        let count = alp_decode_regular(&buf[..written], &mut decoded);
        assert_eq!(count, n);
        for i in 0..n {
            assert_eq!(decoded[i], vals[i], "mismatch at {i}");
        }
    }

    #[test]
    fn alp_basic_patterns() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        // Clean 2-decimal-place data
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        roundtrip(&vals);
        // Clean integers
        let vals: std::vec::Vec<f64> = (0..640).map(|i| i as f64).collect();
        roundtrip(&vals);
        // Constant value (bw=0)
        roundtrip(&[42.5f64; 100]);
        // Single and two values
        roundtrip(&[3.14]);
        roundtrip(&[1.0, 2.0]);
        // Large integers
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 1_000_000.0).collect();
        roundtrip(&vals);
    }

    #[test]
    fn alp_exceptions() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        // 100% exceptions (irrational values)
        let vals: std::vec::Vec<f64> = (0..100)
            .map(|i| core::f64::consts::PI * (i as f64 + 1.0))
            .collect();
        roundtrip(&vals);
        // Mixed: 90 clean + 10 exceptions
        let mut vals = std::vec::Vec::new();
        for i in 0..90 { vals.push(i as f64 * 0.1); }
        for i in 0..10 { vals.push(core::f64::consts::E * (i as f64 + 1.0)); }
        roundtrip(&vals);
    }

    #[test]
    fn alp_max_chunk() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals: std::vec::Vec<f64> = (0..2048).map(|i| (i as f64) * 0.001).collect();
        roundtrip(&vals);
    }

    #[test]
    fn alp_negative_values() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals: std::vec::Vec<f64> = (-50..50).map(|i| i as f64 * 0.1).collect();
        roundtrip(&vals);
    }

    #[test]
    fn alp_special_floats() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let vals = [1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 2.0];
        let mut buf = [0u8; 1024];
        let mut decoded = [0f64; 8];
        let written = alp_encode_inner(&vals, &mut buf);
        assert!(written > 0);
        let count = alp_decode_regular(&buf[..written], &mut decoded);
        assert_eq!(count, 5);
        assert_eq!(decoded[0], 1.0);
        assert!(decoded[1].is_nan());
        assert_eq!(decoded[2], f64::INFINITY);
        assert_eq!(decoded[3], f64::NEG_INFINITY);
        assert_eq!(decoded[4], 2.0);
    }

    // sortable_u64 round-trip + ordering moved to the workspace crate
    // (`o11y-codec-rt-alp`'s `sortable_roundtrip_finite_values` and
    // `sortable_preserves_total_order` tests).

    #[test]
    fn alp_try_and_exponent() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        assert_eq!(alp_try(1.23, 2), Some(123));
        assert_eq!(alp_try(0.0, 0), Some(0));
        assert_eq!(alp_try(42.0, 0), Some(42));
        assert_eq!(alp_try(f64::NAN, 2), None);
        assert_eq!(alp_try(f64::INFINITY, 2), None);
        // Clean 2dp data should pick e=2.
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        assert_eq!(alp_find_exponent(&vals), 2);
    }

    #[test]
    fn bits_needed_values() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        assert_eq!(bits_needed(0), 0);
        assert_eq!(bits_needed(1), 1);
        assert_eq!(bits_needed(255), 8);
        assert_eq!(bits_needed(256), 9);
        assert_eq!(bits_needed(u64::MAX), 64);
    }

    #[test]
    fn packed_safe_limit_small_buffer() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        // Buffer too small for any fast-path extraction.
        assert_eq!(packed_safe_limit(4, 10, 8), 0);
        // Buffer exactly 8 bytes: max_byte=0, no index safe.
        assert_eq!(packed_safe_limit(8, 10, 8), 0);
        // Buffer 9 bytes with bw=8: max_byte=1, max_i=1, index 0 safe.
        assert_eq!(packed_safe_limit(9, 10, 8), 1);
        // bw=0 always returns 0.
        assert_eq!(packed_safe_limit(100, 50, 0), 0);
        // Large buffer, all indices safe.
        assert_eq!(packed_safe_limit(1024, 10, 4), 10);
    }

    #[test]
    fn alp_encode_decode_empty_and_oversized() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let mut buf = [0u8; 128];
        // Empty slice should return 0.
        assert_eq!(alp_encode_inner(&[], &mut buf), 0);
        // Decoding empty input returns 0.
        let mut out = [0f64; 8];
        assert_eq!(alp_decode_regular(&[], &mut out), 0);
    }
}
