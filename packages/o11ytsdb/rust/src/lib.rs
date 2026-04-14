// o11ytsdb — Rust WASM XOR-delta codec
//
// Same ABI as zig/src/root.zig. The JS host calls these through WASM
// linear memory: pass pointers to timestamp/value arrays, get back
// compressed bytes (or vice versa).
//
// No std, no allocator beyond a static scratch buffer.
// All bit manipulation is native u64 — no BigInt overhead.

#![no_std]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── Bit Writer ───────────────────────────────────────────────────────

struct BitWriter<'a> {
    buf: &'a mut [u8],
    byte_pos: usize,
    bit_pos: u8, // 0-7, bits consumed in current byte
}

impl<'a> BitWriter<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        for b in buf.iter_mut() {
            *b = 0;
        }
        BitWriter {
            buf,
            byte_pos: 0,
            bit_pos: 0,
        }
    }

    #[inline(always)]
    fn write_bit(&mut self, bit: u8) {
        if bit != 0 {
            self.buf[self.byte_pos] |= 0x80 >> self.bit_pos;
        }
        self.bit_pos += 1;
        if self.bit_pos == 8 {
            self.bit_pos = 0;
            self.byte_pos += 1;
        }
    }

    #[inline(always)]
    fn write_bits(&mut self, value: u64, count: u8) {
        for i in (0..count).rev() {
            self.write_bit(((value >> i) & 1) as u8);
        }
    }

    fn bytes_written(&self) -> usize {
        if self.bit_pos > 0 {
            self.byte_pos + 1
        } else {
            self.byte_pos
        }
    }
}

// ── Bit Reader ───────────────────────────────────────────────────────

struct BitReader<'a> {
    buf: &'a [u8],
    byte_pos: usize,
    bit_pos: u8,
}

impl<'a> BitReader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        BitReader {
            buf,
            byte_pos: 0,
            bit_pos: 0,
        }
    }

    #[inline(always)]
    fn read_bit(&mut self) -> u8 {
        let byte = self.buf[self.byte_pos];
        let bit = (byte >> (7 - self.bit_pos)) & 1;
        self.bit_pos += 1;
        if self.bit_pos == 8 {
            self.bit_pos = 0;
            self.byte_pos += 1;
        }
        bit
    }

    #[inline(always)]
    fn read_bits(&mut self, count: u8) -> u64 {
        let mut value: u64 = 0;
        for _ in 0..count {
            value = (value << 1) | (self.read_bit() as u64);
        }
        value
    }
}

// ── Zigzag encoding ──────────────────────────────────────────────────

#[inline(always)]
fn zigzag_encode(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

#[inline(always)]
fn zigzag_decode(v: u64) -> i64 {
    ((v >> 1) as i64) ^ (-((v & 1) as i64))
}

// ── Encode ───────────────────────────────────────────────────────────

/// Encode timestamps + values into a compressed chunk.
/// Returns the number of bytes written to out_ptr.
///
/// Layout matches the TypeScript codec exactly:
///   Header: 16-bit count, 64-bit first timestamp, 64-bit first value
///   Per sample: delta-of-delta timestamps (4-tier prefix) + XOR values
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

    let mut w = BitWriter::new(out);

    // Header: count (16 bits) + first timestamp (64 bits) + first value (64 bits).
    w.write_bits(n as u64, 16);
    w.write_bits(ts[0] as u64, 64);
    w.write_bits(f64::to_bits(vals[0]), 64);

    if n == 1 {
        return w.bytes_written() as u32;
    }

    let mut prev_ts = ts[0];
    let mut prev_delta: i64 = 0;
    let mut prev_val_bits = f64::to_bits(vals[0]);
    let mut prev_leading: u32 = 64;
    let mut prev_trailing: u32 = 0;

    for i in 1..n {
        let cur_ts = ts[i];
        let delta = cur_ts.wrapping_sub(prev_ts);
        let dod = delta.wrapping_sub(prev_delta);

        // ── Timestamp: delta-of-delta ──
        if dod == 0 {
            w.write_bit(0);
        } else {
            let abs_dod = if dod < 0 { dod.wrapping_neg() } else { dod };
            if abs_dod <= 64 {
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod) & 0x7F, 7);
            } else if abs_dod <= 256 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod) & 0x1FF, 9);
            } else if abs_dod <= 2048 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod) & 0xFFF, 12);
            } else {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bits(dod as u64, 64);
            }
        }

        prev_delta = delta;
        prev_ts = cur_ts;

        // ── Value: XOR encoding ──
        let val_bits = f64::to_bits(vals[i]);
        let xor = prev_val_bits ^ val_bits;

        if xor == 0 {
            w.write_bit(0);
        } else {
            let leading = xor.leading_zeros();
            let trailing = xor.trailing_zeros();
            let meaningful = 64 - leading - trailing;

            if leading >= prev_leading && trailing >= prev_trailing {
                // Reuse previous window.
                w.write_bit(1);
                w.write_bit(0);
                let prev_meaningful = 64 - prev_leading - prev_trailing;
                w.write_bits(xor >> prev_trailing, prev_meaningful as u8);
            } else {
                // New window.
                w.write_bit(1);
                w.write_bit(1);
                w.write_bits(leading as u64, 6);
                w.write_bits((meaningful - 1) as u64, 6);
                w.write_bits(xor >> trailing, meaningful as u8);
                prev_leading = leading;
                prev_trailing = trailing;
            }
        }

        prev_val_bits = val_bits;
    }

    w.bytes_written() as u32
}

