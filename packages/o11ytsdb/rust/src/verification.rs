// ── Kani formal verification proofs ────────────────────────────────
//
// Mathematical guarantees for codec primitives. Each proof targets
// either a bug we found and fixed, or a critical correctness property.
//
// Bug fix proofs:
//   1. write_bits(_, 0) no-op       — was UB (u8 << 8)
//   2. packed_safe_limit prevents OOB — naive n-8 guard panicked
//   3. ALP FoR range i128 cast      — (max - min) as u64 overflowed
//
// Roundtrip/correctness proofs:
//   4. zigzag encode/decode          — lossless for all i64
//   5. bits_needed                   — tight (minimal and sufficient)
//   6. sortable_u64                  — lossless roundtrip for all bits
//   7. sortable_u64 ordering         — preserves f64 total order
//   8. BitWriter/BitReader           — single-value roundtrip, all widths

use o11y_codec_rt_alp::{
    alp_try, f64_to_sortable_u64, i64_range_u64, is_delta_alp_candidate, packed_safe_limit,
    sortable_u64_to_f64,
};
use o11y_codec_rt_core::{bits_needed, zigzag_decode, zigzag_encode, BitReader, BitWriter};
use o11y_codec_rt_xor_delta::compute_stats;

// ── Bug Fix #1: write_bits(_, 0) was shift-overflow UB ──────────────

#[kani::proof]
fn verify_write_bits_zero_count_is_noop() {
    let mut buf = [0u8; 16];
    let mut w = BitWriter::new(&mut buf);

    // Advance to an arbitrary byte-aligned position
    let advance: u8 = kani::any_where(|&a| a <= 12);
    for _ in 0..advance {
        w.write_bits(0, 8);
    }
    let pre_byte = w.byte_pos;
    let pre_bit = w.bit_pos;

    let value: u64 = kani::any();
    w.write_bits(value, 0);

    assert_eq!(w.byte_pos, pre_byte);
    assert_eq!(w.bit_pos, pre_bit);
}

// ── Bug Fix #2: packed_safe_limit guarantees no OOB ─────────────────
// Property: for all i < packed_safe_limit(buf_len, n, bw),
//   the byte range [byte_pos .. byte_pos+8] is within buf_len.

#[kani::proof]
fn verify_packed_safe_limit_prevents_oob() {
    let buf_len: usize = kani::any_where(|&l| l <= 256);
    let bw: u8 = kani::any_where(|&b| b >= 1 && b <= 57);
    let n: usize = kani::any_where(|&n| n <= 128);

    let safe = packed_safe_limit(buf_len, n, bw);

    // For any index below the safe limit, byte access is inbounds
    if safe > 0 {
        let i: usize = kani::any_where(|&i| i < safe);
        let bit_offset = i * bw as usize;
        let byte_pos = bit_offset >> 3;
        assert!(
            byte_pos + 8 <= buf_len,
            "OOB: byte_pos={} buf_len={}",
            byte_pos,
            buf_len
        );
    }

    // Safe limit never exceeds n
    assert!(safe <= n);

    kani::cover!(safe > 0, "non-zero safe limit");
    kani::cover!(safe == 0 && buf_len >= 8, "zero limit despite room");
    kani::cover!(buf_len < 8, "buffer too small");
}

// Also verify that packed_safe_limit(_, _, 0) always returns 0
#[kani::proof]
fn verify_packed_safe_limit_zero_bw() {
    let buf_len: usize = kani::any_where(|&l| l <= 256);
    let n: usize = kani::any_where(|&n| n <= 128);
    assert_eq!(packed_safe_limit(buf_len, n, 0), 0);
}

// ── Bug Fix #3: ALP FoR range doesn't overflow ──────────────────────
// The old code: (max_int - min_int) as u64  overflows when range spans
// more than i64::MAX (e.g. min=-5, max=i64::MAX).
// The fix: go through i128.

