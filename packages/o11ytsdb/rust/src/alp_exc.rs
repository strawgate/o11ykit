// ── ALP exception decode ─────────────────────────────────────────────
//
// Decodes the exception section of an ALP-encoded blob. Exceptions are
// values that did not round-trip through the chosen decimal exponent.
// Two schemes: plain FoR on sortable-u64 offsets, or delta-FoR on
// zigzag-encoded deltas of sortable-u64 values.

use crate::alp::{packed_safe_limit, sortable_u64_to_f64, ALP_EXC_U64, ALP_MAX_CHUNK};
use crate::bitio::{extract_packed, extract_packed_safe, BitReader};

/// Decode exception values and patch them into val_out.
pub(crate) fn decode_exceptions(
    input: &[u8],
    pos: &mut usize,
    n: usize,
    exc_count: usize,
    val_out: &mut [f64],
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
    _pos: &mut usize,
    first_su64: u64,
    actual_bw: u8,
    exc_count: usize,
    n: usize,
    exc_positions: &[u16],
    val_out: &mut [f64],
) {
    let exc_u64 = unsafe { &mut ALP_EXC_U64[..exc_count] };
    exc_u64[0] = first_su64;

    if actual_bw > 0 {
        let mut r = BitReader::new(&input[*_pos..]);
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
            val_out[exc_positions[i] as usize] = sortable_u64_to_f64(exc_u64[i]);
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
