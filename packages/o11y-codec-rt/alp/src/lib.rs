//! o11y-codec-rt-alp — ALP / Delta-ALP codec.
//!
//! Adaptive Lossless floating-Point: per-chunk decimal-exponent search,
//! Frame-of-Reference integer encoding, bit-packed offsets, FoR or
//! delta-FoR encoded exceptions. Delta-ALP wraps ALP with a leading
//! delta pass for monotonic integer-valued counter series.
//!
//! Pure-Rust slice-in / slice-out API. The WASM `extern "C"` surface
//! lives in each consuming engine's binding crate. Scratch buffers
//! used during encode/decode are stack-allocated; on `wasm32-unknown-
//! unknown` (1 MB default stack) the worst-case ~50 KB residency is
//! safe.
//!
//! Reference: Afroozeh et al., SIGMOD 2024 (ALP).

#![cfg_attr(not(test), no_std)]

use o11y_codec_rt_core::{bits_needed, extract_packed, extract_packed_safe, BitReader, BitWriter};

// ── Constants ────────────────────────────────────────────────────────

/// Wire-format header size. 14 bytes: tag + flags + bw + min_int +
/// match_count + exc_count.
pub const ALP_HEADER_SIZE: usize = 14;

/// Maximum samples per chunk. Sized for the WASM stack: scratch
/// buffers used during encode total ~34 KB at this cap (16 KB for
/// `i64` ints, 2 KB for exception flags, 16 KB for sortable-u64
/// exception values). Delta-ALP adds another 16 KB for the
/// per-row delta buffer.
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

/// Tag byte at offset 0 of a delta-ALP blob, distinguishing it from a
/// regular ALP blob (whose first byte is the high byte of `count >> 8`,
/// which fits in [0, 8] given `count ≤ 2048`). 0xDA never collides.
pub const DELTA_ALP_TAG: u8 = 0xDA;

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

// ── ALP exponent search ──────────────────────────────────────────────

