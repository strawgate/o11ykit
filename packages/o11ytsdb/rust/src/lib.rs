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

#![cfg_attr(not(kani), no_std)]

// Shared lock for tests that mutate global static state.
// This crate uses static mut arrays (ALP_INTS, SCRATCH, INTERN_BUF, etc.)
// which are safe in single-threaded WASM but racy under cargo test's
// parallel test runner. Tests that touch shared state acquire this lock.
#[cfg(test)]
pub(crate) mod test_lock {
    extern crate std;
    pub(crate) static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── Modules ──────────────────────────────────────────────────────────

mod bitio;
mod alloc;
mod gorilla;
mod timestamp;
mod alp;
mod delta_alp;
mod batch;
mod range_decode;
mod interner;
mod simd;
mod alp_exc;

#[cfg(kani)]
mod verification;
