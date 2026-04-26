// ── XOR-Delta (Gorilla) extern "C" shims ────────────────────────────
//
// The pure-Rust codec lives in packages/o11y-codec-rt/xor-delta/. This
// file is the WASM ABI surface only: convert raw pointers to slices
// and dispatch.

use o11y_codec_rt_xor_delta as xd;

// ── Combined chunk encode/decode ─────────────────────────────────────

#[no_mangle]
pub extern "C" fn encodeChunk(
    ts_ptr: *const i64,
    val_ptr: *const f64,
    count: u32,
    out_ptr: *mut u8,
    out_cap: u32,
) -> u32 {
    let n = count as usize;
    if n == 0 {
        return 0;
    }
    let ts = unsafe { core::slice::from_raw_parts(ts_ptr, n) };
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };
    xd::encode_chunk(ts, vals, out) as u32
}

#[no_mangle]
pub extern "C" fn decodeChunk(
    in_ptr: *const u8,
    in_len: u32,
    ts_ptr: *mut i64,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let ts_out = unsafe { core::slice::from_raw_parts_mut(ts_ptr, max_samples as usize) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, max_samples as usize) };
    xd::decode_chunk(input, ts_out, val_out) as u32
}

#[no_mangle]
pub extern "C" fn encodeChunkWithStats(
    ts_ptr: *const i64,
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
    xd::compute_stats(vals, stats);
    encodeChunk(ts_ptr, val_ptr, count, out_ptr, out_cap)
}

// ── Values-only encode/decode ────────────────────────────────────────

#[no_mangle]
pub extern "C" fn encodeValues(
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
    xd::encode_values(vals, out) as u32
}

#[no_mangle]
pub extern "C" fn decodeValues(
    in_ptr: *const u8,
    in_len: u32,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, max_samples as usize) };
    xd::decode_values(input, val_out) as u32
}

#[no_mangle]
pub extern "C" fn encodeValuesWithStats(
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
    xd::compute_stats(vals, stats);
    encodeValues(val_ptr, count, out_ptr, out_cap)
}