#[kani::proof]
fn verify_alp_for_range_no_overflow() {
    let min_int: i64 = kani::any();
    let max_int: i64 = kani::any();
    kani::assume(max_int >= min_int);

    let range = i64_range_u64(min_int, max_int);

    // Verify reconstruction: min + range == max
    let reconstructed = (min_int as i128 + range as i128) as i64;
    assert_eq!(reconstructed, max_int);

    kani::cover!(min_int < 0 && max_int > 0, "cross-zero range");
    kani::cover!(min_int == i64::MIN, "min at i64::MIN");
    kani::cover!(max_int == i64::MAX, "max at i64::MAX");
    kani::cover!(
        min_int == i64::MIN && max_int == i64::MAX,
        "full i64 range"
    );
}

// ── Zigzag encode/decode: lossless for all i64 ─────────────────────

#[kani::proof]
fn verify_zigzag_roundtrip() {
    let v: i64 = kani::any();

    let encoded = zigzag_encode(v);
    let decoded = zigzag_decode(encoded);
    assert_eq!(v, decoded);

    // Non-negative → even, negative → odd
    if v >= 0 {
        assert_eq!(encoded, (v as u64) * 2);
    } else {
        assert_eq!(encoded % 2, 1);
    }

    kani::cover!(v == 0, "zero");
    kani::cover!(v == i64::MIN, "i64::MIN");
    kani::cover!(v == i64::MAX, "i64::MAX");
    kani::cover!(v == -1, "minus one");
}

#[kani::proof]
fn verify_zigzag_decode_encode_roundtrip() {
    let u: u64 = kani::any();
    let decoded = zigzag_decode(u);
    let re_encoded = zigzag_encode(decoded);
    assert_eq!(u, re_encoded);
}

// ── bits_needed: tight bound ────────────────────────────────────────
// bits_needed(val) returns the minimum number of bits to represent val.

#[kani::proof]
fn verify_bits_needed_tight() {
    let val: u64 = kani::any();
    let bw = bits_needed(val);

    assert!(bw <= 64);

    if val == 0 {
        assert_eq!(bw, 0);
    } else {
        // val fits in bw bits
        assert!(bw >= 1);
        if bw < 64 {
            assert!(val < (1u64 << bw));
        }
        // val does NOT fit in (bw - 1) bits (tightness)
        if bw > 1 {
            assert!(val >= (1u64 << (bw - 1)));
        }
    }
}

// ── Sortable u64: lossless roundtrip ────────────────────────────────

#[kani::proof]
fn verify_sortable_u64_roundtrip() {
    let bits: u64 = kani::any();
    let f = f64::from_bits(bits);
    let sortable = f64_to_sortable_u64(f);
    let recovered = sortable_u64_to_f64(sortable);
    // Bit-exact roundtrip (handles NaN, ±0, ±inf)
    assert_eq!(bits, recovered.to_bits());
}

// ── Sortable u64: order preservation ────────────────────────────────
// For non-NaN floats: a < b ⟹ sortable(a) < sortable(b)

#[kani::proof]
fn verify_sortable_u64_order_preserving() {
    let a_bits: u64 = kani::any();
    let b_bits: u64 = kani::any();
    let a = f64::from_bits(a_bits);
    let b = f64::from_bits(b_bits);

    // Exclude NaN (no total order for NaN in IEEE 754)
    kani::assume(!a.is_nan() && !b.is_nan());

    let sa = f64_to_sortable_u64(a);
    let sb = f64_to_sortable_u64(b);

    if a < b {
        assert!(sa < sb, "order not preserved: a < b but sa >= sb");
    } else if a > b {
        assert!(sa > sb, "order not preserved: a > b but sa <= sb");
    }
    // a == b: +0.0 == -0.0 in IEEE but have different bits;
    // sortable representation may differ — that's fine.

    kani::cover!(a < 0.0 && b > 0.0, "negative to positive");
    kani::cover!(a == 0.0 && b > 0.0, "zero to positive");
}

// ── BitWriter/BitReader: single-value roundtrip ─────────────────────

