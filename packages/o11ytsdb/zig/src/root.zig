// o11ytsdb — Zig WASM kernels
//
// Every exported function operates on WASM linear memory.
// The JS host allocates input/output buffers and passes pointers.
// No allocations happen in hot paths.

const std = @import("std");

// ── M1: XOR-Delta Codec ─────────────────────────────────────────────

/// Encode timestamps + values into a compressed chunk.
/// Returns the number of bytes written to out_ptr.
export fn encodeChunk(
    ts_ptr: [*]const i64,
    val_ptr: [*]const f64,
    count: u32,
    out_ptr: [*]u8,
    out_cap: u32,
) u32 {
    _ = ts_ptr;
    _ = val_ptr;
    _ = count;
    _ = out_ptr;
    _ = out_cap;
    // TODO: implement after M1 benchmark gate is defined
    return 0;
}

/// Decode a compressed chunk into timestamps + values.
/// Returns the number of samples decoded.
export fn decodeChunk(
    in_ptr: [*]const u8,
    in_len: u32,
    ts_ptr: [*]i64,
    val_ptr: [*]f64,
    max_samples: u32,
) u32 {
    _ = in_ptr;
    _ = in_len;
    _ = ts_ptr;
    _ = val_ptr;
    _ = max_samples;
    // TODO: implement after M1 benchmark gate is defined
    return 0;
}

// ── M2: String Interner ──────────────────────────────────────────────

/// Intern a string. Returns its u32 ID.
/// If the string is already interned, returns the existing ID.
export fn intern(ptr: [*]const u8, len: u32) u32 {
    _ = ptr;
    _ = len;
    // TODO: implement after M2 benchmark gate is defined
    return 0;
}

// ── M5: OTLP JSON Scanner ───────────────────────────────────────────

/// Parse OTLP JSON from linear memory, emit samples to column buffers.
/// Returns number of samples parsed.
export fn parseOtlpJson(
    json_ptr: [*]const u8,
    json_len: u32,
    ts_out: [*]i64,
    val_out: [*]f64,
    max_samples: u32,
) u32 {
    _ = json_ptr;
    _ = json_len;
    _ = ts_out;
    _ = val_out;
    _ = max_samples;
    // TODO: implement after M5 benchmark gate is defined
    return 0;
}

// ── Memory management ────────────────────────────────────────────────

/// Bump allocator for JS to request scratch memory from WASM.
var bump_offset: usize = 0;
var scratch: [1024 * 1024]u8 = undefined; // 1 MB scratch

export fn allocScratch(size: u32) u32 {
    const aligned = (size + 7) & ~@as(u32, 7); // 8-byte align
    if (bump_offset + aligned > scratch.len) return 0;
    const ptr = bump_offset;
    bump_offset += aligned;
    return @intCast(ptr);
}

export fn resetScratch() void {
    bump_offset = 0;
}

// ── Tests ────────────────────────────────────────────────────────────

test "scratch allocator" {
    resetScratch();
    const a = allocScratch(64);
    const b = allocScratch(128);
    try std.testing.expect(a == 0);
    try std.testing.expect(b == 64);
    resetScratch();
    const c = allocScratch(64);
    try std.testing.expect(c == 0);
}
