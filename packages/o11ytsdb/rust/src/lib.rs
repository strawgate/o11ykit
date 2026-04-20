// o11ytsdb — Rust WASM compression codecs
//
// Three value codecs, selected per-chunk at encode time:
//
//   1. XOR-Delta (Gorilla)
//      Baseline codec for all float64 series. Leading/trailing zero
//      tracking on XOR'd consecutive values. Timestamps use
//      delta-of-delta with 4-tier prefix coding.
//      Reference: Pelkonen et al., VLDB 2015.
//
//   2. ALP (Adaptive Lossless floating-Point)
//      For series where most values round-trip through a decimal
//      exponent: val × 10^e → integer → Frame-of-Reference bit-packing.
//      Typically 1–3 B/pt on gauges and low-entropy counters.
//      Reference: Afroozeh et al., SIGMOD 2024.
//
//   3. Delta-ALP
//      Extension of ALP for monotonic integer-valued counters.
//      Stores first value + ALP-compressed deltas. Reduces FoR
//      bit-width dramatically (e.g. bw=17 → bw=8 on typical counters),
//      yielding 2–3× compression over plain ALP on counter patterns.
//      Tag byte 0xDA distinguishes from regular ALP (safe: ALP byte 0
//      is count>>8, max 2048 → max 8; 0xDA = 218 never collides).
//
// Codec selection is automatic and transparent to the decoder: ALP
// functions try delta-ALP first on counter-shaped data (reset_count==0,
// increasing, integer-valued), fall back to plain ALP, and pick
// whichever is smaller. The decoder dispatches on the first byte.
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
//
// Fast bit-packed writer with byte-aligned fast paths.
// When `count` fits within the current byte or spans whole bytes,
// we skip the per-bit loop and write directly.

struct BitWriter<'a> {
    buf: &'a mut [u8],
    byte_pos: usize,
    bit_pos: u8, // 0-7, bits consumed in current byte
}

impl<'a> BitWriter<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        // Zero-fill using ptr::write_bytes (compiles to memory.fill on WASM).
        unsafe {
            core::ptr::write_bytes(buf.as_mut_ptr(), 0, buf.len());
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
        // Fast path: byte-aligned writes for 8, 16, 32, 64 bits.
        if self.bit_pos == 0 {
            match count {
                64 => {
                    let bytes = value.to_be_bytes();
                    self.buf[self.byte_pos..self.byte_pos + 8].copy_from_slice(&bytes);
                    self.byte_pos += 8;
                    return;
                }
                16 => {
                    let bytes = (value as u16).to_be_bytes();
                    self.buf[self.byte_pos..self.byte_pos + 2].copy_from_slice(&bytes);
                    self.byte_pos += 2;
                    return;
                }
                8 => {
                    self.buf[self.byte_pos] = value as u8;
                    self.byte_pos += 1;
                    return;
                }
                _ => {}
            }
        }

        // Medium path: if count <= remaining bits in current byte, pack directly.
        let remaining = 8 - self.bit_pos;
        if count <= remaining {
            self.buf[self.byte_pos] |= (value as u8) << (remaining - count);
            self.bit_pos += count;
            if self.bit_pos == 8 {
                self.bit_pos = 0;
                self.byte_pos += 1;
            }
            return;
        }

        // General path: fill current byte, write whole bytes, handle remainder.
        let mut bits_left = count;

        // Fill remainder of current byte.
        if self.bit_pos > 0 {
            let fill = remaining;
            self.buf[self.byte_pos] |= (value >> (bits_left - fill)) as u8;
            bits_left -= fill;
            self.byte_pos += 1;
            self.bit_pos = 0;
        }

        // Write whole bytes.
        while bits_left >= 8 {
            bits_left -= 8;
            self.buf[self.byte_pos] = (value >> bits_left) as u8;
            self.byte_pos += 1;
        }

        // Write remaining bits.
        if bits_left > 0 {
            self.buf[self.byte_pos] = ((value & ((1u64 << bits_left) - 1)) << (8 - bits_left)) as u8;
            self.bit_pos = bits_left;
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
//
// Fast bit-packed reader with byte-aligned fast paths.

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
        // Fast path: load a single u64 and extract bits with 2 shifts.
        // Works for count ≤ 57 (max bit_pos=7 + count=57 = 64 bits in one u64).
        // This covers the hot path: FoR-u64 exception decode at bw=50-55.
        if count <= 57 && self.byte_pos + 8 <= self.buf.len() {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&self.buf[self.byte_pos..self.byte_pos + 8]);
            let raw = u64::from_be_bytes(bytes);
            let value = (raw << self.bit_pos) >> (64 - count);
            let total = self.bit_pos as usize + count as usize;
            self.byte_pos += total / 8;
            self.bit_pos = (total % 8) as u8;
            return value;
        }

        // Medium path: fits within current byte.
        let remaining = 8 - self.bit_pos;
        if count <= remaining {
            let val = ((self.buf[self.byte_pos] >> (remaining - count)) as u64)
                & ((1u64 << count) - 1);
            self.bit_pos += count;
            if self.bit_pos == 8 {
                self.bit_pos = 0;
                self.byte_pos += 1;
            }
            return val;
        }

        // General path: read across byte boundaries (count > 57 or near end of buffer).
        let mut value: u64 = 0;
        let mut bits_left = count;

        if self.bit_pos > 0 {
            let fill = remaining;
            value = (self.buf[self.byte_pos] as u64) & ((1u64 << fill) - 1);
            bits_left -= fill;
            self.byte_pos += 1;
            self.bit_pos = 0;
        }

        while bits_left >= 8 {
            value = (value << 8) | (self.buf[self.byte_pos] as u64);
            self.byte_pos += 1;
            bits_left -= 8;
        }

        if bits_left > 0 {
            value = (value << bits_left)
                | ((self.buf[self.byte_pos] >> (8 - bits_left)) as u64 & ((1u64 << bits_left) - 1));
            self.bit_pos = bits_left;
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
            // zigzag_encode(N) = 2*N, so 7 bits (max 127) fits |dod| ≤ 63,
            // 9 bits (max 511) fits |dod| ≤ 255, 12 bits (max 4095) fits |dod| ≤ 2047.
            if abs_dod <= 63 {
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 7);
            } else if abs_dod <= 255 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 9);
            } else if abs_dod <= 2047 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 12);
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
    encode_values_inner(vals, out) as u32
}