#[kani::proof]
#[kani::unwind(20)]
fn verify_bitwriter_reader_roundtrip_single() {
    let count: u8 = kani::any_where(|&c| c <= 64);
    let value: u64 = kani::any();

    // Mask value to count bits
    let masked = if count == 0 {
        0u64
    } else if count == 64 {
        value
    } else {
        value & ((1u64 << count) - 1)
    };

    let mut buf = [0u8; 16];
    let mut w = BitWriter::new(&mut buf);
    w.write_bits(masked, count);

    if count > 0 {
        let mut r = BitReader::new(&buf);
        let read_back = r.read_bits(count);
        assert_eq!(masked, read_back, "roundtrip failed for count={}", count);
    }

    kani::cover!(count == 0, "zero width (bug fix case)");
    kani::cover!(count == 1, "single bit");
    kani::cover!(count == 8, "byte-aligned fast path");
    kani::cover!(count == 16, "16-bit fast path");
    kani::cover!(count == 64, "full 64-bit fast path");
    kani::cover!(count == 57, "boundary of fast read path");
    kani::cover!(count > 0 && count < 8, "sub-byte");
}

// ── ALP helper and stats proofs ───────────────────────────────────────

#[kani::proof]
fn verify_alp_try_rejects_nonfinite() {
    assert!(alp_try(f64::NAN, 0).is_none());
    assert!(alp_try(f64::INFINITY, 0).is_none());
    assert!(alp_try(f64::NEG_INFINITY, 0).is_none());
}

#[kani::proof]
#[kani::unwind(6)]
fn verify_compute_stats_small_values() {
    let vals = [
        kani::any::<u8>() as f64,
        kani::any::<u8>() as f64,
        kani::any::<u8>() as f64,
    ];
    let mut stats = [0.0f64; 8];
    let reset_count = compute_stats(&vals, &mut stats);

    let min_v = vals[0].min(vals[1]).min(vals[2]);
    let max_v = vals[0].max(vals[1]).max(vals[2]);
    let sum = vals[0] + vals[1] + vals[2];
    let sum_sq = vals[0] * vals[0] + vals[1] * vals[1] + vals[2] * vals[2];
    let expected_reset_count = (vals[1] < vals[0]) as u32 + (vals[2] < vals[1]) as u32;

    assert_eq!(reset_count, expected_reset_count);
    assert_eq!(stats[0], min_v);
    assert_eq!(stats[1], max_v);
    assert_eq!(stats[2], sum);
    assert_eq!(stats[3], 3.0);
    assert_eq!(stats[4], vals[0]);
    assert_eq!(stats[5], vals[2]);
    assert_eq!(stats[6], sum_sq);
    assert_eq!(stats[7], expected_reset_count as f64);

    kani::cover!(reset_count == 0, "no resets");
    kani::cover!(reset_count > 0, "one or more resets");
}

// ── Delta-ALP candidate detection: compose with compute_stats ─────────

#[kani::proof]
#[kani::unwind(8)]
fn verify_delta_alp_candidate_cases() {
    let base = kani::any::<i16>() as f64;
    let inc1 = (kani::any::<u8>() % 10 + 1) as f64;
    let inc2 = (kani::any::<u8>() % 10 + 1) as f64;
    let inc3 = (kani::any::<u8>() % 10 + 1) as f64;
    let mut vals = [base, base + inc1, base + inc1 + inc2, base + inc1 + inc2 + inc3];
    let case: u8 = kani::any_where(|&c| c <= 4);

    match case {
        1 => vals[3] = vals[0],
        2 => vals[1] += 0.5,
        3 => vals[2] = f64::NAN,
        4 => vals[2] = vals[1] - 1.0,
        _ => {}
    }

    let mut stats = [0.0f64; 8];
    let reset_count = compute_stats(&vals, &mut stats);
    let candidate = is_delta_alp_candidate(&vals, reset_count);

    if case == 0 {
        assert!(candidate);
    } else {
        assert!(!candidate);
    }

    if candidate {
        assert_eq!(reset_count, 0);
        assert!(vals[0] < vals[3]);
        for v in vals {
            assert!(!v.is_nan() && !v.is_infinite());
            assert_eq!(v, (v as i64) as f64);
        }
    }

    kani::cover!(case == 0 && candidate, "valid candidate accepted");
    kani::cover!(case == 1 && !candidate, "non-increasing rejected");
    kani::cover!(case == 2 && !candidate, "fractional rejected");
    kani::cover!(case == 3 && !candidate, "nan rejected");
    kani::cover!(case == 4 && !candidate, "reset rejected");
}
