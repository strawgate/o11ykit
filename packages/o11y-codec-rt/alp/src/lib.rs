//! o11y-codec-rt-alp — ALP utility primitives.
//!
//! Pure, stateless helpers shared by ALP and Delta-ALP encode/decode.
//! The encode/decode bodies themselves still live in the o11ytsdb
//! binding crate because they currently rely on process-global scratch
//! buffers; that lift is a separate piece of work.
//!
//! Reference: Afroozeh et al., SIGMOD 2024 (ALP).

#![cfg_attr(not(test), no_std)]

// ── Constants ────────────────────────────────────────────────────────

/// Wire-format header size. 14 bytes: tag + flags + bw + min_int +
/// match_count + exc_count.
pub const ALP_HEADER_SIZE: usize = 14;

/// Maximum samples per chunk. Sized to match `o11ytsdb`'s scratch
/// buffers; consumers may use it to preallocate.
pub const ALP_MAX_CHUNK: usize = 2048;

/// Maximum decimal exponent searched by `alp_find_exponent`.
/// `POW10[ALP_MAX_EXP] = 1e18`, the largest f64 → i64 round-trippable
/// scale.
pub const ALP_MAX_EXP: usize = 18;

/// Powers of 10 from `1e0` through `1e18`. Indexed by exponent.
pub static POW10: [f64; 19] = [
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
    1e17, 1e18,
];

// ── Sortable u64 mapping (extends IEEE 754 monotonicity to negatives) ─

/// Convert f64 to a sortable u64 representation. IEEE 754 is monotonic
/// for positive floats; this extension flips bits so that u64 ordering
/// matches f64 ordering across the sign boundary.
#[inline(always)]
pub fn f64_to_sortable_u64(f: f64) -> u64 {
    let bits = f.to_bits();
    if bits & (1u64 << 63) != 0 {
        !bits
    } else {
        bits ^ (1u64 << 63)
    }
}

/// Inverse of `f64_to_sortable_u64`.
#[inline(always)]
pub fn sortable_u64_to_f64(u: u64) -> f64 {
    let sign = u >> 63;
    let mask = (sign << 63) | (sign.wrapping_sub(1));
    f64::from_bits(u ^ mask)
}

// ── Packed-array safe-index helper ───────────────────────────────────

/// Returns the largest index `i` (capped at `n`) such that an
/// `extract_packed`-style 8-byte read at bit offset `i * bw` stays
/// within `buf_len`. Useful for splitting a packed slice into a
/// "fast path" range and a tail that needs the safe-extract variant.
#[inline]
pub fn packed_safe_limit(buf_len: usize, n: usize, bw: u8) -> usize {
    if bw == 0 || buf_len < 8 {
        return 0;
    }
    let max_byte = buf_len - 8;
    let max_i = (max_byte * 8) / bw as usize;
    max_i.min(n)
}

// ── Range helper used by Frame-of-Reference choice ───────────────────

/// Returns `max - min` as `u64`, saturating-style: if `max < min` the
/// result is 0. The intermediate uses i128 to avoid overflow on
/// `i64::MIN..i64::MAX` ranges.
#[inline(always)]
pub fn i64_range_u64(min_int: i64, max_int: i64) -> u64 {
    if max_int >= min_int {
        (max_int as i128 - min_int as i128) as u64
    } else {
        0
    }
}

// ── ALP candidate test ───────────────────────────────────────────────