/// Decode values-only encoding back to Float64 array.
/// Returns the number of samples decoded.
#[no_mangle]
pub extern "C" fn decodeValues(
    in_ptr: *const u8,
    in_len: u32,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, max_samples as usize) };
    decode_values_inner(input, val_out) as u32
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
            // zigzag_encode(N) = 2*N, so 7 bits (max 127) fits |dod| ≤ 63,
            // 9 bits (max 511) fits |dod| ≤ 255, 12 bits (max 4095) fits |dod| ≤ 2047.
            if abs_dod <= 63 {
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 7);
            } else if abs_dod <= 255 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 9);
            } else if abs_dod <= 2047 {
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(1);
                w.write_bit(0);
                w.write_bits(zigzag_encode(dod), 12);
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
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let ts_out = unsafe { core::slice::from_raw_parts_mut(ts_ptr, max_samples as usize) };
    decode_timestamps_inner(input, ts_out) as u32
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

// ── Batch encode values with stats ───────────────────────────────────

/// Encode multiple value arrays in a single WASM call.
/// This eliminates N JS↔WASM boundary crossings when freezing a group
/// of co-scraped series.
///
/// Layout in memory:
///   vals_ptr: N arrays of `chunk_size` f64s concatenated
///   num_arrays: how many arrays
///   out_ptr: output buffer for all compressed blobs concatenated
///   offsets_ptr: output u32 array — byte offset of each blob's start
///   sizes_ptr: output u32 array — byte size of each blob
///   stats_ptr: output N × 8 f64s (stats for each array)
///
/// Returns total bytes written to out_ptr.
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
        let vals = unsafe {
            core::slice::from_raw_parts(vals_ptr.add(a * cs), cs)
        };
        let stats = &mut all_stats[a * 8..(a + 1) * 8];

        // Compute stats in one pass.
        let mut min_v = vals[0];
        let mut max_v = vals[0];
        let mut sum = vals[0];
        let mut sum_sq = vals[0] * vals[0];
        let mut reset_count: u32 = 0;

        for i in 1..cs {
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
        stats[3] = cs as f64;
        stats[4] = vals[0];
        stats[5] = vals[cs - 1];
        stats[6] = sum_sq;
        stats[7] = reset_count as f64;

        // Encode values into remaining output buffer.
        offsets[a] = total_out as u32;
        let remaining = &mut out[total_out..];
        let bytes_written = encode_values_inner(vals, remaining);
        sizes[a] = bytes_written as u32;
        total_out += bytes_written;
    }

    total_out as u32
}

/// Internal: encode a single values array. Shared by encodeValues and batch.
fn encode_values_inner(vals: &[f64], out: &mut [u8]) -> usize {
    let n = vals.len();
    if n == 0 {
        return 0;
    }

    let mut w = BitWriter::new(out);

    w.write_bits(n as u64, 16);
    w.write_bits(f64::to_bits(vals[0]), 64);

    if n == 1 {
        return w.bytes_written();
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

    w.bytes_written()
}

// ── ALP (Adaptive Lossless floating-Point) codec ─────────────────────
//
// Three-step pipeline inspired by CWI's ALP (SIGMOD 2024):
//   1. Find best decimal exponent e such that value × 10^e round-trips
//   2. Frame-of-Reference: subtract min integer, compute bit-width
//   3. Bit-pack offsets; XOR-delta encode exceptions
//
// Header (14 bytes):
//   [0-1]   count (u16 BE)
//   [2]     exponent (u8)
//   [3]     bit_width (u8, 0-64)
//   [4-11]  min_int (i64 BE, frame of reference)
//   [12-13] exception_count (u16 BE)
// Payload:
//   bit-packed offsets (⌈count × bit_width / 8⌉ bytes)
//   exception positions (exc_count × u16 BE) — omitted when exc_count == count
//   exception min_u64 (8 bytes BE) — sortable u64 representation of min f64
//   exception bit_width (1 byte, 0-64)
//   FoR bit-packed exception u64 offsets (⌈exc_count × exc_bw / 8⌉ bytes)

const ALP_HEADER_SIZE: usize = 14;
const ALP_MAX_CHUNK: usize = 2048;
const ALP_MAX_EXP: usize = 18;

// Exception encoding mode: 0 = FoR (original), 1 = delta-FoR
// Delta-FoR encodes zigzag deltas between consecutive sortable-u64
// exception values, then FoR bit-packs the deltas. This exploits
// temporal locality in slowly-changing high-precision series.
//
// The mode is signaled in the blob by setting bit 7 of exc_bw:
//   exc_bw & 0x80 == 0  →  original FoR, actual bw = exc_bw
//   exc_bw & 0x80 != 0  →  delta-FoR,    actual bw = exc_bw & 0x7F
// When delta-FoR: the first 8 bytes after the tag are the first
// sortable u64 (instead of min_su64), followed by bit-packed zigzag deltas.
static mut ALP_EXC_MODE: u8 = 0;

/// Convert f64 to a sortable u64 representation.
/// IEEE 754 is monotonic for positive floats; this extends to negatives
/// by flipping bits so that u64 ordering matches f64 ordering.
#[inline(always)]
fn f64_to_sortable_u64(f: f64) -> u64 {
    let bits = f.to_bits();
    if bits & (1u64 << 63) != 0 {
        !bits // negative: flip all bits
    } else {
        bits ^ (1u64 << 63) // positive: flip sign bit
    }
}

/// Convert sortable u64 back to f64. Inverse of f64_to_sortable_u64.
#[inline(always)]
fn sortable_u64_to_f64(u: u64) -> f64 {
    // Branchless: if sign bit set → XOR 0x8000..., else flip all bits.
    // mask = 0x8000... when positive (sign set), 0xFFFF... when negative.
    let sign = u >> 63;              // 0 or 1
    let mask = (sign << 63) | (sign.wrapping_sub(1)); // 0x8000... or 0xFFFF...
    f64::from_bits(u ^ mask)
}

static POW10: [f64; 19] = [
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9,
    1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18,
];

// Direct-index bit extraction: reads `bw` bits starting at bit `i * bw`
// from a packed byte buffer. No sequential state — each call is independent.
// Requires: bw ≤ 57 and buf has ≥ 8 bytes past the start of each value.
#[inline(always)]
fn extract_packed(buf: &[u8], i: usize, bw: u8) -> u64 {
    let bit_offset = i * bw as usize;
    let byte_pos = bit_offset >> 3;
    let bit_pos = (bit_offset & 7) as u8;
    // Safe: caller ensures buf has 8 bytes of read-safe padding.
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&buf[byte_pos..byte_pos + 8]);
    let raw = u64::from_be_bytes(bytes);
    (raw << bit_pos) >> (64 - bw)
}

// Same as extract_packed but safe near end-of-buffer: pads with zeros.
#[inline(always)]
fn extract_packed_safe(buf: &[u8], i: usize, bw: u8) -> u64 {
    let bit_offset = i * bw as usize;
    let byte_pos = bit_offset >> 3;
    let bit_pos = (bit_offset & 7) as u8;
    let mut bytes = [0u8; 8];
    let avail = buf.len().saturating_sub(byte_pos).min(8);
    bytes[..avail].copy_from_slice(&buf[byte_pos..byte_pos + avail]);
    let raw = u64::from_be_bytes(bytes);
    (raw << bit_pos) >> (64 - bw)
}

// Temp storage for ALP (static to avoid stack/heap allocation).
static mut ALP_INTS: [i64; ALP_MAX_CHUNK] = [0; ALP_MAX_CHUNK];
static mut ALP_EXC: [u8; ALP_MAX_CHUNK] = [0; ALP_MAX_CHUNK]; // 1 = exception
static mut ALP_EXC_U64: [u64; ALP_MAX_CHUNK] = [0; ALP_MAX_CHUNK]; // sortable u64s for delta-FoR

