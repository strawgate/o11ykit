// ── ALP / Delta-ALP extern "C" shims ────────────────────────────────
//
// The pure-Rust codec lives in packages/o11y-codec-rt/alp/. This file
// is the WASM ABI surface only: convert raw pointers to slices, read
// the JS-settable `ALP_EXC_MODE` flag, and dispatch.

use core::sync::atomic::Ordering;

use crate::alloc::ALP_EXC_MODE;
use o11y_codec_rt_alp as alp;
use o11y_codec_rt_xor_delta::compute_stats;

#[inline(always)]
fn delta_for_exceptions() -> bool {
    ALP_EXC_MODE.load(Ordering::Relaxed) == 1
}

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
    alp::alp_encode(vals, out, delta_for_exceptions()) as u32
}

#[no_mangle]
pub extern "C" fn decodeValuesALP(
    in_ptr: *const u8,
    in_len: u32,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, max_samples as usize) };
    alp::decode_values_alp(input, val_out) as u32
}

#[no_mangle]
pub extern "C" fn decodeValuesALPRange(
    in_ptr: *const u8,
    in_len: u32,
    lo: u32,
    hi: u32,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, max_samples as usize) };
    alp::decode_values_alp_range(input, lo as usize, hi as usize, val_out) as u32
}

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
    let delta_for_exc = delta_for_exceptions();

    if alp::is_delta_alp_candidate(vals, reset_count) {
        let delta_size = alp::delta_alp_encode(vals, out, delta_for_exc);
        if delta_size > 0 {
            let plain_start = delta_size;
            if plain_start + n * 20 <= out.len() {
                let plain_size = alp::alp_encode(vals, &mut out[plain_start..], delta_for_exc);
                if plain_size > 0 && plain_size < delta_size {
                    out.copy_within(plain_start..plain_start + plain_size, 0);
                    return plain_size as u32;
                }
            }
            return delta_size as u32;
        }
    }
    alp::alp_encode(vals, out, delta_for_exc) as u32
}
