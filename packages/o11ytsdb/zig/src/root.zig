// o11ytsdb — Zig WASM XOR-delta codec
//
// Same ABI as rust/src/lib.rs. The JS host calls these through WASM
// linear memory. All bit manipulation is native u64.

const std = @import("std");

// ── Bit Writer ───────────────────────────────────────────────────────

const BitWriter = struct {
    buf: [*]u8,
    cap: usize,
    byte_pos: usize,
    bit_pos: u3, // 0-7

    fn init(buf: [*]u8, cap: usize) BitWriter {
        // Zero the output buffer.
        for (0..cap) |i| {
            buf[i] = 0;
        }
        return .{ .buf = buf, .cap = cap, .byte_pos = 0, .bit_pos = 0 };
    }

    inline fn writeBit(self: *BitWriter, bit: u1) void {
        if (bit != 0) {
            self.buf[self.byte_pos] |= @as(u8, 0x80) >> self.bit_pos;
        }
        self.bit_pos +%= 1;
        if (self.bit_pos == 0) {
            self.byte_pos += 1;
        }
    }

    inline fn writeBits(self: *BitWriter, value: u64, count: u7) void {
        var i: u7 = count;
        while (i > 0) {
            i -= 1;
            self.writeBit(@truncate((value >> @as(u6, @intCast(i))) & 1));
        }
    }

    fn bytesWritten(self: *const BitWriter) usize {
        return if (self.bit_pos > 0) self.byte_pos + 1 else self.byte_pos;
    }
};

// ── Bit Reader ───────────────────────────────────────────────────────

const BitReader = struct {
    buf: [*]const u8,
    len: usize,
    byte_pos: usize,
    bit_pos: u3,

    fn init(buf: [*]const u8, len: usize) BitReader {
        return .{ .buf = buf, .len = len, .byte_pos = 0, .bit_pos = 0 };
    }

    inline fn readBit(self: *BitReader) u1 {
        const byte = self.buf[self.byte_pos];
        const bit: u1 = @truncate((byte >> (7 - @as(u3, self.bit_pos))) & 1);
        self.bit_pos +%= 1;
        if (self.bit_pos == 0) {
            self.byte_pos += 1;
        }
        return bit;
    }

    inline fn readBits(self: *BitReader, count: u7) u64 {
        var value: u64 = 0;
        for (0..count) |_| {
            value = (value << 1) | @as(u64, self.readBit());
        }
        return value;
    }
};

// ── Zigzag encoding ──────────────────────────────────────────────────

inline fn zigzagEncode(v: i64) u64 {
    return @bitCast((v << 1) ^ (v >> 63));
}

inline fn zigzagDecode(v: u64) i64 {
    return @as(i64, @bitCast(v >> 1)) ^ -@as(i64, @bitCast(v & 1));
}

// ── Float ↔ bits ─────────────────────────────────────────────────────

inline fn f64ToBits(f: f64) u64 {
    return @bitCast(f);
}

inline fn bitsToF64(b: u64) f64 {
    return @bitCast(b);
}

inline fn clz64(x: u64) u32 {
    return @clz(x);
}

inline fn ctz64(x: u64) u32 {
    return @ctz(x);
}

inline fn absI64(v: i64) i64 {
    return if (v < 0) -v else v;
}

// ── Encode ───────────────────────────────────────────────────────────

