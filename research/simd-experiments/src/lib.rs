// SIMD benchmark experiments for o11ytsdb
//
// Six experiments, each with scalar baseline + SIMD variant:
//   1. ms → ns timestamp conversion (flush hot path)
//   2. Block stats computation (min/max/sum/sumSq for ALP encode)
//   3. FNV-1a batch hashing (4 independent hashes in parallel)
//   4. ALP integer conversion: f64 × 10^e → i64 (encode hot loop)
//   5. ALP FoR decode: (min_int + offset) as f64 / factor (decode hot loop)
//   6. Quantize: Math.round(v * scale) / scale (appendBatch hot loop)

#![no_std]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── Scratch allocator ────────────────────────────────────────────────

static mut SCRATCH: [u8; 4 * 1024 * 1024] = [0u8; 4 * 1024 * 1024];
static mut SCRATCH_POS: usize = 0;

#[no_mangle]
pub extern "C" fn allocScratch(size: u32) -> u32 {
    let size = size as usize;
    let align = 16;
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

/// SIMD stats — two-pass to avoid lane extraction in hot loop.
/// Pass 1: SIMD min/max/sum/sumSq (no reset_count)
/// Pass 2: scalar reset_count only
#[no_mangle]
pub extern "C" fn stats_simd(val_ptr: *const f64, count: u32, stats_ptr: *mut f64) {
    use core::arch::wasm32::*;
    let n = count as usize;
    if n == 0 {
        return;
    }
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let stats = unsafe { core::slice::from_raw_parts_mut(stats_ptr, 8) };

    // ── Pass 1: SIMD for min/max/sum/sumSq (4 accumulators, no extraction) ──
    let mut min_v0 = f64x2_splat(f64::INFINITY);
    let mut min_v1 = f64x2_splat(f64::INFINITY);
    let mut max_v0 = f64x2_splat(f64::NEG_INFINITY);
    let mut max_v1 = f64x2_splat(f64::NEG_INFINITY);
    let mut sum_v0 = f64x2_splat(0.0);
    let mut sum_v1 = f64x2_splat(0.0);
    let mut sum_sq_v0 = f64x2_splat(0.0);
    let mut sum_sq_v1 = f64x2_splat(0.0);

    // Process 4 f64s per iteration (2 × f64x2) to hide latency
    let quads = n / 4;
    for i in 0..quads {
        let a = unsafe { v128_load(val_ptr.add(i * 4) as *const v128) };
        let b = unsafe { v128_load(val_ptr.add(i * 4 + 2) as *const v128) };
        min_v0 = f64x2_min(min_v0, a);
        min_v1 = f64x2_min(min_v1, b);
        max_v0 = f64x2_max(max_v0, a);
        max_v1 = f64x2_max(max_v1, b);
        sum_v0 = f64x2_add(sum_v0, a);
        sum_v1 = f64x2_add(sum_v1, b);
        let sq_a = f64x2_mul(a, a);
        let sq_b = f64x2_mul(b, b);
        sum_sq_v0 = f64x2_add(sum_sq_v0, sq_a);
        sum_sq_v1 = f64x2_add(sum_sq_v1, sq_b);
    }

    // Merge the two accumulator pairs
    let min_v = f64x2_min(min_v0, min_v1);
    let max_v = f64x2_max(max_v0, max_v1);
    let sum_v = f64x2_add(sum_v0, sum_v1);
    let sum_sq_v = f64x2_add(sum_sq_v0, sum_sq_v1);

    // Horizontal reduction (only 1 extraction each, outside loop)
    let min_a = f64x2_extract_lane::<0>(min_v);
    let min_b = f64x2_extract_lane::<1>(min_v);
    let mut min_final = if min_a < min_b { min_a } else { min_b };

    let max_a = f64x2_extract_lane::<0>(max_v);
    let max_b = f64x2_extract_lane::<1>(max_v);
    let mut max_final = if max_a > max_b { max_a } else { max_b };

    let mut sum_final = f64x2_extract_lane::<0>(sum_v) + f64x2_extract_lane::<1>(sum_v);
    let mut sum_sq_final =
        f64x2_extract_lane::<0>(sum_sq_v) + f64x2_extract_lane::<1>(sum_sq_v);

    // Handle remainder (up to 3 elements)
    for i in (quads * 4)..n {
        let v = vals[i];
        if v < min_final { min_final = v; }
        if v > max_final { max_final = v; }
        sum_final += v;
        sum_sq_final += v * v;
    }

    // ── Pass 2: scalar reset_count (sequential dependency) ──
    let mut reset_count: u32 = 0;
    for i in 1..n {
        if vals[i] < vals[i - 1] {
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

// ═════════════════════════════════════════════════════════════════════
// Experiment 4: ALP encode — f64 × 10^e → i64
//
// Hot inner loop of alp_encode_inner: convert f64 to integers via
// multiplication by power-of-10 + rounding. Tracks min/max i64.
// ═════════════════════════════════════════════════════════════════════

static POW10: [f64; 19] = [
    1.0, 10.0, 100.0, 1_000.0, 10_000.0, 100_000.0, 1_000_000.0,
    10_000_000.0, 100_000_000.0, 1_000_000_000.0, 10_000_000_000.0,
    100_000_000_000.0, 1_000_000_000_000.0, 10_000_000_000_000.0,
    100_000_000_000_000.0, 1_000_000_000_000_000.0, 10_000_000_000_000_000.0,
    100_000_000_000_000_000.0, 1_000_000_000_000_000_000.0,
];

/// Scalar ALP int conversion: multiply, round, store i64, track min/max.
/// Returns [min_int, max_int, exc_count] in out_meta (3 × i64).
#[no_mangle]
pub extern "C" fn alp_convert_scalar(
    val_ptr: *const f64,
    count: u32,
    exponent: u32,
    int_ptr: *mut i64,
    meta_ptr: *mut i64,
) {
    let n = count as usize;
    let e = exponent as usize;
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let ints = unsafe { core::slice::from_raw_parts_mut(int_ptr, n) };
    let meta = unsafe { core::slice::from_raw_parts_mut(meta_ptr, 3) };

    let factor = POW10[e];
    let mut min_int: i64 = i64::MAX;
    let mut max_int: i64 = i64::MIN;
    let mut exc_count: i64 = 0;

    for i in 0..n {
        let v = vals[i];
        let scaled = v * factor;
        if scaled.abs() > 9.2e18 || v.is_nan() || v.is_infinite() {
            ints[i] = 0;
            exc_count += 1;
            continue;
        }
        let int_val = if scaled >= 0.0 {
            (scaled + 0.5) as i64
        } else {
            -(((-scaled) + 0.5) as i64)
        };
        let reconstructed = int_val as f64 / factor;
        if reconstructed == v {
            ints[i] = int_val;
            if int_val < min_int { min_int = int_val; }
            if int_val > max_int { max_int = int_val; }
        } else {
            ints[i] = 0;
            exc_count += 1;
        }
    }

    meta[0] = min_int;
    meta[1] = max_int;
    meta[2] = exc_count;
}

/// SIMD ALP int conversion: vectorize the multiply+round, scalar exception check.
/// f64x2 handles the heavy arithmetic, scalar checks exact round-trip.
#[no_mangle]
pub extern "C" fn alp_convert_simd(
    val_ptr: *const f64,
    count: u32,
    exponent: u32,
    int_ptr: *mut i64,
    meta_ptr: *mut i64,
) {
    use core::arch::wasm32::*;
    let n = count as usize;
    let e = exponent as usize;
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let ints = unsafe { core::slice::from_raw_parts_mut(int_ptr, n) };
    let meta = unsafe { core::slice::from_raw_parts_mut(meta_ptr, 3) };

    let factor = POW10[e];
    let factor_v = f64x2_splat(factor);
    let half_v = f64x2_splat(0.5);
    let neg_half_v = f64x2_splat(-0.5);
    let mut min_int: i64 = i64::MAX;
    let mut max_int: i64 = i64::MIN;
    let mut exc_count: i64 = 0;

    let pairs = n / 2;
    for i in 0..pairs {
        let idx = i * 2;
        // SIMD multiply
        let v = unsafe { v128_load(val_ptr.add(idx) as *const v128) };
        let scaled = f64x2_mul(v, factor_v);

        // SIMD floor(scaled + 0.5) for positive, floor(scaled - 0.5) for negative
        // f64x2_nearest is round-to-even, not round-half-away-from-zero, 
        // so we must extract and do scalar rounding for exact ALP compat
        let s0 = f64x2_extract_lane::<0>(scaled);
        let s1 = f64x2_extract_lane::<1>(scaled);
        let v0 = vals[idx];
        let v1 = vals[idx + 1];

        // Value 0
        if s0.abs() > 9.2e18 || v0.is_nan() || v0.is_infinite() {
            ints[idx] = 0;
            exc_count += 1;
        } else {
            let iv = if s0 >= 0.0 { (s0 + 0.5) as i64 } else { -(((-s0) + 0.5) as i64) };
            if iv as f64 / factor == v0 {
                ints[idx] = iv;
                if iv < min_int { min_int = iv; }
                if iv > max_int { max_int = iv; }
            } else {
                ints[idx] = 0;
                exc_count += 1;
            }
        }

        // Value 1
        if s1.abs() > 9.2e18 || v1.is_nan() || v1.is_infinite() {
            ints[idx + 1] = 0;
            exc_count += 1;
        } else {
            let iv = if s1 >= 0.0 { (s1 + 0.5) as i64 } else { -(((-s1) + 0.5) as i64) };
            if iv as f64 / factor == v1 {
                ints[idx + 1] = iv;
                if iv < min_int { min_int = iv; }
                if iv > max_int { max_int = iv; }
            } else {
                ints[idx + 1] = 0;
                exc_count += 1;
            }
        }
    }

    // Remainder
    if n % 2 != 0 {
        let v = vals[n - 1];
        let scaled = v * factor;
        if scaled.abs() > 9.2e18 || v.is_nan() || v.is_infinite() {
            ints[n - 1] = 0;
            exc_count += 1;
        } else {
            let iv = if scaled >= 0.0 { (scaled + 0.5) as i64 } else { -(((-scaled) + 0.5) as i64) };
            if iv as f64 / factor == v {
                ints[n - 1] = iv;
                if iv < min_int { min_int = iv; }
                if iv > max_int { max_int = iv; }
            } else {
                ints[n - 1] = 0;
                exc_count += 1;
            }
        }
    }

    meta[0] = min_int;
    meta[1] = max_int;
    meta[2] = exc_count;
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 5: ALP FoR decode — (min_int + offset) / factor
//
// The hot decode loop: for each value, add offset to min, convert
// to f64, divide by factor. Offset is already unpacked as i64.
// ═════════════════════════════════════════════════════════════════════

/// Scalar ALP FoR reconstruction.
#[no_mangle]
pub extern "C" fn alp_reconstruct_scalar(
    offsets_ptr: *const i64,
    count: u32,
    min_int: i64,
    factor_exp: u32,
    out_ptr: *mut f64,
) {
    let n = count as usize;
    let offsets = unsafe { core::slice::from_raw_parts(offsets_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
    let factor = POW10[factor_exp as usize];

    for i in 0..n {
        out[i] = (min_int + offsets[i]) as f64 / factor;
    }
}

/// SIMD ALP FoR reconstruction using i64x2 add + f64x2 div.
#[no_mangle]
pub extern "C" fn alp_reconstruct_simd(
    offsets_ptr: *const i64,
    count: u32,
    min_int: i64,
    factor_exp: u32,
    out_ptr: *mut f64,
) {
    use core::arch::wasm32::*;
    let n = count as usize;
    let offsets = unsafe { core::slice::from_raw_parts(offsets_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
    let factor = POW10[factor_exp as usize];
    let min_v = i64x2_splat(min_int);
    let factor_v = f64x2_splat(factor);

    let pairs = n / 2;
    for i in 0..pairs {
        let idx = i * 2;
        let off = unsafe { v128_load(offsets_ptr.add(idx) as *const v128) };
        let int_val = i64x2_add(min_v, off);
        // i64 → f64 conversion: no SIMD instruction, must extract
        let a = i64x2_extract_lane::<0>(int_val) as f64;
        let b = i64x2_extract_lane::<1>(int_val) as f64;
        let fv = f64x2_replace_lane::<1>(f64x2_splat(a), b);
        let result = f64x2_div(fv, factor_v);
        unsafe {
            v128_store(out_ptr.add(idx) as *mut v128, result);
        }
    }

    // Remainder
    if n % 2 != 0 {
        out[n - 1] = (min_int + offsets[n - 1]) as f64 / factor;
    }
}

// ═════════════════════════════════════════════════════════════════════
// Experiment 6: Quantize — round(v * scale) / scale
//
// The ColumnStore.appendBatch hot loop when precision is set.
// ═════════════════════════════════════════════════════════════════════

/// Scalar quantize.
#[no_mangle]
pub extern "C" fn quantize_scalar(
    val_ptr: *const f64,
    count: u32,
    scale: f64,
    out_ptr: *mut f64,
) {
    let n = count as usize;
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
    let inv_scale = 1.0 / scale;

    for i in 0..n {
        // Equivalent to Math.round(v * scale) / scale
        let scaled = vals[i] * scale;
        let rounded = if scaled >= 0.0 {
            (scaled + 0.5) as i64 as f64
        } else {
            -(((-scaled) + 0.5) as i64 as f64)
        };
        out[i] = rounded * inv_scale;
    }
}

/// SIMD quantize using f64x2_nearest (round-to-even, slightly different
/// from Math.round for .5 cases, but adequate for precision quantization).
#[no_mangle]
pub extern "C" fn quantize_simd(
    val_ptr: *const f64,
    count: u32,
    scale: f64,
    out_ptr: *mut f64,
) {
    use core::arch::wasm32::*;
    let n = count as usize;
    let vals = unsafe { core::slice::from_raw_parts(val_ptr, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
    let scale_v = f64x2_splat(scale);
    let inv_scale_v = f64x2_splat(1.0 / scale);

    // 4-wide unrolled (2 × f64x2 per iteration)
    let quads = n / 4;
    for i in 0..quads {
        let idx = i * 4;
        let a = unsafe { v128_load(val_ptr.add(idx) as *const v128) };
        let b = unsafe { v128_load(val_ptr.add(idx + 2) as *const v128) };
        let sa = f64x2_mul(a, scale_v);
        let sb = f64x2_mul(b, scale_v);
        let ra = f64x2_nearest(sa);
        let rb = f64x2_nearest(sb);
        let oa = f64x2_mul(ra, inv_scale_v);
        let ob = f64x2_mul(rb, inv_scale_v);
        unsafe {
            v128_store(out_ptr.add(idx) as *mut v128, oa);
            v128_store(out_ptr.add(idx + 2) as *mut v128, ob);
        }
    }

    // Remainder
    let inv_scale = 1.0 / scale;
    for i in (quads * 4)..n {
        let scaled = vals[i] * scale;
        // Use same rounding as SIMD for consistency
        let rounded = if scaled >= 0.0 {
            (scaled + 0.5) as i64 as f64
        } else {
            -(((-scaled) + 0.5) as i64 as f64)
        };
        out[i] = rounded * inv_scale;
    }
}
