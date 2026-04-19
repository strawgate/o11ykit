// SIMD benchmark experiments for o11ytsdb ingest
//
// Three experiments, each with scalar baseline + SIMD variant:
//   1. ms → ns timestamp conversion (flush hot path)
//   2. Block stats computation (min/max/sum/sumSq for ALP encode)
//   3. FNV-1a batch hashing (4 independent hashes in parallel)

#![no_std]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── Scratch allocator ────────────────────────────────────────────────

static mut SCRATCH: [u8; 2 * 1024 * 1024] = [0u8; 2 * 1024 * 1024];
static mut SCRATCH_POS: usize = 0;

#[no_mangle]
pub extern "C" fn allocScratch(size: u32) -> u32 {
    let size = size as usize;
    let align = 16; // 128-bit alignment for SIMD loads
    unsafe {
        let aligned = (SCRATCH_POS + align - 1) & !(align - 1);
        if aligned + size > SCRATCH.len() {
            return 0;
        }
        SCRATCH_POS = aligned + size;
        SCRATCH.as_ptr().add(aligned) as u32
    }
}

#[no_mangle]
pub extern "C" fn resetScratch() {
    unsafe {
        SCRATCH_POS = 0;
    }
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 1: ms → ns conversion
//
// Current JS:  for (i) tsArr[i] = BigInt(msArr[i]!) * 1_000_000n
// WASM avoids per-element BigInt allocation entirely.
// ═════════════════════════════════════════════════════════════════════

#[no_mangle]
pub extern "C" fn ms_to_ns_scalar(in_ptr: *const f64, out_ptr: *mut i64, count: u32) {
    let n = count as usize;
    let input = unsafe { core::slice::from_raw_parts(in_ptr, n) };
    let output = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
    for i in 0..n {
        output[i] = (input[i] as i64) * 1_000_000;
    }
}

#[no_mangle]
pub extern "C" fn ms_to_ns_simd(in_ptr: *const f64, out_ptr: *mut i64, count: u32) {
    use core::arch::wasm32::*;
    let n = count as usize;
    let input = unsafe { core::slice::from_raw_parts(in_ptr, n) };
    let output = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
    let mul_vec = i64x2_splat(1_000_000);

    let pairs = n / 2;
    for i in 0..pairs {
        let idx = i * 2;
        // f64 → i64 must be scalar (no SIMD instruction exists)
        let a = input[idx] as i64;
        let b = input[idx + 1] as i64;
        let v = i64x2_replace_lane::<1>(i64x2_splat(a), b);
        let result = i64x2_mul(v, mul_vec);
        unsafe {
            v128_store(output.as_mut_ptr().add(idx) as *mut v128, result);
        }
    }
    // Remainder
    if n % 2 != 0 {
        output[n - 1] = (input[n - 1] as i64) * 1_000_000;
    }
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 2: Block stats (min/max/sum/sumOfSquares)
//
// Used in encodeValuesWithStats and encodeBatchValuesWithStats.
// Chunk size is typically 640 f64 values.
// ═════════════════════════════════════════════════════════════════════

#[no_mangle]
pub extern "C" fn stats_scalar(val_ptr: *const f64, count: u32, stats_ptr: *mut f64) {
    let n = count as usize;
    if n == 0 {
        return;
    }
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let stats = unsafe { core::slice::from_raw_parts_mut(stats_ptr, 8) };

    let mut min_v = vals[0];
    let mut max_v = vals[0];
    let mut sum = vals[0];
    let mut sum_sq = vals[0] * vals[0];
    let mut reset_count: u32 = 0;

    for i in 1..n {
        let v = vals[i];
        if v < min_v {
            min_v = v;
        }
        if v > max_v {
            max_v = v;
        }
        sum += v;
        sum_sq += v * v;
        if v < vals[i - 1] {
            reset_count += 1;
        }
    }

    stats[0] = min_v;
    stats[1] = max_v;
    stats[2] = sum;
    stats[3] = n as f64;
    stats[4] = vals[0];
    stats[5] = vals[n - 1];
    stats[6] = sum_sq;
    stats[7] = reset_count as f64;
}

#[no_mangle]
pub extern "C" fn stats_simd(val_ptr: *const f64, count: u32, stats_ptr: *mut f64) {
    use core::arch::wasm32::*;
    let n = count as usize;
    if n == 0 {
        return;
    }
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let stats = unsafe { core::slice::from_raw_parts_mut(stats_ptr, 8) };

    let mut min_v = f64x2_splat(f64::INFINITY);
    let mut max_v = f64x2_splat(f64::NEG_INFINITY);
    let mut sum_v = f64x2_splat(0.0);
    let mut sum_sq_v = f64x2_splat(0.0);
    let mut reset_count: u32 = 0;
    let mut prev = vals[0];

    // Process aligned pairs
    let pairs = n / 2;
    for i in 0..pairs {
        let v = unsafe { v128_load(val_ptr.add(i * 2) as *const v128) };
        min_v = f64x2_min(min_v, v);
        max_v = f64x2_max(max_v, v);
        sum_v = f64x2_add(sum_v, v);
        let sq = f64x2_mul(v, v);
        sum_sq_v = f64x2_add(sum_sq_v, sq);

        // Reset count must be scalar (sequential dependency on previous)
        let a = f64x2_extract_lane::<0>(v);
        let b = f64x2_extract_lane::<1>(v);
        if a < prev {
            reset_count += 1;
        }
        if b < a {
            reset_count += 1;
        }
        prev = b;
    }

    // Horizontal reduction
    let min_a = f64x2_extract_lane::<0>(min_v);
    let min_b = f64x2_extract_lane::<1>(min_v);
    let mut min_final = if min_a < min_b { min_a } else { min_b };

    let max_a = f64x2_extract_lane::<0>(max_v);
    let max_b = f64x2_extract_lane::<1>(max_v);
    let mut max_final = if max_a > max_b { max_a } else { max_b };

    let mut sum_final = f64x2_extract_lane::<0>(sum_v) + f64x2_extract_lane::<1>(sum_v);
    let mut sum_sq_final =
        f64x2_extract_lane::<0>(sum_sq_v) + f64x2_extract_lane::<1>(sum_sq_v);

    // Handle odd remainder
    if n % 2 != 0 {
        let v = vals[n - 1];
        if v < min_final {
            min_final = v;
        }
        if v > max_final {
            max_final = v;
        }
        sum_final += v;
        sum_sq_final += v * v;
        if v < prev {
            reset_count += 1;
        }
    }

    stats[0] = min_final;
    stats[1] = max_final;
    stats[2] = sum_final;
    stats[3] = n as f64;
    stats[4] = vals[0];
    stats[5] = vals[n - 1];
    stats[6] = sum_sq_final;
    stats[7] = reset_count as f64;
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 3: FNV-1a batch hashing (4-way SIMD)
//
// Hash 4 byte sequences of the same length simultaneously.
// Real-world use: multiple series share the same label keys,
// so their key-value strings are often the same length.
// ═════════════════════════════════════════════════════════════════════

const FNV_OFFSET: u32 = 0x811c9dc5;
const FNV_PRIME: u32 = 0x01000193;

/// Single FNV-1a hash (baseline reference).
#[no_mangle]
pub extern "C" fn fnv_single(data_ptr: *const u8, len: u32) -> u32 {
    let data = unsafe { core::slice::from_raw_parts(data_ptr, len as usize) };
    let mut hash = FNV_OFFSET;
    for &b in data {
        hash ^= b as u32;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Scalar: compute 4 independent FNV-1a hashes on equal-length byte sequences.
#[no_mangle]
pub extern "C" fn fnv_batch_scalar(
    p0: *const u8,
    p1: *const u8,
    p2: *const u8,
    p3: *const u8,
    len: u32,
    out_ptr: *mut u32,
) {
    let l = len as usize;
    let d0 = unsafe { core::slice::from_raw_parts(p0, l) };
    let d1 = unsafe { core::slice::from_raw_parts(p1, l) };
    let d2 = unsafe { core::slice::from_raw_parts(p2, l) };
    let d3 = unsafe { core::slice::from_raw_parts(p3, l) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, 4) };

    let mut h0 = FNV_OFFSET;
    let mut h1 = FNV_OFFSET;
    let mut h2 = FNV_OFFSET;
    let mut h3 = FNV_OFFSET;

    for i in 0..l {
        h0 ^= d0[i] as u32;
        h0 = h0.wrapping_mul(FNV_PRIME);
        h1 ^= d1[i] as u32;
        h1 = h1.wrapping_mul(FNV_PRIME);
        h2 ^= d2[i] as u32;
        h2 = h2.wrapping_mul(FNV_PRIME);
        h3 ^= d3[i] as u32;
        h3 = h3.wrapping_mul(FNV_PRIME);
    }

    out[0] = h0;
    out[1] = h1;
    out[2] = h2;
    out[3] = h3;
}

/// SIMD: compute 4 independent FNV-1a hashes using i32x4.
#[no_mangle]
pub extern "C" fn fnv_batch_simd(
    p0: *const u8,
    p1: *const u8,
    p2: *const u8,
    p3: *const u8,
    len: u32,
    out_ptr: *mut u32,
) {
    use core::arch::wasm32::*;
    let l = len as usize;
    let d0 = unsafe { core::slice::from_raw_parts(p0, l) };
    let d1 = unsafe { core::slice::from_raw_parts(p1, l) };
    let d2 = unsafe { core::slice::from_raw_parts(p2, l) };
    let d3 = unsafe { core::slice::from_raw_parts(p3, l) };

    let mut hash = i32x4_splat(FNV_OFFSET as i32);
    let prime = i32x4_splat(FNV_PRIME as i32);

    for i in 0..l {
        // Build char vector from 4 strings
        let c = i32x4_replace_lane::<3>(
            i32x4_replace_lane::<2>(
                i32x4_replace_lane::<1>(
                    i32x4_splat(d0[i] as i32),
                    d1[i] as i32,
                ),
                d2[i] as i32,
            ),
            d3[i] as i32,
        );
        hash = v128_xor(hash, c);
        hash = i32x4_mul(hash, prime);
    }

    unsafe {
        v128_store(out_ptr as *mut v128, hash);
    }
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 3b: FNV-1a N-string hashing
//
// More realistic: hash N strings (each with different length) one at
// a time, but entirely in WASM to avoid JS string overhead.
// Input: packed buffer of [len:u16, bytes...] entries.
// Output: u32 hashes.
// ═════════════════════════════════════════════════════════════════════

#[no_mangle]
pub extern "C" fn fnv_n_strings(
    packed_ptr: *const u8,
    total_bytes: u32,
    out_ptr: *mut u32,
    max_strings: u32,
) -> u32 {
    let data = unsafe { core::slice::from_raw_parts(packed_ptr, total_bytes as usize) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, max_strings as usize) };
    let mut pos: usize = 0;
    let mut count: usize = 0;
    let total = total_bytes as usize;

    while pos + 2 <= total && count < max_strings as usize {
        let len = ((data[pos] as usize) << 8) | (data[pos + 1] as usize);
        pos += 2;
        if pos + len > total {
            break;
        }
        let mut hash = FNV_OFFSET;
        for i in 0..len {
            hash ^= data[pos + i] as u32;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        out[count] = hash;
        count += 1;
        pos += len;
    }

    count as u32
}