export fn encodeChunk(
    ts_ptr: [*]const i64,
    val_ptr: [*]const f64,
    count: u32,
    out_ptr: [*]u8,
    out_cap: u32,
) u32 {
    const n: usize = count;
    if (n == 0) return 0;

    var w = BitWriter.init(out_ptr, out_cap);

    // Header: count (16 bits) + first timestamp (64 bits) + first value (64 bits).
    w.writeBits(n, 16);
    w.writeBits(@bitCast(ts_ptr[0]), 64);
    w.writeBits(f64ToBits(val_ptr[0]), 64);

    if (n == 1) return @intCast(w.bytesWritten());

    var prev_ts: i64 = ts_ptr[0];
    var prev_delta: i64 = 0;
    var prev_val_bits: u64 = f64ToBits(val_ptr[0]);
    var prev_leading: u32 = 64;
    var prev_trailing: u32 = 0;

    for (1..n) |i| {
        const cur_ts: i64 = ts_ptr[i];
        const delta: i64 = cur_ts -% prev_ts;
        const dod: i64 = delta -% prev_delta;

        // ── Timestamp: delta-of-delta ──
        if (dod == 0) {
            w.writeBit(0);
        } else {
            const abs_dod = absI64(dod);
            if (abs_dod <= 64) {
                w.writeBit(1);
                w.writeBit(0);
                w.writeBits(zigzagEncode(dod) & 0x7F, 7);
            } else if (abs_dod <= 256) {
                w.writeBit(1);
                w.writeBit(1);
                w.writeBit(0);
                w.writeBits(zigzagEncode(dod) & 0x1FF, 9);
            } else if (abs_dod <= 2048) {
                w.writeBit(1);
                w.writeBit(1);
                w.writeBit(1);
                w.writeBit(0);
                w.writeBits(zigzagEncode(dod) & 0xFFF, 12);
            } else {
                w.writeBit(1);
                w.writeBit(1);
                w.writeBit(1);
                w.writeBit(1);
                w.writeBits(@bitCast(dod), 64);
            }
        }

        prev_delta = delta;
        prev_ts = cur_ts;

        // ── Value: XOR encoding ──
        const val_bits = f64ToBits(val_ptr[i]);
        const xor = prev_val_bits ^ val_bits;

        if (xor == 0) {
            w.writeBit(0);
        } else {
            const leading = clz64(xor);
            const trailing = ctz64(xor);
            const meaningful = 64 - leading - trailing;

            if (leading >= prev_leading and trailing >= prev_trailing) {
                w.writeBit(1);
                w.writeBit(0);
                const prev_meaningful = 64 - prev_leading - prev_trailing;
                w.writeBits(xor >> @intCast(prev_trailing), @intCast(prev_meaningful));
            } else {
                w.writeBit(1);
                w.writeBit(1);
                w.writeBits(leading, 6);
                w.writeBits(meaningful - 1, 6);
                w.writeBits(xor >> @intCast(trailing), @intCast(meaningful));
                prev_leading = leading;
                prev_trailing = trailing;
            }
        }

        prev_val_bits = val_bits;
    }

    return @intCast(w.bytesWritten());
}

// ── Decode ───────────────────────────────────────────────────────────

export fn decodeChunk(
    in_ptr: [*]const u8,
    in_len: u32,
    ts_ptr: [*]i64,
    val_ptr: [*]f64,
    max_samples: u32,
) u32 {
    _ = max_samples;
    var r = BitReader.init(in_ptr, in_len);

    const n: usize = @intCast(r.readBits(16));
    if (n == 0) return 0;

    ts_ptr[0] = @bitCast(r.readBits(64));
    val_ptr[0] = bitsToF64(r.readBits(64));

    if (n == 1) return 1;

    var prev_ts: i64 = ts_ptr[0];
    var prev_delta: i64 = 0;
    var prev_val_bits: u64 = f64ToBits(val_ptr[0]);
    var prev_leading: u32 = 0;
    var prev_trailing: u32 = 0;

    for (1..n) |i| {
        // ── Timestamp: delta-of-delta ──
        var dod: i64 = undefined;
        if (r.readBit() == 0) {
            dod = 0;
        } else if (r.readBit() == 0) {
            dod = zigzagDecode(r.readBits(7));
        } else if (r.readBit() == 0) {
            dod = zigzagDecode(r.readBits(9));
        } else if (r.readBit() == 0) {
            dod = zigzagDecode(r.readBits(12));
        } else {
            dod = @bitCast(r.readBits(64));
        }

        const delta = prev_delta +% dod;
        const cur_ts = prev_ts +% delta;
        ts_ptr[i] = cur_ts;
        prev_delta = delta;
        prev_ts = cur_ts;

        // ── Value: XOR decoding ──
        if (r.readBit() == 0) {
            val_ptr[i] = bitsToF64(prev_val_bits);
        } else if (r.readBit() == 0) {
            const meaningful = 64 - prev_leading - prev_trailing;
            const shifted = r.readBits(@intCast(meaningful));
            const xor = shifted << @intCast(prev_trailing);
            prev_val_bits ^= xor;
            val_ptr[i] = bitsToF64(prev_val_bits);
        } else {
            const leading = @as(u32, @intCast(r.readBits(6)));
            const meaningful_m1 = @as(u32, @intCast(r.readBits(6)));
            const meaningful = meaningful_m1 + 1;
            const trailing = 64 - leading - meaningful;
            const shifted = r.readBits(@intCast(meaningful));
            const xor = shifted << @intCast(trailing);
            prev_val_bits ^= xor;
            val_ptr[i] = bitsToF64(prev_val_bits);
            prev_leading = leading;
            prev_trailing = trailing;
        }
    }

    return @intCast(n);
}

// ── Memory management ────────────────────────────────────────────────

var bump_offset: usize = 0;
var scratch: [1024 * 1024]u8 = undefined; // 1 MB scratch

export fn allocScratch(size: u32) u32 {
    const aligned = (size + 7) & ~@as(u32, 7);
    if (bump_offset + aligned > scratch.len) return 0;
    const ptr = bump_offset;
    bump_offset += aligned;
    return @intCast(@intFromPtr(&scratch) + ptr);
}

export fn resetScratch() void {
    bump_offset = 0;
}