/// Returns `Some(int_val)` if `val * 10^e` round-trips through an
/// integer cast, else `None`. The bit-pattern equality check (rather
/// than `==`) preserves the sign of -0.0 so it doesn't silently
/// collapse to +0.0 during encode.
#[inline(always)]
pub fn alp_try(val: f64, e: usize) -> Option<i64> {
    if val.is_nan() || val.is_infinite() {
        return None;
    }
    let scaled = val * POW10[e];
    if scaled.abs() > 9.2e18 {
        return None;
    }
    let int_val = if scaled >= 0.0 {
        (scaled + 0.5) as i64
    } else {
        -(((-scaled) + 0.5) as i64)
    };
    let reconstructed = int_val as f64 / POW10[e];
    if reconstructed.to_bits() == val.to_bits() {
        Some(int_val)
    } else {
        None
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── sortable_u64 ─────────────────────────────────────────────────

    #[test]
    fn sortable_roundtrip_finite_values() {
        let cases: &[f64] = &[
            0.0, -0.0, 1.0, -1.0, 1e-300, -1e-300, 1e300, -1e300, f64::MIN, f64::MAX,
            f64::MIN_POSITIVE, -f64::MIN_POSITIVE,
        ];
        for &f in cases {
            let u = f64_to_sortable_u64(f);
            let back = sortable_u64_to_f64(u);
            assert_eq!(back.to_bits(), f.to_bits(), "roundtrip failed for {f}");
        }
    }

    #[test]
    fn sortable_preserves_total_order() {
        // a < b in f64 must imply f64_to_sortable_u64(a) < (b).
        // (-0.0, +0.0) is intentionally not in this set: IEEE 754
        // compares them equal, but they have different sortable u64
        // values — covered by the dedicated test below.
        let pairs: &[(f64, f64)] = &[
            (-2.0, -1.0),
            (-1.0, 0.0),
            (0.0, 1e-300),
            (1.0, 2.0),
            (-1e10, 1e10),
            (f64::MIN, f64::MAX),
        ];
        for &(a, b) in pairs {
            assert!(a < b);
            assert!(
                f64_to_sortable_u64(a) < f64_to_sortable_u64(b),
                "ordering broken for {a} < {b}"
            );
        }
    }

    #[test]
    fn sortable_distinguishes_neg_zero_from_pos_zero() {
        // The bit-pattern roundtrip test above already proves the inverse
        // mapping; here we pin that the sortable mapping itself separates
        // -0.0 from +0.0.
        assert_ne!(f64_to_sortable_u64(-0.0), f64_to_sortable_u64(0.0));
        assert!(f64_to_sortable_u64(-0.0) < f64_to_sortable_u64(0.0));
    }

    // ── i64_range_u64 ────────────────────────────────────────────────

    #[test]
    fn range_basic() {
        assert_eq!(i64_range_u64(0, 10), 10);
        assert_eq!(i64_range_u64(-5, 5), 10);
        assert_eq!(i64_range_u64(7, 7), 0);
    }

    #[test]
    fn range_inverted_returns_zero() {
        assert_eq!(i64_range_u64(10, 0), 0);
    }

    #[test]
    fn range_extreme_values_no_overflow() {
        assert_eq!(i64_range_u64(i64::MIN, i64::MAX), u64::MAX);
    }

    // ── packed_safe_limit ────────────────────────────────────────────

    #[test]
    fn packed_safe_limit_zero_bw_or_tiny_buf() {
        assert_eq!(packed_safe_limit(100, 50, 0), 0);
        assert_eq!(packed_safe_limit(7, 50, 8), 0);
    }

    #[test]
    fn packed_safe_limit_caps_at_n() {
        // Plenty of buffer; should return n.
        assert_eq!(packed_safe_limit(10_000, 50, 8), 50);
    }

    #[test]
    fn packed_safe_limit_constrains_by_buffer() {
        // 16-byte buffer, bw=8 → max_byte = 8, max_i = 64/8 = 8.
        assert_eq!(packed_safe_limit(16, 50, 8), 8);
    }

    // ── alp_try ──────────────────────────────────────────────────────

    #[test]
    fn alp_try_simple_decimals() {
        // 1.5 at e=1 → 15 round-trips.
        assert_eq!(alp_try(1.5, 1), Some(15));
        // 3.14 at e=2 → 314 round-trips.
        assert_eq!(alp_try(3.14, 2), Some(314));
        // 1.0 at e=0 → 1 round-trips.
        assert_eq!(alp_try(1.0, 0), Some(1));
    }

    #[test]
    fn alp_try_rejects_non_round_trip() {
        // 0.1 at e=0: 0 round-trips to 0.0, not 0.1. None.
        assert_eq!(alp_try(0.1, 0), None);
    }

    #[test]
    fn alp_try_rejects_nan_and_inf() {
        assert_eq!(alp_try(f64::NAN, 2), None);
        assert_eq!(alp_try(f64::INFINITY, 2), None);
        assert_eq!(alp_try(f64::NEG_INFINITY, 2), None);
    }

    #[test]
    fn alp_try_preserves_negative_zero() {
        // -0.0 at e=0: 0.0 round-trips to +0.0 (different bit pattern).
        // Must reject so encode doesn't silently collapse the sign.
        assert_eq!(alp_try(-0.0, 0), None);
    }

    #[test]
    fn alp_try_overflow_rejected() {
        // 1e19 * 10^0 = 1e19, larger than the 9.2e18 i64 limit.
        assert_eq!(alp_try(1e19, 0), None);
    }
}