/// Sample values to find the best decimal exponent, using a cost model.
pub fn alp_find_exponent(vals: &[f64]) -> u8 {
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

// ── ALP encode ───────────────────────────────────────────────────────

/// Core ALP encoding. Returns bytes written, or 0 on rejection
/// (empty input, oversized chunk, undersized output buffer).
///
/// `delta_for_exceptions` enables delta-Frame-of-Reference encoding of
/// the exception block (engines toggle this from a JS-settable mode
/// flag; the codec doesn't read process state).
pub fn alp_encode(vals: &[f64], out: &mut [u8], delta_for_exceptions: bool) -> usize {
    let n = vals.len();
    if n == 0 || n > ALP_MAX_CHUNK || out.len() < ALP_HEADER_SIZE {
        return 0;
    }

    // Stack scratch. ~34 KB total; safe within the WASM 1 MB stack.
    let mut ints_buf = [0i64; ALP_MAX_CHUNK];
    let mut exc_buf = [0u8; ALP_MAX_CHUNK];

    // Step 1: Find best exponent.
    let e = alp_find_exponent(vals);

    // Step 2: Convert to integers, mark exceptions.
    let mut min_int: i64 = i64::MAX;
    let mut max_int: i64 = i64::MIN;
    let mut exc_count: usize = 0;

    for i in 0..n {
        match alp_try(vals[i], e as usize) {
            Some(iv) => {
                ints_buf[i] = iv;
                exc_buf[i] = 0;
                if iv < min_int {
                    min_int = iv;
                }
                if iv > max_int {
                    max_int = iv;
                }
            }
            None => {
                ints_buf[i] = 0;
                exc_buf[i] = 1;
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
            if exc_buf[i] == 0 {
                // Widen to i128 so wide cross-zero blocks (range > i64::MAX)
                // do not wrap during subtraction.
                let offset = (ints_buf[i] as i128 - min_int as i128) as u64;
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
            if exc_buf[i] != 0 {
                out[pos] = (i >> 8) as u8;
                out[pos + 1] = i as u8;
                pos += 2;
            }
        }
    }

    // Step 7: Encode exception values (FoR or delta-FoR).
    if exc_count > 0 {
        let mut exc_u64_buf = [0u64; ALP_MAX_CHUNK];
        let exc_u64 = &mut exc_u64_buf[..exc_count];
        let mut ei = 0;
        for i in 0..n {
            if exc_buf[i] != 0 {
                exc_u64[ei] = f64_to_sortable_u64(vals[i]);
                ei += 1;
            }
        }

        if delta_for_exceptions && exc_count > 1 {
            let first_su64 = exc_u64[0];
            let mut max_zz: u64 = 0;
            // Reuse `ints_buf` for delta storage; it's no longer needed.
            let deltas = &mut ints_buf[..exc_count - 1];
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

// ── ALP decode (regular) ─────────────────────────────────────────────

/// Decode a regular ALP blob (not delta-ALP). For the dispatcher that
/// transparently handles either form, see `decode_values_alp`.
pub fn alp_decode_regular(input: &[u8], val_out: &mut [f64]) -> usize {
    if input.len() < ALP_HEADER_SIZE {
        return 0;
    }

    let mut pos: usize = 0;
    let n = ((input[0] as usize) << 8) | (input[1] as usize);
    pos += 2;
    if n == 0 || n > ALP_MAX_CHUNK || n > val_out.len() {
        return 0;
    }
    let e = input[pos] as usize;
    pos += 1;
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

    if exc_count > 0 {
        decode_exceptions(input, &mut pos, n, exc_count, val_out);
    }
    n
}

// ── Exception decode ─────────────────────────────────────────────────

/// Decode the exception section of an ALP blob and patch values into
/// `val_out`. Two schemes are dispatched on the bw byte's high bit:
/// plain FoR on sortable-u64 offsets, or delta-FoR on zigzag-encoded
/// deltas of sortable-u64 values.
pub fn decode_exceptions(
    input: &[u8],
    pos: &mut usize,
    n: usize,
    exc_count: usize,
    val_out: &mut [f64],
) {
    if exc_count > ALP_MAX_CHUNK {
        return;
    }
    let pos_bytes = if exc_count < n { exc_count * 2 } else { 0 };
    if input.len().saturating_sub(*pos) < pos_bytes + 9 {
        return;
    }

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
        decode_delta_for_exceptions(
            input, pos, header_u64, actual_bw, exc_count, n, &exc_positions, val_out,
        );
    } else {
        decode_for_exceptions(
            input, pos, header_u64, actual_bw, exc_count, n, &exc_positions, val_out,
        );
    }
}

fn decode_delta_for_exceptions(
    input: &[u8],
    pos: &mut usize,
    first_su64: u64,
    actual_bw: u8,
    exc_count: usize,
    n: usize,
    exc_positions: &[u16],
    val_out: &mut [f64],
) {
    let mut exc_u64_buf = [0u64; ALP_MAX_CHUNK];
    let exc_u64 = &mut exc_u64_buf[..exc_count];
    exc_u64[0] = first_su64;

    if actual_bw > 0 {
        let mut r = BitReader::new(&input[*pos..]);
        let mut prev = first_su64;
        for i in 1..exc_count {
            let zz = r.read_bits(actual_bw);
            let d = ((zz >> 1) as i64) ^ (-((zz & 1) as i64));
            let cur = (prev as i128 + d as i128) as u64;
            exc_u64[i] = cur;
            prev = cur;
        }
    } else {
        for i in 1..exc_count {
            exc_u64[i] = first_su64;
        }
    }

    if exc_count == n {
        for i in 0..n {
            val_out[i] = sortable_u64_to_f64(exc_u64[i]);
        }
    } else {
        for i in 0..exc_count {
            let idx = exc_positions[i] as usize;
            if idx >= n || idx >= val_out.len() {
                return;
            }
            val_out[idx] = sortable_u64_to_f64(exc_u64[i]);
        }
    }
}

fn decode_for_exceptions(
    input: &[u8],
    pos: &mut usize,
    min_su64: u64,
    exc_bw: u8,
    exc_count: usize,
    n: usize,
    exc_positions: &[u16],
    val_out: &mut [f64],
) {
    if exc_count == n {
        if exc_bw > 0 && exc_bw <= 57 {
            let packed = &input[*pos..];
            let safe_limit = packed_safe_limit(packed.len(), n, exc_bw);
            for i in 0..safe_limit {
                val_out[i] = sortable_u64_to_f64(min_su64 + extract_packed(packed, i, exc_bw));
            }
            for i in safe_limit..n {
                val_out[i] =
                    sortable_u64_to_f64(min_su64 + extract_packed_safe(packed, i, exc_bw));
            }
        } else if exc_bw > 0 {
            let mut r = BitReader::new(&input[*pos..]);
            for i in 0..n {
                val_out[i] = sortable_u64_to_f64(min_su64 + r.read_bits(exc_bw));
            }
        } else {
            let base = sortable_u64_to_f64(min_su64);
            for i in 0..n {
                val_out[i] = base;
            }
        }
    } else {
        for i in 0..exc_count {
            let idx = exc_positions[i] as usize;
            if idx >= n || idx >= val_out.len() {
                return;
            }
        }
        if exc_bw > 0 && exc_bw <= 57 {
            let packed = &input[*pos..];
            let safe_limit = packed_safe_limit(packed.len(), exc_count, exc_bw);
            for i in 0..safe_limit {
                val_out[exc_positions[i] as usize] =
                    sortable_u64_to_f64(min_su64 + extract_packed(packed, i, exc_bw));
            }
            for i in safe_limit..exc_count {
                val_out[exc_positions[i] as usize] =
                    sortable_u64_to_f64(min_su64 + extract_packed_safe(packed, i, exc_bw));
            }
        } else if exc_bw > 0 {
            let mut r = BitReader::new(&input[*pos..]);
            for i in 0..exc_count {
                val_out[exc_positions[i] as usize] =
                    sortable_u64_to_f64(min_su64 + r.read_bits(exc_bw));
            }
        } else {
            let base = sortable_u64_to_f64(min_su64);
            for i in 0..exc_count {
                val_out[exc_positions[i] as usize] = base;
            }
        }
    }
}

// ── Delta-ALP candidate test ─────────────────────────────────────────

/// Detect whether `vals` is a monotonically non-decreasing
/// integer-valued counter — the shape that delta-ALP excels at.
pub fn is_delta_alp_candidate(vals: &[f64], reset_count: u32) -> bool {
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

// ── Delta-ALP encode/decode ──────────────────────────────────────────

/// Encode values using delta-before-ALP. Returns bytes written, or 0
/// on failure.
pub fn delta_alp_encode(vals: &[f64], out: &mut [u8], delta_for_exceptions: bool) -> usize {
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

    let mut deltas_buf = [0.0f64; ALP_MAX_CHUNK];
    let deltas = &mut deltas_buf[..n - 1];
    for i in 0..n - 1 {
        deltas[i] = vals[i + 1] - vals[i];
    }

    let bytes_written = alp_encode(deltas, &mut out[pos..], delta_for_exceptions);
    if bytes_written == 0 {
        return 0;
    }
    pos += bytes_written;
    pos
}

/// Decode a delta-ALP blob. Input must start with `DELTA_ALP_TAG`.
fn delta_alp_decode(input: &[u8], val_out: &mut [f64]) -> usize {
    if input.len() < 23 || input[0] != DELTA_ALP_TAG {
        return 0;
    }

    let mut base_bytes = [0u8; 8];
    base_bytes.copy_from_slice(&input[1..9]);
    let base = f64::from_bits(u64::from_be_bytes(base_bytes));
    val_out[0] = base;

    let mut deltas_buf = [0.0f64; ALP_MAX_CHUNK];
    let delta_count = alp_decode_regular(&input[9..], &mut deltas_buf);
    if delta_count == 0 {
        return 0;
    }

    let mut acc = base;
    for i in 0..delta_count {
        acc += deltas_buf[i];
        val_out[i + 1] = acc;
    }
    delta_count + 1
}

/// Decode only `values[lo..hi]` from a delta-ALP blob.
pub fn delta_alp_decode_range(input: &[u8], lo: usize, hi: usize, out: &mut [f64]) -> usize {
    if input.len() < 23 || input[0] != DELTA_ALP_TAG {
        return 0;
    }

    let mut base_bytes = [0u8; 8];
    base_bytes.copy_from_slice(&input[1..9]);
    let base = f64::from_bits(u64::from_be_bytes(base_bytes));

    let mut deltas_buf = [0.0f64; ALP_MAX_CHUNK];
    let delta_count = alp_decode_regular(&input[9..], &mut deltas_buf);
    if delta_count == 0 {
        return 0;
    }
    let total_n = delta_count + 1;
    let effective_hi = hi.min(total_n);
    if lo >= effective_hi {
        return 0;
    }
    let span = effective_hi - lo;
    if span > out.len() {
        return 0;
    }

    let mut acc = base;
    for i in 0..lo {
        if i < delta_count {
            acc += deltas_buf[i];
        }
    }

    if lo == 0 {
        out[0] = base;
        for i in 1..span {
            acc += deltas_buf[lo + i - 1];
            out[i] = acc;
        }
    } else {
        out[0] = acc;
        for i in 1..span {
            acc += deltas_buf[lo + i - 1];
            out[i] = acc;
        }
    }
    span
}

// ── Top-level dispatch (handles both regular ALP and delta-ALP) ──────

/// Decode ALP values from a compressed blob. Handles both regular ALP
/// and delta-ALP (tag 0xDA) transparently.
pub fn decode_values_alp(input: &[u8], val_out: &mut [f64]) -> usize {
    if input.is_empty() {
        return 0;
    }
    if input[0] == DELTA_ALP_TAG {
        return delta_alp_decode(input, val_out);
    }
    alp_decode_regular(input, val_out)
}

/// Decode only `values[lo..hi]`. Handles both regular ALP and delta-ALP
/// transparently. Returns 0 on malformed input or out-of-range request.
pub fn decode_values_alp_range(input: &[u8], lo: usize, hi: usize, out: &mut [f64]) -> usize {
    if input.is_empty() {
        return 0;
    }
    if input[0] == DELTA_ALP_TAG {
        return delta_alp_decode_range(input, lo, hi, out);
    }

    if input.len() < ALP_HEADER_SIZE {
        return 0;
    }

    let mut pos: usize = 0;
    let n = ((input[0] as usize) << 8) | (input[1] as usize);
    pos += 2;
    if n == 0 || n > ALP_MAX_CHUNK {
        return 0;
    }
    let effective_hi = hi.min(n);
    if lo >= effective_hi {
        return 0;
    }
    let span = effective_hi - lo;
    if span > out.len() {
        return 0;
    }

    let e = input[pos] as usize;
    pos += 1;
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
    let bit_packed_start = pos;
    let packed_bytes = (n * bw as usize + 7) / 8;
    if bw > 0 && input.len() < bit_packed_start + packed_bytes {
        return 0;
    }

    if bw > 0 {
        let start_bit = lo * bw as usize;
        let byte_offset = start_bit / 8;
        let bit_offset = (start_bit % 8) as u8;
        let mut r = BitReader {
            buf: &input[bit_packed_start + byte_offset..],
            byte_pos: 0,
            bit_pos: bit_offset,
        };
        for i in 0..span {
            let offset = r.read_bits(bw);
            let value = (min_int as i128 + offset as i128) as i64;
            out[i] = value as f64 / factor;
        }
        pos = bit_packed_start + packed_bytes;
    } else {
        let base = min_int as f64 / factor;
        for i in 0..span {
            out[i] = base;
        }
    }

    if exc_count > 0 {
        decode_range_exceptions(input, &mut pos, n, exc_count, lo, effective_hi, out);
    }
    span
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
        let mut exc_u64_buf = [0u64; ALP_MAX_CHUNK];
        let exc_u64 = &mut exc_u64_buf[..exc_count];
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
        } else if exc_bw > 0 {
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
        assert_eq!(packed_safe_limit(10_000, 50, 8), 50);
    }

    #[test]
    fn packed_safe_limit_constrains_by_buffer() {
        assert_eq!(packed_safe_limit(16, 50, 8), 8);
    }

    // ── alp_try ──────────────────────────────────────────────────────

    #[test]
    fn alp_try_simple_decimals() {
        assert_eq!(alp_try(1.5, 1), Some(15));
        assert_eq!(alp_try(3.14, 2), Some(314));
        assert_eq!(alp_try(1.0, 0), Some(1));
    }

    #[test]
    fn alp_try_rejects_non_round_trip() {
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
        assert_eq!(alp_try(-0.0, 0), None);
    }

    #[test]
    fn alp_try_overflow_rejected() {
        assert_eq!(alp_try(1e19, 0), None);
    }

    // ── alp_find_exponent ────────────────────────────────────────────

    #[test]
    fn alp_find_exponent_clean_2dp() {
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        assert_eq!(alp_find_exponent(&vals), 2);
    }

    // ── ALP encode/decode roundtrip ──────────────────────────────────

    fn roundtrip(vals: &[f64]) {
        let n = vals.len();
        let mut buf = [0u8; 65536];
        let mut decoded = [0f64; 2048];
        let written = alp_encode(vals, &mut buf, false);
        assert!(written > 0, "ALP encode failed for {n} values");
        let count = alp_decode_regular(&buf[..written], &mut decoded);
        assert_eq!(count, n);
        for i in 0..n {
            assert_eq!(decoded[i], vals[i], "mismatch at {i}");
        }
    }

    #[test]
    fn alp_basic_patterns() {
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        roundtrip(&vals);
        let vals: std::vec::Vec<f64> = (0..640).map(|i| i as f64).collect();
        roundtrip(&vals);
        roundtrip(&[42.5f64; 100]);
        roundtrip(&[3.14]);
        roundtrip(&[1.0, 2.0]);
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 1_000_000.0).collect();
        roundtrip(&vals);
    }

    #[test]
    fn alp_exceptions_all_then_partial() {
        let vals: std::vec::Vec<f64> = (0..100)
            .map(|i| core::f64::consts::PI * (i as f64 + 1.0))
            .collect();
        roundtrip(&vals);
        let mut vals = std::vec::Vec::new();
        for i in 0..90 {
            vals.push(i as f64 * 0.1);
        }
        for i in 0..10 {
            vals.push(core::f64::consts::E * (i as f64 + 1.0));
        }
        roundtrip(&vals);
    }

    #[test]
    fn alp_max_chunk() {
        let vals: std::vec::Vec<f64> = (0..2048).map(|i| (i as f64) * 0.001).collect();
        roundtrip(&vals);
    }

    #[test]
    fn alp_negative_values() {
        let vals: std::vec::Vec<f64> = (-50..50).map(|i| i as f64 * 0.1).collect();
        roundtrip(&vals);
    }

    #[test]
    fn alp_special_floats() {
        let vals = [1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 2.0];
        let mut buf = [0u8; 1024];
        let mut decoded = [0f64; 8];
        let written = alp_encode(&vals, &mut buf, false);
        assert!(written > 0);
        let count = alp_decode_regular(&buf[..written], &mut decoded);
        assert_eq!(count, 5);
        assert_eq!(decoded[0], 1.0);
        assert!(decoded[1].is_nan());
        assert_eq!(decoded[2], f64::INFINITY);
        assert_eq!(decoded[3], f64::NEG_INFINITY);
        assert_eq!(decoded[4], 2.0);
    }

    #[test]
    fn alp_empty_and_oversized() {
        let mut buf = [0u8; 128];
        assert_eq!(alp_encode(&[], &mut buf, false), 0);
        let mut out = [0f64; 8];
        assert_eq!(alp_decode_regular(&[], &mut out), 0);
    }

    #[test]
    fn alp_tiny_output_buffer_returns_zero() {
        // Header is 14 bytes; a 13-byte buffer must be rejected.
        let mut buf = [0u8; 13];
        assert_eq!(alp_encode(&[1.0], &mut buf, false), 0);
    }

    // ── Exception path roundtrips ────────────────────────────────────

    #[test]
    fn for_exceptions_roundtrip() {
        let vals: std::vec::Vec<f64> = (0..50)
            .map(|i| core::f64::consts::PI * (i as f64 + 1.0))
            .collect();
        roundtrip(&vals);
    }

    #[test]
    fn partial_exceptions_roundtrip() {
        let mut vals = std::vec::Vec::new();
        for i in 0..40 {
            vals.push(i as f64 * 0.25);
        }
        for i in 0..10 {
            vals.push(core::f64::consts::SQRT_2 * (i as f64 + 1.0));
        }
        roundtrip(&vals);
    }

    #[test]
    fn delta_for_exceptions_via_flag() {
        // Cluster of exceptions whose deltas are small — delta-FoR
        // should win on storage.
        let mut vals = std::vec::Vec::new();
        for i in 0..90 {
            vals.push(i as f64 * 0.01);
        }
        for i in 0..10 {
            vals.push(core::f64::consts::E + (i as f64) * 0.0001);
        }
        let mut buf = [0u8; 65536];
        let mut decoded = [0f64; 2048];
        let written = alp_encode(&vals, &mut buf, true);
        assert!(written > 0);
        let count = alp_decode_regular(&buf[..written], &mut decoded);
        assert_eq!(count, 100);
        for i in 0..100 {
            assert_eq!(decoded[i].to_bits(), vals[i].to_bits(), "mismatch at {i}");
        }
    }

    // ── Delta-ALP candidate test ─────────────────────────────────────

    #[test]
    fn candidate_basics() {
        let vals: std::vec::Vec<f64> = (0..100).map(|i| i as f64).collect();
        assert!(is_delta_alp_candidate(&vals, 0));
        assert!(!is_delta_alp_candidate(&[1.0, 0.0], 1));
        assert!(!is_delta_alp_candidate(&[5.0, 5.0, 5.0], 0));
        assert!(!is_delta_alp_candidate(&[1.0, 1.5, 2.0], 0));
        assert!(!is_delta_alp_candidate(&[1.0], 0));
    }

    #[test]
    fn candidate_non_integer_rejected() {
        let vals = [1.5, 2.5, 3.5];
        assert!(!is_delta_alp_candidate(&vals, 0));
    }

    #[test]
    fn candidate_decreasing_rejected() {
        let vals = [10.0, 5.0, 2.0];
        assert!(!is_delta_alp_candidate(&vals, 0));
    }

    #[test]
    fn candidate_with_resets_rejected() {
        let vals = [1.0, 2.0, 3.0];
        assert!(!is_delta_alp_candidate(&vals, 1));
    }

    #[test]
    fn candidate_single_value_rejected() {
        assert!(!is_delta_alp_candidate(&[1.0], 0));
    }

    #[test]
    fn candidate_nan_inf_rejected() {
        assert!(!is_delta_alp_candidate(&[1.0, f64::NAN, 3.0], 0));
        assert!(!is_delta_alp_candidate(&[1.0, f64::INFINITY, 3.0], 0));
    }

    // ── Delta-ALP encode/decode ──────────────────────────────────────

    #[test]
    fn delta_alp_roundtrip_counter() {
        let vals: std::vec::Vec<f64> = (0..640).map(|i| (i * 100) as f64).collect();
        let mut buf = [0u8; 65536];
        let written = delta_alp_encode(&vals, &mut buf, false);
        assert!(written > 0);
        assert_eq!(buf[0], DELTA_ALP_TAG);
        let mut decoded = [0f64; 2048];
        let count = decode_values_alp(&buf[..written], &mut decoded);
        assert_eq!(count, 640);
        for i in 0..640 {
            assert_eq!(decoded[i], vals[i], "mismatch at {i}");
        }
    }

    #[test]
    fn delta_alp_range() {
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i * 10) as f64).collect();
        let mut buf = [0u8; 65536];
        let written = delta_alp_encode(&vals, &mut buf, false);
        assert!(written > 0);
        let mut out = [0f64; 10];
        let count = delta_alp_decode_range(&buf[..written], 10, 20, &mut out);
        assert_eq!(count, 10);
        for i in 0..10 {
            assert_eq!(out[i], vals[10 + i], "range mismatch at {i}");
        }
    }

    #[test]
    fn dispatch_picks_regular_alp() {
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        let mut buf = [0u8; 65536];
        let written = alp_encode(&vals, &mut buf, false);
        assert!(written > 0);
        // First byte is the high byte of count=100 (= 0), not DELTA_ALP_TAG.
        assert_eq!(buf[0], 0);
        let mut decoded = [0f64; 2048];
        let count = decode_values_alp(&buf[..written], &mut decoded);
        assert_eq!(count, 100);
    }

    #[test]
    fn range_decode_regular_alp() {
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        let mut buf = [0u8; 65536];
        let written = alp_encode(&vals, &mut buf, false);
        assert!(written > 0);
        let mut out = [0f64; 10];
        let count = decode_values_alp_range(&buf[..written], 10, 20, &mut out);
        assert_eq!(count, 10);
        for i in 0..10 {
            assert_eq!(out[i], vals[10 + i], "range mismatch at {i}");
        }
    }

    #[test]
    fn range_decode_clamps_hi_to_available() {
        let vals: std::vec::Vec<f64> = (0..10).map(|i| i as f64).collect();
        let mut buf = [0u8; 65536];
        let written = alp_encode(&vals, &mut buf, false);
        assert!(written > 0);
        let mut out = [-1f64; 10];
        let count = decode_values_alp_range(&buf[..written], 8, 20, &mut out);
        assert_eq!(count, 2);
        assert_eq!(out[0], vals[8]);
        assert_eq!(out[1], vals[9]);
    }
}