// ── Decode ───────────────────────────────────────────────────────────

/// Decode a compressed chunk into timestamps + values.
/// Returns the number of samples decoded.
#[no_mangle]
pub extern "C" fn decodeChunk(
    in_ptr: *const u8,
    in_len: u32,
    ts_ptr: *mut i64,
    val_ptr: *mut f64,
    _max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let mut r = BitReader::new(input);

    let n = r.read_bits(16) as usize;
    if n == 0 {
        return 0;
    }

    let ts_out = unsafe { core::slice::from_raw_parts_mut(ts_ptr, n) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, n) };

    ts_out[0] = r.read_bits(64) as i64;
    val_out[0] = f64::from_bits(r.read_bits(64));

    if n == 1 {
        return 1;
    }

    let mut prev_ts = ts_out[0];
    let mut prev_delta: i64 = 0;
    let mut prev_val_bits = f64::to_bits(val_out[0]);
    let mut prev_leading: u32 = 0;
    let mut prev_trailing: u32 = 0;

    for i in 1..n {
        // ── Timestamp: delta-of-delta ──
        let dod: i64;
        if r.read_bit() == 0 {
            dod = 0;
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(7));
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(9));
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(12));
        } else {
            dod = r.read_bits(64) as i64;
        }

        let delta = prev_delta.wrapping_add(dod);
        let cur_ts = prev_ts.wrapping_add(delta);
        ts_out[i] = cur_ts;
        prev_delta = delta;
        prev_ts = cur_ts;

        // ── Value: XOR decoding ──
        if r.read_bit() == 0 {
            val_out[i] = f64::from_bits(prev_val_bits);
        } else if r.read_bit() == 0 {
            let meaningful = 64 - prev_leading - prev_trailing;
            let shifted = r.read_bits(meaningful as u8);
            let xor = shifted << prev_trailing;
            prev_val_bits ^= xor;
            val_out[i] = f64::from_bits(prev_val_bits);
        } else {
            let leading = r.read_bits(6) as u32;
            let meaningful_m1 = r.read_bits(6) as u32;
            let meaningful = meaningful_m1 + 1;
            let trailing = 64 - leading - meaningful;
            let shifted = r.read_bits(meaningful as u8);
            let xor = shifted << trailing;
            prev_val_bits ^= xor;
            val_out[i] = f64::from_bits(prev_val_bits);
            prev_leading = leading;
            prev_trailing = trailing;
        }
    }

    n as u32
}

// ── Encode with block stats ──────────────────────────────────────────