/// Check if a value round-trips through ALP encoding at exponent e.
#[inline(always)]
fn alp_try(val: f64, e: usize) -> Option<i64> {
    if val.is_nan() || val.is_infinite() {
        return None;
    }
    let scaled = val * POW10[e];
    if scaled.abs() > 9.2e18 {
        return None; // overflow
    }
    // Manual round-half-away-from-zero without std::f64::round.
    // floor(x + 0.5) for positive, -floor(-x + 0.5) for negative.
    let int_val = if scaled >= 0.0 {
        (scaled + 0.5) as i64
    } else {
        -(((-scaled) + 0.5) as i64)
    };
    let reconstructed = int_val as f64 / POW10[e];
    if reconstructed == val {
        Some(int_val)
    } else {
        None
    }
}

/// Sample values to find the best decimal exponent, using a cost model
/// that estimates total encoded size rather than just counting matches.
///
/// For each candidate exponent e, we estimate:
///   match_cost  = ceil(n * bw / 8)  (bit-packed FoR offsets)
///   pos_cost    = exc_count * 2     (u16 BE positions, 0 if all exceptions)
///   exc_val_cost = 9 + ceil(exc_count * est_exc_bw / 8)  (FoR-u64 overhead + packed)
///   total       = 14 + match_cost + pos_cost + exc_val_cost
///
/// We estimate exc_bw ≈ 22 bits (typical for metrics in a narrow range
/// like utilization ratios). This is conservative; actual may be lower.
fn alp_find_exponent(vals: &[f64]) -> u8 {
    let n = vals.len();
    let sample = if n <= 32 { n } else { 32 };
    let step = if n <= 32 { 1 } else { n / 32 };

    let mut best_e: u8 = 0;
    let mut best_cost: usize = usize::MAX;

    for e in 0..=ALP_MAX_EXP {
        let mut match_count: usize = 0;
        let mut min_int: i64 = i64::MAX;
        let mut max_int: i64 = i64::MIN;
        // Also track sortable-u64 range of exceptions for tighter estimate.
        let mut min_su64: u64 = u64::MAX;
        let mut max_su64: u64 = 0;

        for s in 0..sample {
            let v = vals[s * step];
            if let Some(iv) = alp_try(v, e) {
                match_count += 1;
                if iv < min_int { min_int = iv; }
                if iv > max_int { max_int = iv; }
            } else {
                let su = f64_to_sortable_u64(v);
                if su < min_su64 { min_su64 = su; }
                if su > max_su64 { max_su64 = su; }
            }
        }

        let exc_count = sample - match_count;

        // Estimate integer bit-width from sampled range.
        let bw = if match_count >= 2 {
            bits_needed((max_int - min_int) as u64) as usize
        } else {
            0
        };

        // Estimate exception bit-width from sampled u64 range.
        let exc_bw = if exc_count >= 2 {
            bits_needed(max_su64 - min_su64) as usize
        } else if exc_count == 1 {
            0 // single exception: bw=0
        } else {
            0
        };

        // Scale to full chunk.
        let exc_full = exc_count * n / sample;
        let match_bytes = (n * bw + 7) / 8;
        let pos_bytes = if exc_full == n { 0 } else { exc_full * 2 };
        let exc_val_bytes = if exc_full > 0 { 9 + (exc_full * exc_bw + 7) / 8 } else { 0 };
        let cost = ALP_HEADER_SIZE + match_bytes + pos_bytes + exc_val_bytes;

        if cost < best_cost {
            best_cost = cost;
            best_e = e as u8;
        }
    }
    best_e
}

#[inline(always)]
fn bits_needed(val: u64) -> u8 {
    if val == 0 { return 0; }
    64 - val.leading_zeros() as u8
}

/// Core ALP encoding. Returns bytes written.
fn alp_encode_inner(vals: &[f64], out: &mut [u8]) -> usize {
    let n = vals.len();
    if n == 0 || n > ALP_MAX_CHUNK {
        return 0;
    }

    let ints = unsafe { &mut ALP_INTS[..n] };
    let exc = unsafe { &mut ALP_EXC[..n] };

    // Step 1: Find best exponent.
    let e = alp_find_exponent(vals);

    // Step 2: Convert to integers, mark exceptions.
    let mut min_int: i64 = i64::MAX;
    let mut max_int: i64 = i64::MIN;
    let mut exc_count: usize = 0;

    for i in 0..n {
        match alp_try(vals[i], e as usize) {
            Some(iv) => {
                ints[i] = iv;
                exc[i] = 0;
                if iv < min_int { min_int = iv; }
                if iv > max_int { max_int = iv; }
            }
            None => {
                ints[i] = 0;
                exc[i] = 1;
                exc_count += 1;
            }
        }
    }

    // All exceptions — set min/max to 0.
    if exc_count == n {
        min_int = 0;
        max_int = 0;
    }

    // Step 3: Compute bit-width for Frame-of-Reference offsets.
    let range = if max_int >= min_int { (max_int - min_int) as u64 } else { 0 };
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
            if exc[i] == 0 {
                w.write_bits((ints[i] - min_int) as u64, bw);
            } else {
                w.write_bits(0, bw); // placeholder for exceptions
            }
        }
        pos += w.bytes_written();
    }

    // Step 6: Write exception positions (exc_count × u16 BE).
    // When exc_count == n, every index is an exception — skip positions.
    if exc_count > 0 && exc_count < n {
        for i in 0..n {
            if exc[i] != 0 {
                out[pos] = (i >> 8) as u8;
                out[pos + 1] = i as u8;
                pos += 2;
            }
        }
    }

    // Step 7: Encode exception values as sortable u64s.
    // Mode 0 (FoR): min/max range → FoR bit-pack (original).
    // Mode 1 (delta-FoR): zigzag deltas between consecutive u64s → FoR bit-pack.
    //   Signaled by setting bit 7 of exc_bw byte.
    if exc_count > 0 {
        let exc_u64 = unsafe { &mut ALP_EXC_U64[..exc_count] };
        let mut ei = 0;
        for i in 0..n {
            if exc[i] != 0 {
                exc_u64[ei] = f64_to_sortable_u64(vals[i]);
                ei += 1;
            }
        }

        let use_delta = unsafe { ALP_EXC_MODE } == 1;

        if use_delta && exc_count > 1 {
            // Delta-FoR: zigzag-encode consecutive deltas, then FoR pack.
            // First value stored raw (8 bytes), then zigzag deltas.
            let first_su64 = exc_u64[0];
            out[pos..pos + 8].copy_from_slice(&first_su64.to_be_bytes());
            pos += 8;

            // Compute zigzag deltas and find max for FoR bit-width.
            let mut max_zz: u64 = 0;
            let deltas = unsafe { &mut ALP_INTS[..exc_count - 1] };
            for i in 0..exc_count - 1 {
                let cur = exc_u64[i + 1] as i128;
                let prev = exc_u64[i] as i128;
                let diff = cur - prev;
                // Zigzag: (diff << 1) ^ (diff >> 63) for i64
                let d64 = diff as i64;
                let zz = ((d64 << 1) ^ (d64 >> 63)) as u64;
                deltas[i] = zz as i64; // reuse ALP_INTS as temp
                if zz > max_zz { max_zz = zz; }
            }

            let delta_bw = bits_needed(max_zz);
            // Set bit 7 to signal delta-FoR mode.
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
            // Original FoR encoding.
            let mut min_su64: u64 = u64::MAX;
            let mut max_su64: u64 = 0;
            for i in 0..exc_count {
                if exc_u64[i] < min_su64 { min_su64 = exc_u64[i]; }
                if exc_u64[i] > max_su64 { max_su64 = exc_u64[i]; }
            }

            let exc_range = max_su64 - min_su64;
            let exc_bw = bits_needed(exc_range);

            out[pos..pos + 8].copy_from_slice(&min_su64.to_be_bytes());
            pos += 8;
            out[pos] = exc_bw; // bit 7 clear = original FoR
            pos += 1;

            if exc_bw > 0 {
                let mut w = BitWriter::new(&mut out[pos..]);
                for i in 0..exc_count {
                    w.write_bits(exc_u64[i] - min_su64, exc_bw);
                }
                pos += w.bytes_written();
            }
        }
    }

    pos
}

