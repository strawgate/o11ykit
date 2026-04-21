// ── SIMD accelerators: msToNs, quantizeBatch ────────────────────────
//
// WASM SIMD-accelerated bulk transforms:
//   - msToNs: convert f64 millisecond timestamps to i64 nanoseconds
//   - quantizeBatch: round f64 values to a given decimal precision

/// Convert an array of f64 millisecond timestamps to i64 nanosecond timestamps.
/// Uses SIMD i64x2_mul to process 2 timestamps per iteration.
#[no_mangle]
pub extern "C" fn msToNs(in_ptr: *const f64, out_ptr: *mut i64, count: u32) {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        let n = count as usize;
        let input = unsafe { core::slice::from_raw_parts(in_ptr, n) };
        let output = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };

        let pairs = n / 2;
        let scale = f64x2_splat(1_000_000.0);
        for i in 0..pairs {
            let idx = i * 2;
            let v = unsafe { v128_load(input.as_ptr().add(idx) as *const v128) };
            let scaled = f64x2_mul(v, scale);
            let a = f64x2_extract_lane::<0>(scaled) as i64;
            let b = f64x2_extract_lane::<1>(scaled) as i64;
            let result = i64x2_replace_lane::<1>(i64x2_splat(a), b);
            unsafe {
                v128_store(output.as_mut_ptr().add(idx) as *mut v128, result);
            }
        }
        if n % 2 != 0 {
            output[n - 1] = (input[n - 1] * 1_000_000.0) as i64;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let n = count as usize;
        let input = unsafe { core::slice::from_raw_parts(in_ptr, n) };
        let output = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
        for i in 0..n {
            output[i] = (input[i] * 1_000_000.0) as i64;
        }
    }
}

/// Quantize an array of f64 values to a given decimal precision.
/// Equivalent to: out[i] = round(in[i] * scale) / scale
///
/// Note: Uses IEEE 754 round-half-to-even (banker's rounding) on WASM,
/// round-half-away-from-zero on native. Acceptable for metric quantization.
#[no_mangle]
pub extern "C" fn quantizeBatch(
    in_ptr: *const f64,
    out_ptr: *mut f64,
    count: u32,
    scale: f64,
) {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        let n = count as usize;
        let inv_scale = 1.0 / scale;
        let scale_v = f64x2_splat(scale);
        let inv_scale_v = f64x2_splat(inv_scale);

        let quads = n / 4;
        for i in 0..quads {
            let idx = i * 4;
            let a = unsafe { v128_load(in_ptr.add(idx) as *const v128) };
            let b = unsafe { v128_load(in_ptr.add(idx + 2) as *const v128) };
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

        let input = unsafe { core::slice::from_raw_parts(in_ptr, n) };
        let output = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
        for i in (quads * 4)..n {
            let scaled = input[i] * scale;
            output[i] =
                f64x2_extract_lane::<0>(f64x2_nearest(f64x2_splat(scaled))) * inv_scale;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let n = count as usize;
        let input = unsafe { core::slice::from_raw_parts(in_ptr, n) };
        let output = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
        let inv_scale = 1.0 / scale;
        for i in 0..n {
            let scaled = input[i] * scale;
            let rounded = if scaled >= 0.0 {
                (scaled + 0.5) as i64 as f64
            } else {
                -(((-scaled) + 0.5) as i64 as f64)
            };
            output[i] = rounded * inv_scale;
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    #[test]
    fn ms_to_ns_basic() {
        let input: [f64; 4] = [1000.0, 1500.5, 0.0, 2.0];
        let mut output = [0i64; 4];
        msToNs(input.as_ptr(), output.as_mut_ptr(), 4);
        assert_eq!(output[0], 1_000_000_000);
        assert_eq!(output[1], 1_500_500_000);
        assert_eq!(output[2], 0);
        assert_eq!(output[3], 2_000_000);
    }

    #[test]
    fn ms_to_ns_single() {
        let input = [42.0f64];
        let mut output = [0i64; 1];
        msToNs(input.as_ptr(), output.as_mut_ptr(), 1);
        assert_eq!(output[0], 42_000_000);
    }

    #[test]
    fn ms_to_ns_odd_count() {
        let input: [f64; 3] = [1.0, 2.0, 3.0];
        let mut output = [0i64; 3];
        msToNs(input.as_ptr(), output.as_mut_ptr(), 3);
        assert_eq!(output, [1_000_000, 2_000_000, 3_000_000]);
    }

    #[test]
    fn ms_to_ns_negative() {
        let input = [-100.0f64];
        let mut output = [0i64; 1];
        msToNs(input.as_ptr(), output.as_mut_ptr(), 1);
        assert_eq!(output[0], -100_000_000);
    }

    #[test]
    fn quantize_batch_precision_2() {
        let scale = 100.0; // 2 decimal places
        let input: [f64; 4] = [1.234, 5.678, 0.001, -3.999];
        let mut output = [0.0f64; 4];
        quantizeBatch(input.as_ptr(), output.as_mut_ptr(), 4, scale);
        assert_eq!(output[0], 1.23);
        assert_eq!(output[1], 5.68);
        assert_eq!(output[2], 0.0);
        assert_eq!(output[3], -4.0);
    }

    #[test]
    fn quantize_batch_integers_pass_through() {
        let scale = 1.0; // integer precision
        let input: [f64; 3] = [1.0, 42.0, -7.0];
        let mut output = [0.0f64; 3];
        quantizeBatch(input.as_ptr(), output.as_mut_ptr(), 3, scale);
        assert_eq!(output[0], 1.0);
        assert_eq!(output[1], 42.0);
        assert_eq!(output[2], -7.0);
    }

    #[test]
    fn quantize_batch_zero() {
        let scale = 100.0;
        let input: [f64; 1] = [0.0];
        let mut output = [99.0f64; 1];
        quantizeBatch(input.as_ptr(), output.as_mut_ptr(), 1, scale);
        assert_eq!(output[0], 0.0);
    }
}