/// Block statistics computed during encoding.
/// Written as 8 contiguous f64 values (64 bytes) at `stats_ptr`:
///   [0] min_value
///   [1] max_value
///   [2] sum
///   [3] count (as f64)
///   [4] first_value
///   [5] last_value
///   [6] sum_of_squares
///   [7] reset_count (as f64) — number of value decreases
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

    // Compute block stats in one pass over the values.
    let mut min_v = vals[0];
    let mut max_v = vals[0];
    let mut sum = vals[0];
    let mut sum_sq = vals[0] * vals[0];
    let mut reset_count: u32 = 0;

    for i in 1..n {
        let v = vals[i];
        if v < min_v { min_v = v; }
        if v > max_v { max_v = v; }
        sum += v;
        sum_sq += v * v;
        if v < vals[i - 1] { reset_count += 1; }
    }

    stats[0] = min_v;
    stats[1] = max_v;
    stats[2] = sum;
    stats[3] = n as f64;
    stats[4] = vals[0];          // first
    stats[5] = vals[n - 1];      // last
    stats[6] = sum_sq;
    stats[7] = reset_count as f64;

    // Delegate actual encoding to existing encodeChunk.
    encodeChunk(ts_ptr, val_ptr, count, out_ptr, out_cap)
}

/// Encode values only (no timestamps) using XOR encoding.
/// For shared-timestamp storage where timestamps are stored once per group.
/// Returns the number of bytes written to out_ptr.
///
/// Layout: 16-bit count + 64-bit first value + XOR-encoded subsequent values.
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

    let mut w = BitWriter::new(out);

    // Header: count (16 bits) + first value (64 bits).
    w.write_bits(n as u64, 16);
    w.write_bits(f64::to_bits(vals[0]), 64);

    if n == 1 {
        return w.bytes_written() as u32;
    }

    let mut prev_val_bits = f64::to_bits(vals[0]);
    let mut prev_leading: u32 = 64;
    let mut prev_trailing: u32 = 0;

    for i in 1..n {
        let val_bits = f64::to_bits(vals[i]);
        let xor = prev_val_bits ^ val_bits;

        if xor == 0 {
            w.write_bit(0);
        } else {
            let leading = xor.leading_zeros();
            let trailing = xor.trailing_zeros();
            let meaningful = 64 - leading - trailing;

            if leading >= prev_leading && trailing >= prev_trailing {
                w.write_bit(1);
                w.write_bit(0);
                let prev_meaningful = 64 - prev_leading - prev_trailing;
                w.write_bits(xor >> prev_trailing, prev_meaningful as u8);
            } else {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bits(leading as u64, 6);
                w.write_bits((meaningful - 1) as u64, 6);
                w.write_bits(xor >> trailing, meaningful as u8);
                prev_leading = leading;
                prev_trailing = trailing;
            }
        }

        prev_val_bits = val_bits;
    }

    w.bytes_written() as u32
}

/// Decode values-only encoding back to Float64 array.
/// Returns the number of samples decoded.
#[no_mangle]
pub extern "C" fn decodeValues(
    in_ptr: *const u8,
    in_len: u32,
    val_ptr: *mut f64,
    _max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let mut r = BitReader::new(input);

    let n = r.read_bits(16) as usize;
    if n == 0 {
        return 0;
    }

    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, n) };

    val_out[0] = f64::from_bits(r.read_bits(64));

    if n == 1 {
        return 1;
    }

    let mut prev_val_bits = f64::to_bits(val_out[0]);
    let mut prev_leading: u32 = 0;
    let mut prev_trailing: u32 = 0;

    for i in 1..n {
        if r.read_bit() == 0 {
            val_out[i] = f64::from_bits(prev_val_bits);
        } else if r.read_bit() == 0 {
            let meaningful = 64 - prev_leading - prev_trailing;
            let shifted = r.read_bits(meaningful as u8);
            let xor = shifted << prev_trailing;
            prev_val_bits ^= xor;
            val_out[i] = f64::from_bits(prev_val_bits);
        } else {
            let leading = r.read_bits(6) as u32;
            let meaningful_m1 = r.read_bits(6) as u32;
            let meaningful = meaningful_m1 + 1;
            let trailing = 64 - leading - meaningful;
            let shifted = r.read_bits(meaningful as u8);
            let xor = shifted << trailing;
            prev_val_bits ^= xor;
            val_out[i] = f64::from_bits(prev_val_bits);
            prev_leading = leading;
            prev_trailing = trailing;
        }
    }

    n as u32
}

// ── Timestamp-only codec ─────────────────────────────────────────────