// ── Delta-ALP codec ──────────────────────────────────────────────────
//
// For monotonically non-decreasing integer-valued series (counters),
// delta-encoding before ALP dramatically reduces Frame-of-Reference
// bit-width: e.g. monotonicCounter(640) drops from bw=17 to bw=8.
//
// Detection (checked by caller via stats):
//   reset_count == 0 && first_v < last_v && all values are integer f64
//
// Format:
//   [0xDA]                   — tag byte (distinguishes from regular ALP)
//   [base_f64 (8B BE)]       — first value stored as raw f64
//   [ALP block (variable)]   — ALP-encoded deltas (n-1 values)
//
// Tag 0xDA is safe because regular ALP header byte 0 = (count >> 8),
// and count ≤ 2048 ⟹ byte 0 ≤ 8. 0xDA (218) never occurs.

const DELTA_ALP_TAG: u8 = 0xDA;

/// Scratch space for computing deltas before ALP encoding.
/// Reuses ALP_INTS capacity — but we need f64 deltas.
/// We store them in a separate static to avoid aliasing ALP_INTS
/// which alp_encode_inner needs.
static mut DELTA_VALS: [f64; ALP_MAX_CHUNK] = [0.0; ALP_MAX_CHUNK];

/// Detect if a value array is a monotonic integer counter suitable for
/// delta-ALP encoding. Uses pre-computed stats to avoid extra passes.
///
/// Returns true if:
///   - reset_count == 0 (no value decreases)
///   - first_v < last_v (actually increasing, not constant)
///   - all values are integer-valued f64 (exact reconstruction guarantee)
#[inline]
fn is_delta_alp_candidate(vals: &[f64], reset_count: u32) -> bool {
    let n = vals.len();
    if n < 2 || reset_count != 0 {
        return false;
    }
    if vals[0] >= vals[n - 1] {
        return false; // constant or decreasing
    }
    // Check all values are integer-valued (exact for |val| < 2^53).
    for i in 0..n {
        let v = vals[i];
        if v != (v as i64) as f64 || v.is_nan() || v.is_infinite() {
            return false;
        }
    }
    true
}

/// Encode values using delta-before-ALP.
/// Stores base value + ALP-compressed deltas.
/// Returns bytes written to out, or 0 on failure.
fn delta_alp_encode_inner(vals: &[f64], out: &mut [u8]) -> usize {
    let n = vals.len();
    if n < 2 || n > ALP_MAX_CHUNK {
        return 0;
    }

    let mut pos: usize = 0;

    // Tag byte.
    out[pos] = DELTA_ALP_TAG;
    pos += 1;

    // Base value (first element) as raw f64 bits.
    let base_bytes = f64::to_bits(vals[0]).to_be_bytes();
    out[pos..pos + 8].copy_from_slice(&base_bytes);
    pos += 8;

    // Compute deltas into scratch buffer.
    let deltas = unsafe { &mut DELTA_VALS[..n - 1] };
    for i in 0..n - 1 {
        deltas[i] = vals[i + 1] - vals[i];
    }

    // ALP-encode the n-1 deltas.
    let bytes_written = alp_encode_inner(deltas, &mut out[pos..]);
    if bytes_written == 0 {
        return 0; // ALP failed on deltas — shouldn't happen for integer deltas
    }
    pos += bytes_written;

    pos
}

/// Decode delta-ALP values. Input must start with DELTA_ALP_TAG (0xDA).
/// Returns number of samples decoded (n = 1 + delta_count).
fn delta_alp_decode_inner(input: &[u8], val_out: &mut [f64]) -> usize {
    // Minimum: 1 (tag) + 8 (base) + 14 (ALP header) = 23 bytes
    if input.len() < 23 || input[0] != DELTA_ALP_TAG {
        return 0;
    }

    // Read base value.
    let mut base_bytes = [0u8; 8];
    base_bytes.copy_from_slice(&input[1..9]);
    let base = f64::from_bits(u64::from_be_bytes(base_bytes));
    val_out[0] = base;

    // Decode deltas from the ALP block.
    let deltas = unsafe { &mut DELTA_VALS[..ALP_MAX_CHUNK] };
    let delta_count = decode_values_alp_inner(&input[9..], deltas);
    if delta_count == 0 {
        return 1; // only base value
    }

    // Reconstruct via prefix sum. For integer-valued data this is exact.
    let mut acc = base;
    for i in 0..delta_count {
        acc += deltas[i];
        val_out[i + 1] = acc;
    }

    delta_count + 1
}

/// Decode only values[lo..hi] from a delta-ALP blob.
/// Must compute prefix sum up to `lo`, then emit values up to `hi`.
fn delta_alp_decode_range(input: &[u8], lo: usize, hi: usize, out: &mut [f64]) {
    if input.len() < 23 || input[0] != DELTA_ALP_TAG { return; }

    let mut base_bytes = [0u8; 8];
    base_bytes.copy_from_slice(&input[1..9]);
    let base = f64::from_bits(u64::from_be_bytes(base_bytes));

    // Full-decode deltas (can't random-access prefix sums).
    let deltas = unsafe { &mut DELTA_VALS[..ALP_MAX_CHUNK] };
    let delta_count = decode_values_alp_inner(&input[9..], deltas);
    let total_n = delta_count + 1;
    if lo >= total_n { return; }

    // Reconstruct all values up to `hi` via prefix sum.
    let mut acc = base;
    let effective_hi = if hi < total_n { hi } else { total_n };

    // Skip values before `lo` (still must compute prefix sum).
    for i in 0..lo {
        if i < delta_count {
            acc += deltas[i];
        }
    }

    // Emit values in [lo..hi).
    if lo == 0 {
        out[0] = base;
        for i in 1..(effective_hi - lo) {
            acc += deltas[lo + i - 1];
            out[i] = acc;
        }
    } else {
        // acc is already vals[lo]
        out[0] = acc;
        for i in 1..(effective_hi - lo) {
            acc += deltas[lo + i - 1];
            out[i] = acc;
        }
    }
}

