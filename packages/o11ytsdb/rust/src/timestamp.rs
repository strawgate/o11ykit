// ── Timestamp-only delta-of-delta extern "C" shims ──────────────────
//
// The pure-Rust codec lives in packages/o11y-codec-rt/xor-delta/. This
// file is the WASM ABI surface only.

use o11y_codec_rt_xor_delta as xd;

#[no_mangle]
pub extern "C" fn encodeTimestamps(
    ts_ptr: *const i64,
    count: u32,
    out_ptr: *mut u8,
    out_cap: u32,
) -> u32 {
    let n = count as usize;
    if n == 0 {
        return 0;
    }
    let ts = unsafe { core::slice::from_raw_parts(ts_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };
    xd::encode_timestamps(ts, out) as u32
}

#[no_mangle]
pub extern "C" fn decodeTimestamps(
    in_ptr: *const u8,
    in_len: u32,
    ts_ptr: *mut i64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let ts_out = unsafe { core::slice::from_raw_parts_mut(ts_ptr, max_samples as usize) };
    xd::decode_timestamps(input, ts_out) as u32
}