/// Encode timestamps only using delta-of-delta encoding.
/// For shared-timestamp storage where timestamps are stored once per group.
/// Returns the number of bytes written to out_ptr.
///
/// Layout: 16-bit count + 64-bit first timestamp + delta-of-delta bitstream.
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

    let mut w = BitWriter::new(out);

    // Header: count (16 bits) + first timestamp (64 bits).
    w.write_bits(n as u64, 16);
    w.write_bits(ts[0] as u64, 64);

    if n == 1 {
        return w.bytes_written() as u32;
    }

    let mut prev_ts = ts[0];
    let mut prev_delta: i64 = 0;

    for i in 1..n {
        let cur_ts = ts[i];
        let delta = cur_ts.wrapping_sub(prev_ts);
        let dod = delta.wrapping_sub(prev_delta);

        if dod == 0 {
            w.write_bit(0);
        } else {
            let abs_dod = if dod < 0 { dod.wrapping_neg() } else { dod };
            if abs_dod <= 64 {
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod) & 0x7F, 7);
            } else if abs_dod <= 256 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod) & 0x1FF, 9);
            } else if abs_dod <= 2048 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod) & 0xFFF, 12);
            } else {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bits(dod as u64, 64);
            }
        }

        prev_delta = delta;
        prev_ts = cur_ts;
    }

    w.bytes_written() as u32
}

/// Decode timestamps from delta-of-delta encoding.
/// Returns the number of timestamps decoded.
#[no_mangle]
pub extern "C" fn decodeTimestamps(
    in_ptr: *const u8,
    in_len: u32,
    ts_ptr: *mut i64,
    _max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let mut r = BitReader::new(input);

    let n = r.read_bits(16) as usize;
    if n == 0 {
        return 0;
    }

    let ts_out = unsafe { core::slice::from_raw_parts_mut(ts_ptr, n) };
    ts_out[0] = r.read_bits(64) as i64;

    if n == 1 {
        return 1;
    }

    let mut prev_ts = ts_out[0];
    let mut prev_delta: i64 = 0;

    for i in 1..n {
        let dod: i64;
        if r.read_bit() == 0 {
            dod = 0;
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(7));
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(9));
        } else if r.read_bit() == 0 {
            dod = zigzag_decode(r.read_bits(12));
        } else {
            dod = r.read_bits(64) as i64;
        }

        let delta = prev_delta.wrapping_add(dod);
        let cur_ts = prev_ts.wrapping_add(delta);
        ts_out[i] = cur_ts;
        prev_delta = delta;
        prev_ts = cur_ts;
    }

    n as u32
}

/// Encode values only AND compute block stats in one pass.
/// Returns bytes written to out_ptr. Stats written to stats_ptr (8 × f64).
///
/// Stats layout: [minV, maxV, sum, count, firstV, lastV, sumOfSquares, resetCount]
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

    // Compute block stats.
    let mut min_v = vals[0];
    let mut max_v = vals[0];
    let mut sum = vals[0];
    let mut sum_sq = vals[0] * vals[0];
    let mut reset_count: u32 = 0;

    for i in 1..n {
        let v = vals[i];
        if v < min_v { min_v = v; }
        if v > max_v { max_v = v; }
        sum += v;
        sum_sq += v * v;
        if v < vals[i - 1] { reset_count += 1; }
    }

    stats[0] = min_v;
    stats[1] = max_v;
    stats[2] = sum;
    stats[3] = n as f64;
    stats[4] = vals[0];
    stats[5] = vals[n - 1];
    stats[6] = sum_sq;
    stats[7] = reset_count as f64;

    // Encode values (delegate to encodeValues).
    encodeValues(val_ptr, count, out_ptr, out_cap)
}

// ── Memory management ────────────────────────────────────────────────

const SCRATCH_SIZE: usize = 1024 * 1024; // 1 MB
static mut SCRATCH: [u8; SCRATCH_SIZE] = [0u8; SCRATCH_SIZE];
static mut BUMP_OFFSET: usize = 0;

/// Allocate from scratch buffer. Returns pointer into WASM memory.
#[no_mangle]
pub extern "C" fn allocScratch(size: u32) -> u32 {
    let aligned = ((size as usize) + 7) & !7;
    unsafe {
        if BUMP_OFFSET + aligned > SCRATCH_SIZE {
            return 0;
        }
        let offset = BUMP_OFFSET;
        BUMP_OFFSET += aligned;
        core::ptr::addr_of!(SCRATCH).cast::<u8>().add(offset) as u32
    }
}

/// Reset scratch allocator.
#[no_mangle]
pub extern "C" fn resetScratch() {
    unsafe {
        BUMP_OFFSET = 0;
    }
}