/// Encode values using ALP. Returns bytes written.
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
    alp_encode_inner(vals, out) as u32
}

/// Decode ALP-encoded values. Returns number of samples decoded.
#[no_mangle]
pub extern "C" fn decodeValuesALP(
    in_ptr: *const u8,
    in_len: u32,
    val_ptr: *mut f64,
    max_samples: u32,
) -> u32 {
    let input = unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) };
    let val_out = unsafe { core::slice::from_raw_parts_mut(val_ptr, max_samples as usize) };
    decode_values_alp_inner(input, val_out) as u32
}

/// Encode values using ALP AND compute block stats in one pass.
/// Stats layout: [minV, maxV, sum, count, firstV, lastV, sumOfSquares, resetCount]
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

    // Compute stats.
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

    // Encode — use delta-ALP for monotonic integer counters.
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };
    if is_delta_alp_candidate(vals, reset_count) {
        let delta_size = delta_alp_encode_inner(vals, out);
        if delta_size > 0 {
            // Also try plain ALP and pick the smaller one.
            // Use a temp region at the end of `out` for the plain attempt.
            let plain_start = delta_size;
            if plain_start + n * 20 <= out.len() {
                let plain_size = alp_encode_inner(vals, &mut out[plain_start..]);
                if plain_size > 0 && plain_size < delta_size {
                    // Plain ALP wins — copy it to the start.
                    out.copy_within(plain_start..plain_start + plain_size, 0);
                    return plain_size as u32;
                }
            }
            return delta_size as u32;
        }
    }
    alp_encode_inner(vals, out) as u32
}

/// Batch ALP encode: encode N value arrays in one WASM call.
/// Same interface as encodeBatchValuesWithStats but uses ALP encoding.
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
        let vals = unsafe {
            core::slice::from_raw_parts(vals_ptr.add(a * cs), cs)
        };
        let stats = &mut all_stats[a * 8..(a + 1) * 8];

        let mut min_v = vals[0];
        let mut max_v = vals[0];
        let mut sum = vals[0];
        let mut sum_sq = vals[0] * vals[0];
        let mut reset_count: u32 = 0;

        for i in 1..cs {
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
        stats[3] = cs as f64;
        stats[4] = vals[0];
        stats[5] = vals[cs - 1];
        stats[6] = sum_sq;
        stats[7] = reset_count as f64;

        offsets[a] = total_out as u32;
        let remaining = &mut out[total_out..];

        // Try delta-ALP for monotonic integer counters.
        let bytes_written = if is_delta_alp_candidate(vals, reset_count) {
            let delta_size = delta_alp_encode_inner(vals, remaining);
            if delta_size > 0 {
                // Also try plain ALP and pick smaller.
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

// ── Batch decode ─────────────────────────────────────────────────────

/// Batch decode N XOR-compressed value arrays in one WASM call.
///
/// Input layout:
///   blobs_ptr:   concatenated compressed blobs
///   offsets_ptr:  N × u32 — byte offset of each blob within blobs_ptr
///   sizes_ptr:    N × u32 — byte size of each blob
///   num_blobs:    number of blobs
///   out_ptr:      output buffer for decoded f64 arrays
///   chunk_size:   decoded length per blob (all must be same chunk size)
///
/// Returns number of blobs successfully decoded.
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
        let val_out = unsafe {
            core::slice::from_raw_parts_mut(out_ptr.add(a * cs), cs)
        };
        decode_values_inner(blob, val_out);
    }

    nb as u32
}

/// Batch decode N ALP-compressed value arrays in one WASM call.
/// Same interface as decodeBatchValues.
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
        let val_out = unsafe {
            core::slice::from_raw_parts_mut(out_ptr.add(a * cs), cs)
        };
        decode_values_alp_inner(blob, val_out);
    }

    nb as u32
}

/// Internal: decode XOR values from a compressed blob.
fn decode_values_inner(input: &[u8], val_out: &mut [f64]) -> usize {
    let mut r = BitReader::new(input);
    let n = r.read_bits(16) as usize;
    if n == 0 { return 0; }

    val_out[0] = f64::from_bits(r.read_bits(64));
    if n == 1 { return 1; }

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
    n
}

