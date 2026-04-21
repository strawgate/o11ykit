// ── Batch encode/decode: XOR and ALP bulk operations ────────────────
//
// Eliminates N JS↔WASM boundary crossings when freezing/thawing
// groups of co-scraped series in one call.

use crate::alp::alp_encode_inner;
use crate::delta_alp::{
    decode_values_alp_inner, delta_alp_encode_inner, is_delta_alp_candidate,
};
use crate::gorilla::{compute_stats, decode_values_inner, encode_values_inner};

// ── Batch XOR encode ─────────────────────────────────────────────────

/// Encode multiple value arrays in a single WASM call (XOR codec).
#[no_mangle]
pub extern "C" fn encodeBatchValuesWithStats(
    vals_ptr: *const f64,
    chunk_size: u32,
    num_arrays: u32,
    out_ptr: *mut u8,
    out_cap: u32,
    offsets_ptr: *mut u32,
    sizes_ptr: *mut u32,
    stats_ptr: *mut f64,
) -> u32 {
    let n_arrays = num_arrays as usize;
    let cs = chunk_size as usize;
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };
    let offsets = unsafe { core::slice::from_raw_parts_mut(offsets_ptr, n_arrays) };
    let sizes = unsafe { core::slice::from_raw_parts_mut(sizes_ptr, n_arrays) };
    let all_stats = unsafe { core::slice::from_raw_parts_mut(stats_ptr, n_arrays * 8) };

    let mut total_out: usize = 0;

    for a in 0..n_arrays {
        let vals = unsafe { core::slice::from_raw_parts(vals_ptr.add(a * cs), cs) };
        let stats = &mut all_stats[a * 8..(a + 1) * 8];
        compute_stats(vals, stats);

        offsets[a] = total_out as u32;
        let remaining = &mut out[total_out..];
        let bytes_written = encode_values_inner(vals, remaining);
        sizes[a] = bytes_written as u32;
        total_out += bytes_written;
    }

    total_out as u32
}

// ── Batch ALP encode ─────────────────────────────────────────────────

/// Batch ALP encode: encode N value arrays in one WASM call.
#[no_mangle]
pub extern "C" fn encodeBatchValuesALPWithStats(
    vals_ptr: *const f64,
    chunk_size: u32,
    num_arrays: u32,
    out_ptr: *mut u8,
    out_cap: u32,
    offsets_ptr: *mut u32,
    sizes_ptr: *mut u32,
    stats_ptr: *mut f64,
) -> u32 {
    let n_arrays = num_arrays as usize;
    let cs = chunk_size as usize;
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };
    let offsets = unsafe { core::slice::from_raw_parts_mut(offsets_ptr, n_arrays) };
    let sizes = unsafe { core::slice::from_raw_parts_mut(sizes_ptr, n_arrays) };
    let all_stats = unsafe { core::slice::from_raw_parts_mut(stats_ptr, n_arrays * 8) };

    let mut total_out: usize = 0;

    for a in 0..n_arrays {
        let vals = unsafe { core::slice::from_raw_parts(vals_ptr.add(a * cs), cs) };
        let stats = &mut all_stats[a * 8..(a + 1) * 8];
        let reset_count = compute_stats(vals, stats);

        offsets[a] = total_out as u32;
        let remaining = &mut out[total_out..];

        let bytes_written = if is_delta_alp_candidate(vals, reset_count) {
            let delta_size = delta_alp_encode_inner(vals, remaining);
            if delta_size > 0 {
                let plain_start = delta_size;
                let cap_left = remaining.len() - plain_start;
                if cap_left > 0 {
                    let plain_size = alp_encode_inner(vals, &mut remaining[plain_start..]);
                    if plain_size > 0 && plain_size < delta_size {
                        remaining.copy_within(plain_start..plain_start + plain_size, 0);
                        plain_size
                    } else {
                        delta_size
                    }
                } else {
                    delta_size
                }
            } else {
                alp_encode_inner(vals, remaining)
            }
        } else {
            alp_encode_inner(vals, remaining)
        };

        sizes[a] = bytes_written as u32;
        total_out += bytes_written;
    }

    total_out as u32
}

// ── Batch XOR decode ─────────────────────────────────────────────────

/// Batch decode N XOR-compressed value arrays in one WASM call.
#[no_mangle]
pub extern "C" fn decodeBatchValues(
    blobs_ptr: *const u8,
    offsets_ptr: *const u32,
    sizes_ptr: *const u32,
    num_blobs: u32,
    out_ptr: *mut f64,
    chunk_size: u32,
) -> u32 {
    let nb = num_blobs as usize;
    let cs = chunk_size as usize;
    let offsets = unsafe { core::slice::from_raw_parts(offsets_ptr, nb) };
    let sizes = unsafe { core::slice::from_raw_parts(sizes_ptr, nb) };
    let blobs_base = blobs_ptr;

    for a in 0..nb {
        let blob = unsafe {
            core::slice::from_raw_parts(blobs_base.add(offsets[a] as usize), sizes[a] as usize)
        };
        let val_out = unsafe { core::slice::from_raw_parts_mut(out_ptr.add(a * cs), cs) };
        decode_values_inner(blob, val_out);
    }

    nb as u32
}

