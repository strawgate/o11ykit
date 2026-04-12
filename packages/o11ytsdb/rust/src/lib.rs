// o11ytsdb — Rust WASM kernels
//
// Mirror of zig/src/root.zig. Same ABI, same function signatures,
// same linear-memory protocol. The JS host doesn't know which
// language produced the .wasm — that's the point.
//
// No std, no allocator, no panics in hot paths.

#![no_std]

// Panic handler — abort immediately, no formatting overhead.
#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── M1: XOR-Delta Codec ─────────────────────────────────────────────

/// Encode timestamps + values into a compressed chunk.
/// Returns the number of bytes written to out_ptr.
#[no_mangle]
pub extern "C" fn encodeChunk(
    _ts_ptr: *const i64,
    _val_ptr: *const f64,
    _count: u32,
    _out_ptr: *mut u8,
    _out_cap: u32,
) -> u32 {
    // TODO: implement after M1 benchmark gate is defined
    0
}

/// Decode a compressed chunk into timestamps + values.
/// Returns the number of samples decoded.
#[no_mangle]
pub extern "C" fn decodeChunk(
    _in_ptr: *const u8,
    _in_len: u32,
    _ts_ptr: *mut i64,
    _val_ptr: *mut f64,
    _max_samples: u32,
) -> u32 {
    // TODO: implement after M1 benchmark gate is defined
    0
}

// ── M2: String Interner ──────────────────────────────────────────────

/// Intern a string. Returns its u32 ID.
#[no_mangle]
pub extern "C" fn intern(_ptr: *const u8, _len: u32) -> u32 {
    // TODO: implement after M2 benchmark gate is defined
    0
}

// ── M5: OTLP JSON Scanner ───────────────────────────────────────────

/// Parse OTLP JSON from linear memory, emit samples to column buffers.
/// Returns number of samples parsed.
#[no_mangle]
pub extern "C" fn parseOtlpJson(
    _json_ptr: *const u8,
    _json_len: u32,
    _ts_out: *mut i64,
    _val_out: *mut f64,
    _max_samples: u32,
) -> u32 {
    // TODO: implement after M5 benchmark gate is defined
    0
}

// ── Memory management ────────────────────────────────────────────────

const SCRATCH_SIZE: usize = 1024 * 1024; // 1 MB
static mut SCRATCH: [u8; SCRATCH_SIZE] = [0u8; SCRATCH_SIZE];
static mut BUMP_OFFSET: usize = 0;

/// Allocate from scratch buffer. Returns offset, or 0 on OOM.
#[no_mangle]
pub extern "C" fn allocScratch(size: u32) -> u32 {
    let aligned = ((size as usize) + 7) & !7; // 8-byte align
    unsafe {
        if BUMP_OFFSET + aligned > SCRATCH_SIZE {
            return 0;
        }
        let ptr = BUMP_OFFSET;
        BUMP_OFFSET += aligned;
        ptr as u32
    }
}

/// Reset scratch allocator.
#[no_mangle]
pub extern "C" fn resetScratch() {
    unsafe {
        BUMP_OFFSET = 0;
    }
}