/// Internal: decode ALP values from a compressed blob.
/// Handles both regular ALP and delta-ALP (tag 0xDA) transparently.
fn decode_values_alp_inner(input: &[u8], val_out: &mut [f64]) -> usize {
    if input.is_empty() { return 0; }

    // Dispatch delta-ALP if tagged.
    if input[0] == DELTA_ALP_TAG {
        return delta_alp_decode_inner(input, val_out);
    }

    if input.len() < ALP_HEADER_SIZE { return 0; }

    let mut pos: usize = 0;
    let n = ((input[0] as usize) << 8) | (input[1] as usize);
    pos += 2;
    if n == 0 { return 0; }
    let e = input[pos] as usize;
    pos += 1;
    let bw = input[pos];
    pos += 1;
    let mut min_bytes = [0u8; 8];
    min_bytes.copy_from_slice(&input[pos..pos + 8]);
    let min_int = i64::from_be_bytes(min_bytes);
    pos += 8;
    let exc_count = ((input[pos] as usize) << 8) | (input[pos + 1] as usize);
    pos += 2;

    let factor = POW10[e];

    if bw > 0 && bw <= 57 {
        let packed = &input[pos..];
        let inv_factor = 1.0 / factor;
        // Use fast path for all but last 8 values (which might read past packed data).
        let safe_limit = if n > 8 { n - 8 } else { 0 };
        for i in 0..safe_limit {
            let offset = extract_packed(packed, i, bw) as i64;
            val_out[i] = (min_int + offset) as f64 * inv_factor;
        }
        for i in safe_limit..n {
            let offset = extract_packed_safe(packed, i, bw) as i64;
            val_out[i] = (min_int + offset) as f64 * inv_factor;
        }
        pos += (n * bw as usize + 7) / 8;
    } else if bw > 57 {
        let mut r = BitReader::new(&input[pos..]);
        let inv_factor = 1.0 / factor;
        for i in 0..n {
            let offset = r.read_bits(bw) as i64;
            val_out[i] = (min_int + offset) as f64 * inv_factor;
        }
        pos += (n * bw as usize + 7) / 8;
    } else {
        let base = min_int as f64 / factor;
        for i in 0..n {
            val_out[i] = base;
        }
    }

    // Read exception positions and decode exception values.
    // Handles both FoR (bit 7 clear) and delta-FoR (bit 7 set) modes.
    if exc_count > 0 {
        // Read positions (omitted when exc_count == n).
        let mut exc_positions = [0u16; ALP_MAX_CHUNK];
        if exc_count < n {
            for i in 0..exc_count {
                exc_positions[i] = ((input[pos] as u16) << 8) | (input[pos + 1] as u16);
                pos += 2;
            }
        }

        // Read first 8 bytes (min_su64 for FoR, first_su64 for delta-FoR)
        // + 1 byte tag/bw.
        let mut header_bytes = [0u8; 8];
        header_bytes.copy_from_slice(&input[pos..pos + 8]);
        let header_u64 = u64::from_be_bytes(header_bytes);
        pos += 8;
        let raw_bw = input[pos];
        pos += 1;

        let is_delta = raw_bw & 0x80 != 0;
        let actual_bw = raw_bw & 0x7F;

        if is_delta {
            // Delta-FoR decode: first value + zigzag deltas.
            let first_su64 = header_u64;
            let exc_u64 = unsafe { &mut ALP_EXC_U64[..exc_count] };
            exc_u64[0] = first_su64;

            if actual_bw > 0 {
                let mut r = BitReader::new(&input[pos..]);
                let mut prev = first_su64;
                for i in 1..exc_count {
                    let zz = r.read_bits(actual_bw);
                    // Un-zigzag: (zz >> 1) ^ -(zz & 1)
                    let d = ((zz >> 1) as i64) ^ (-((zz & 1) as i64));
                    let cur = (prev as i128 + d as i128) as u64;
                    exc_u64[i] = cur;
                    prev = cur;
                }
                pos += ((exc_count - 1) * actual_bw as usize + 7) / 8;
            } else {
                for i in 1..exc_count { exc_u64[i] = first_su64; }
            }

            // Write decoded values to output.
            if exc_count == n {
                for i in 0..n {
                    val_out[i] = sortable_u64_to_f64(exc_u64[i]);
                }
            } else {
                for i in 0..exc_count {
                    val_out[exc_positions[i] as usize] = sortable_u64_to_f64(exc_u64[i]);
                }
            }
        } else {
            // Original FoR decode.
            let min_su64 = header_u64;
            let exc_bw = actual_bw;

            if exc_count == n {
                if exc_bw > 0 && exc_bw <= 57 {
                    let packed = &input[pos..];
                    let safe_limit = if n > 8 { n - 8 } else { 0 };
                    for i in 0..safe_limit {
                        val_out[i] = sortable_u64_to_f64(min_su64 + extract_packed(packed, i, exc_bw));
                    }
                    for i in safe_limit..n {
                        val_out[i] = sortable_u64_to_f64(min_su64 + extract_packed_safe(packed, i, exc_bw));
                    }
                } else if exc_bw > 0 {
                    let mut r = BitReader::new(&input[pos..]);
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
                    let packed = &input[pos..];
                    let safe_limit = if exc_count > 8 { exc_count - 8 } else { 0 };
                    for i in 0..safe_limit {
                        val_out[exc_positions[i] as usize] =
                            sortable_u64_to_f64(min_su64 + extract_packed(packed, i, exc_bw));
                    }
                    for i in safe_limit..exc_count {
                        val_out[exc_positions[i] as usize] =
                            sortable_u64_to_f64(min_su64 + extract_packed_safe(packed, i, exc_bw));
                    }
                } else if exc_bw > 0 {
                    let mut r = BitReader::new(&input[pos..]);
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
    }
    n
}

// ── Fused range decode (ALP) ─────────────────────────────────────────
//
// Decodes timestamps + ALP values, binary searches for [startT, endT],
// and returns only the matching range. ALP's fixed-width bit-packing
// enables random access — we skip decoding values outside the range.
//
// Output layout at result_ptr:
//   [0..n*8]         timestamps (i64)
//   [n*8..n*16]      values (f64)
// Returns n (number of samples in range), or 0 if no match.

#[no_mangle]
pub extern "C" fn rangeDecodeALP(
    ts_ptr: *const u8,     // compressed timestamps blob
    ts_len: u32,
    val_ptr: *const u8,    // compressed ALP values blob
    val_len: u32,
    start_t: i64,          // inclusive lower bound
    end_t: i64,            // inclusive upper bound
    out_ts_ptr: *mut i64,  // output timestamps
    out_val_ptr: *mut f64, // output values
    max_out: u32,
) -> u32 {
    // Step 1: Decode timestamps into a temp buffer (reuse ALP_INTS).
    let ts_input = unsafe { core::slice::from_raw_parts(ts_ptr, ts_len as usize) };
    let ts_buf = unsafe { &mut ALP_INTS[..ALP_MAX_CHUNK] };
    let ts_count = decode_timestamps_inner(ts_input, ts_buf);
    if ts_count == 0 { return 0; }

    // Step 2: Binary search for [start_t, end_t].
    let lo = lower_bound_i64(ts_buf, ts_count, start_t);
    let hi = upper_bound_i64(ts_buf, ts_count, end_t);
    if lo >= hi { return 0; }

    let range_count = hi - lo;
    if range_count > max_out as usize { return 0; }

    // Step 3: Copy matching timestamps to output.
    let out_ts = unsafe { core::slice::from_raw_parts_mut(out_ts_ptr, range_count) };
    out_ts.copy_from_slice(&ts_buf[lo..hi]);

    // Step 4: Partial ALP decode — only values in [lo..hi].
    let val_input = unsafe { core::slice::from_raw_parts(val_ptr, val_len as usize) };
    let out_vals = unsafe { core::slice::from_raw_parts_mut(out_val_ptr, range_count) };
    decode_values_alp_range(val_input, lo, hi, out_vals);

    range_count as u32
}

/// Decode only values[lo..hi] from an ALP-compressed blob.
/// Handles both regular ALP and delta-ALP transparently.
fn decode_values_alp_range(input: &[u8], lo: usize, hi: usize, out: &mut [f64]) {
    if input.is_empty() { return; }

    // Dispatch delta-ALP if tagged.
    if input[0] == DELTA_ALP_TAG {
        delta_alp_decode_range(input, lo, hi, out);
        return;
    }

    if input.len() < ALP_HEADER_SIZE { return; }

    let mut pos: usize = 0;
    let n = ((input[0] as usize) << 8) | (input[1] as usize);
    pos += 2;
    if n == 0 || lo >= n { return; }
    let e = input[pos] as usize;
    pos += 1;
    let bw = input[pos];
    pos += 1;
    let mut min_bytes = [0u8; 8];
    min_bytes.copy_from_slice(&input[pos..pos + 8]);
    let min_int = i64::from_be_bytes(min_bytes);
    pos += 8;
    let exc_count = ((input[pos] as usize) << 8) | (input[pos + 1] as usize);
    pos += 2;

    let factor = POW10[e];
    let bit_packed_start = pos;

    // Decode only values[lo..hi] from the bit-packed region.
    if bw > 0 {
        // Seek to bit offset lo * bw.
        let start_bit = lo * bw as usize;
        let byte_offset = start_bit / 8;
        let bit_offset = (start_bit % 8) as u8;
        let mut r = BitReader {
            buf: &input[bit_packed_start + byte_offset..],
            byte_pos: 0,
            bit_pos: bit_offset,
        };
        for i in 0..(hi - lo) {
            let offset = r.read_bits(bw) as i64;
            out[i] = (min_int + offset) as f64 / factor;
        }
        pos = bit_packed_start + (n * bw as usize + 7) / 8;
    } else {
        let base = min_int as f64 / factor;
        for i in 0..(hi - lo) {
            out[i] = base;
        }
    }

    // Patch exceptions within [lo..hi].
    // Handles both FoR (bit 7 clear) and delta-FoR (bit 7 set) modes.
    if exc_count > 0 {
        let mut exc_positions = [0u16; ALP_MAX_CHUNK];
        if exc_count < n {
            for i in 0..exc_count {
                exc_positions[i] = ((input[pos] as u16) << 8) | (input[pos + 1] as u16);
                pos += 2;
            }
        }

        let mut header_bytes = [0u8; 8];
        header_bytes.copy_from_slice(&input[pos..pos + 8]);
        let header_u64 = u64::from_be_bytes(header_bytes);
        pos += 8;
        let raw_bw = input[pos];
        pos += 1;

        let is_delta = raw_bw & 0x80 != 0;
        let actual_bw = raw_bw & 0x7F;

        if is_delta {
            // Delta-FoR: must sequentially decode all exceptions, then pick [lo..hi].
            let exc_u64 = unsafe { &mut ALP_EXC_U64[..exc_count] };
            exc_u64[0] = header_u64;

            if actual_bw > 0 {
                let mut r = BitReader::new(&input[pos..]);
                let mut prev = header_u64;
                for i in 1..exc_count {
                    let zz = r.read_bits(actual_bw);
                    let d = ((zz >> 1) as i64) ^ (-((zz & 1) as i64));
                    let cur = (prev as i128 + d as i128) as u64;
                    exc_u64[i] = cur;
                    prev = cur;
                }
            } else {
                for i in 1..exc_count { exc_u64[i] = header_u64; }
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
            // Original FoR decode.
            let min_su64 = header_u64;
            let exc_bw = actual_bw;

            if exc_count == n {
                if exc_bw > 0 {
                    let start_bit = lo * exc_bw as usize;
                    let byte_offset = start_bit / 8;
                    let bit_offset = (start_bit % 8) as u8;
                    let mut r = BitReader {
                        buf: &input[pos + byte_offset..],
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
            } else {
                if exc_bw > 0 {
                    let mut r = BitReader::new(&input[pos..]);
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
    }
}

/// Internal: decode timestamps into a buffer. Returns count.
fn decode_timestamps_inner(input: &[u8], ts_out: &mut [i64]) -> usize {
    let mut r = BitReader::new(input);
    let n = r.read_bits(16) as usize;
    if n == 0 { return 0; }

    ts_out[0] = r.read_bits(64) as i64;
    if n == 1 { return 1; }

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
    n
}

/// Binary search: first index where ts_buf[i] >= target.
#[inline]
fn lower_bound_i64(buf: &[i64], len: usize, target: i64) -> usize {
    let mut lo = 0usize;
    let mut hi = len;
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if buf[mid] < target { lo = mid + 1; } else { hi = mid; }
    }
    lo
}

/// Binary search: first index where ts_buf[i] > target.
#[inline]
fn upper_bound_i64(buf: &[i64], len: usize, target: i64) -> usize {
    let mut lo = 0usize;
    let mut hi = len;
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if buf[mid] <= target { lo = mid + 1; } else { hi = mid; }
    }
    lo
}

// ── Memory management ────────────────────────────────────────────────

const SCRATCH_SIZE: usize = 2 * 1024 * 1024; // 2 MB
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

/// Set ALP exception encoding mode. 0 = FoR (default), 1 = delta-FoR.
#[no_mangle]
pub extern "C" fn setAlpExcMode(mode: u32) {
    unsafe {
        ALP_EXC_MODE = mode as u8;
    }
}

// ── M2: String interner (WASM) ─────────────────────────────────────

const INTERN_MAX_STRINGS: usize = 200_000;
const INTERN_MAX_BYTES: usize = 8 * 1024 * 1024;
const INTERN_TABLE_SIZE: usize = 1 << 19;
const INTERN_EMPTY: u32 = u32::MAX;

static mut INTERN_BYTES: [u8; INTERN_MAX_BYTES] = [0; INTERN_MAX_BYTES];
static mut INTERN_OFFSETS: [u32; INTERN_MAX_STRINGS + 1] = [0; INTERN_MAX_STRINGS + 1];
static mut INTERN_TABLE: [u32; INTERN_TABLE_SIZE] = [INTERN_EMPTY; INTERN_TABLE_SIZE];
static mut INTERN_HASHES: [u32; INTERN_TABLE_SIZE] = [0; INTERN_TABLE_SIZE];
static mut INTERN_COUNT: u32 = 0;
static mut INTERN_BYTES_USED: u32 = 0;

#[inline(always)]
fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for &b in bytes {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

#[inline(always)]
unsafe fn intern_equals(id: u32, bytes: &[u8]) -> bool {
    let start = INTERN_OFFSETS[id as usize] as usize;
    let end = INTERN_OFFSETS[id as usize + 1] as usize;
    if end - start != bytes.len() {
        return false;
    }
    for i in 0..bytes.len() {
        if INTERN_BYTES[start + i] != bytes[i] {
            return false;
        }
    }
    true
}

#[no_mangle]
pub extern "C" fn internerReset() {
    unsafe {
        INTERN_COUNT = 0;
        INTERN_BYTES_USED = 0;
        INTERN_OFFSETS[0] = 0;
        for i in 0..INTERN_TABLE_SIZE {
            INTERN_TABLE[i] = INTERN_EMPTY;
            INTERN_HASHES[i] = 0;
        }
    }
}

#[no_mangle]
pub extern "C" fn internerIntern(ptr: *const u8, len: u32) -> u32 {
    if ptr.is_null() {
        return u32::MAX;
    }
    let input = unsafe { core::slice::from_raw_parts(ptr, len as usize) };
    let hash = fnv1a32(input);
    let mask = (INTERN_TABLE_SIZE - 1) as u32;
    let mut slot = hash & mask;

    unsafe {
        loop {
            let existing = INTERN_TABLE[slot as usize];
            if existing == INTERN_EMPTY {
                let id = INTERN_COUNT;
                if id as usize >= INTERN_MAX_STRINGS {
                    return u32::MAX;
                }
                let start = INTERN_BYTES_USED as usize;
                let end = start + input.len();
                if end > INTERN_MAX_BYTES {
                    return u32::MAX;
                }
                INTERN_BYTES[start..end].copy_from_slice(input);
                INTERN_OFFSETS[id as usize] = INTERN_BYTES_USED;
                INTERN_BYTES_USED = end as u32;
                INTERN_OFFSETS[id as usize + 1] = INTERN_BYTES_USED;
                INTERN_TABLE[slot as usize] = id;
                INTERN_HASHES[slot as usize] = hash;
                INTERN_COUNT += 1;
                return id;
            }
            if INTERN_HASHES[slot as usize] == hash && intern_equals(existing, input) {
                return existing;
            }
            slot = (slot + 1) & mask;
        }
    }
}

#[no_mangle]
pub extern "C" fn internerResolve(id: u32, out_ptr: *mut u8, out_cap: u32) -> u32 {
    if out_ptr.is_null() {
        return 0;
    }
    unsafe {
        if id >= INTERN_COUNT {
            return 0;
        }
        let start = INTERN_OFFSETS[id as usize] as usize;
        let end = INTERN_OFFSETS[id as usize + 1] as usize;
        let len = end - start;
        if len > out_cap as usize {
            return 0;
        }
        let out = core::slice::from_raw_parts_mut(out_ptr, len);
        out.copy_from_slice(&INTERN_BYTES[start..end]);
        len as u32
    }
}

// ── SIMD accelerators ────────────────────────────────────────────────

/// Convert an array of f64 millisecond timestamps to i64 nanosecond timestamps.
/// Uses SIMD i64x2_mul to process 2 timestamps per iteration.
/// Input: f64 array (ms values as Number). Output: i64 array (ns values).
#[no_mangle]
pub extern "C" fn msToNs(in_ptr: *const f64, out_ptr: *mut i64, count: u32) {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        let n = count as usize;
        let input = unsafe { core::slice::from_raw_parts(in_ptr, n) };
        let output = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };

        // Multiply f64 by 1_000_000.0 first, then truncate to i64.
        // This preserves fractional millisecond precision.
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
/// Uses SIMD f64x2_nearest for ~17× speedup over JS Math.round.
///
/// Note: f64x2_nearest uses IEEE 754 round-half-to-even (banker's rounding),
/// while JS Math.round uses round-half-away-from-zero. The difference only
/// manifests when (value * scale) lands exactly on .5, which is acceptable
/// for metric quantization.
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

        // Remainder
        let input = unsafe { core::slice::from_raw_parts(in_ptr, n) };
        let output = unsafe { core::slice::from_raw_parts_mut(out_ptr, n) };
        for i in (quads * 4)..n {
            let scaled = input[i] * scale;
            output[i] = f64x2_extract_lane::<0>(f64x2_nearest(f64x2_splat(scaled))) * inv_scale;
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
    fn zigzag_roundtrip_boundary_values() {
        let cases: &[i64] = &[
            0, 1, -1,
            62, -62, 63, -63,       // max for 7-bit bucket
            64, -64,                 // first value in 9-bit bucket
            254, -254, 255, -255,    // max for 9-bit bucket
            256, -256,               // first value in 12-bit bucket
            2046, -2046, 2047, -2047, // max for 12-bit bucket
            2048, -2048,             // first value in 64-bit bucket
            i64::MAX, i64::MIN + 1,
        ];

        for &v in cases {
            let encoded = zigzag_encode(v);
            let decoded = zigzag_decode(encoded);
            assert_eq!(decoded, v, "zigzag roundtrip failed for {v}");
        }
    }

    #[test]
    fn zigzag_boundary_bit_widths() {
        // Verify that values within each bucket's range produce zigzag
        // values that fit the bucket's bit width.

        // 7-bit bucket: |dod| ≤ 63 → zigzag ≤ 127
        for v in -63i64..=63 {
            assert!(zigzag_encode(v) <= 127, "zigzag({v}) should fit in 7 bits");
        }
        // |dod| = 64 positive overflows 7 bits (zigzag(64) = 128).
        assert!(zigzag_encode(64) > 127, "64 must overflow 7 bits");

        // 9-bit bucket: |dod| ≤ 255 → zigzag ≤ 511
        for v in -255i64..=255 {
            assert!(zigzag_encode(v) <= 511, "zigzag({v}) should fit in 9 bits");
        }
        assert!(zigzag_encode(256) > 511, "256 must overflow 9 bits");

        // 12-bit bucket: |dod| ≤ 2047 → zigzag ≤ 4095
        for v in -2047i64..=2047 {
            assert!(zigzag_encode(v) <= 4095, "zigzag({v}) should fit in 12 bits");
        }
        assert!(zigzag_encode(2048) > 4095, "2048 must overflow 12 bits");
    }

    #[test]
    fn timestamp_roundtrip_boundary_dods() {
        // Build timestamp sequences that produce specific delta-of-deltas
        // at bucket boundaries, then verify encode→decode roundtrip.
        let dods: &[i64] = &[
            0, 1, -1,
            63, -63, 64, -64,
            255, -255, 256, -256,
            2047, -2047, 2048, -2048,
            10000, -10000,
        ];

        for &target_dod in dods {
            // ts[0]=1000, delta[1]=100, dod[2]=target_dod → delta[2]=100+target_dod
            let ts: [i64; 3] = [1000, 1100, 1200 + target_dod];
            let mut buf = [0u8; 256];
            let mut decoded = [0i64; 3];

            let bytes = encodeTimestamps(ts.as_ptr(), 3, buf.as_mut_ptr(), 256);
            assert!(bytes > 0, "encode failed for dod={target_dod}");

            let count = decode_timestamps_inner(&buf[..bytes as usize], &mut decoded);
            assert_eq!(count, 3, "count mismatch for dod={target_dod}");
            assert_eq!(
                decoded, ts,
                "timestamp roundtrip failed for dod={target_dod}: expected {ts:?}, got {decoded:?}"
            );
        }
    }

    #[test]
    fn chunk_roundtrip_boundary_dods() {
        // Combined ts+values encoder with boundary dods.
        let dods: &[i64] = &[
            63, -63, 64, -64,
            255, -255, 256, -256,
            2047, -2047, 2048, -2048,
        ];

        for &target_dod in dods {
            let ts: [i64; 3] = [1000, 1100, 1200 + target_dod];
            let vals: [f64; 3] = [1.0, 2.0, 3.0];
            let mut buf = [0u8; 512];
            let mut dec_ts = [0i64; 3];
            let mut dec_vals = [0f64; 3];

            let bytes = encodeChunk(
                ts.as_ptr(), vals.as_ptr(), 3, buf.as_mut_ptr(), 512,
            );
            assert!(bytes > 0);

            let count = decodeChunk(
                buf.as_ptr(), bytes, dec_ts.as_mut_ptr(), dec_vals.as_mut_ptr(), 3,
            );
            assert_eq!(count, 3);
            assert_eq!(dec_ts, ts, "chunk ts failed for dod={target_dod}");
            assert_eq!(dec_vals, vals, "chunk vals failed for dod={target_dod}");
        }
    }

    #[test]
    fn nanosecond_timestamp_roundtrip() {
        // Realistic nanosecond OTel timestamps with varying intervals.
        let ts: [i64; 6] = [
            1_700_000_000_000_000_000,  // base (~2023 in ns)
            1_700_000_000_010_000_000,  // +10ms
            1_700_000_000_020_000_064,  // +10ms + 64ns (dod=64)
            1_700_000_000_030_000_320,  // dod=256
            1_700_000_000_040_002_368,  // dod=2048
            1_700_000_000_040_002_368,  // dod=−10_002_368 (large fallback)
        ];
        let mut buf = [0u8; 512];
        let mut decoded = [0i64; 6];

        let bytes = encodeTimestamps(ts.as_ptr(), 6, buf.as_mut_ptr(), 512);
        assert!(bytes > 0);

        let count = decode_timestamps_inner(&buf[..bytes as usize], &mut decoded);
        assert_eq!(count, 6);
        assert_eq!(decoded, ts, "nanosecond roundtrip failed");
    }
}