/// Batch decode N ALP-compressed value arrays in one WASM call.
#[no_mangle]
pub extern "C" fn decodeBatchValuesALP(
    blobs_ptr: *const u8,
    offsets_ptr: *const u32,
    sizes_ptr: *const u32,
    num_blobs: u32,
    out_ptr: *mut f64,
    chunk_size: u32,
) -> u32 {
    let nb = num_blobs as usize;
    let cs = chunk_size as usize;
    let offsets = unsafe { core::slice::from_raw_parts(offsets_ptr, nb) };
    let sizes = unsafe { core::slice::from_raw_parts(sizes_ptr, nb) };
    let blobs_base = blobs_ptr;

    for a in 0..nb {
        let blob = unsafe {
            core::slice::from_raw_parts(blobs_base.add(offsets[a] as usize), sizes[a] as usize)
        };
        let val_out = unsafe { core::slice::from_raw_parts_mut(out_ptr.add(a * cs), cs) };
        decode_values_alp_inner(blob, val_out);
    }

    nb as u32
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use crate::gorilla::{encodeValues, decodeValues};

    #[test]
    fn batch_xor_single_array() {
        let vals: [f64; 10] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        let mut out = [0u8; 1024];
        let mut offsets = [0u32; 1];
        let mut sizes = [0u32; 1];
        let mut stats = [0.0f64; 8];

        let total = encodeBatchValuesWithStats(
            vals.as_ptr(), 10, 1,
            out.as_mut_ptr(), 1024,
            offsets.as_mut_ptr(), sizes.as_mut_ptr(), stats.as_mut_ptr(),
        );
        assert!(total > 0);
        assert_eq!(offsets[0], 0);
        assert!(sizes[0] > 0);
        assert_eq!(stats[0], 1.0);  // min
        assert_eq!(stats[1], 10.0); // max

        let mut decoded = [0f64; 10];
        let count = decodeBatchValues(
            out.as_ptr(), offsets.as_ptr(), sizes.as_ptr(), 1,
            decoded.as_mut_ptr(), 10,
        );
        assert_eq!(count, 1);
        assert_eq!(decoded, vals);
    }

    #[test]
    fn batch_xor_multiple_arrays() {
        let cs = 10;
        let mut vals = [0f64; 30];
        for i in 0..30 {
            vals[i] = (i as f64) * 0.1;
        }
        let mut out = [0u8; 4096];
        let mut offsets = [0u32; 3];
        let mut sizes = [0u32; 3];
        let mut stats = [0.0f64; 24]; // 3 × 8

        let total = encodeBatchValuesWithStats(
            vals.as_ptr(), cs as u32, 3,
            out.as_mut_ptr(), 4096,
            offsets.as_mut_ptr(), sizes.as_mut_ptr(), stats.as_mut_ptr(),
        );
        assert!(total > 0);

        let mut decoded = [0f64; 30];
        let count = decodeBatchValues(
            out.as_ptr(), offsets.as_ptr(), sizes.as_ptr(), 3,
            decoded.as_mut_ptr(), cs as u32,
        );
        assert_eq!(count, 3);
        assert_eq!(decoded, vals);
    }

    #[test]
    fn batch_alp_single_array() {
        let vals: std::vec::Vec<f64> = (0..100).map(|i| (i as f64) * 0.01).collect();
        let mut out = [0u8; 4096];
        let mut offsets = [0u32; 1];
        let mut sizes = [0u32; 1];
        let mut stats = [0.0f64; 8];

        let total = encodeBatchValuesALPWithStats(
            vals.as_ptr(), 100, 1,
            out.as_mut_ptr(), 4096,
            offsets.as_mut_ptr(), sizes.as_mut_ptr(), stats.as_mut_ptr(),
        );
        assert!(total > 0);

        let mut decoded = [0f64; 100];
        let count = decodeBatchValuesALP(
            out.as_ptr(), offsets.as_ptr(), sizes.as_ptr(), 1,
            decoded.as_mut_ptr(), 100,
        );
        assert_eq!(count, 1);
        assert_eq!(&decoded[..100], vals.as_slice());
    }

    #[test]
    fn batch_alp_counter_uses_delta() {
        let vals: std::vec::Vec<f64> = (0..640).map(|i| (i * 100) as f64).collect();
        let mut out = [0u8; 65536];
        let mut offsets = [0u32; 1];
        let mut sizes = [0u32; 1];
        let mut stats = [0.0f64; 8];

        let total = encodeBatchValuesALPWithStats(
            vals.as_ptr(), 640, 1,
            out.as_mut_ptr(), 65536,
            offsets.as_mut_ptr(), sizes.as_mut_ptr(), stats.as_mut_ptr(),
        );
        assert!(total > 0);

        let mut decoded = [0f64; 640];
        let count = decodeBatchValuesALP(
            out.as_ptr(), offsets.as_ptr(), sizes.as_ptr(), 1,
            decoded.as_mut_ptr(), 640,
        );
        assert_eq!(count, 1);
        for i in 0..640 {
            assert_eq!(decoded[i], vals[i], "mismatch at {i}");
        }
    }
}
