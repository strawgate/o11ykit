// ── Memory management: scratch allocator + ALP mode switch ──────────
//
// Static 2 MB bump allocator for WASM linear memory.
// Used by the JS host to allocate temporary buffers for codec I/O.

use core::sync::atomic::{AtomicU8, Ordering};

const SCRATCH_SIZE: usize = 2 * 1024 * 1024; // 2 MB
static mut SCRATCH: [u8; SCRATCH_SIZE] = [0u8; SCRATCH_SIZE];
static mut BUMP_OFFSET: usize = 0;

/// ALP exception encoding mode: 0 = FoR (default), 1 = delta-FoR.
pub(crate) static ALP_EXC_MODE: AtomicU8 = AtomicU8::new(0);

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
    let m = if mode <= 1 { mode as u8 } else { 0 };
    ALP_EXC_MODE.store(m, Ordering::Relaxed);
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    #[test]
    fn scratch_alloc_and_reset() {
        // Reset first to get a clean state.
        resetScratch();
        let ptr1 = allocScratch(16);
        assert!(ptr1 != 0, "first alloc should succeed");
        let ptr2 = allocScratch(32);
        assert!(ptr2 != 0, "second alloc should succeed");
        assert!(ptr2 > ptr1, "second alloc should be after first");
        // Alignment: both should be 8-byte aligned.
        assert_eq!(ptr1 % 8, 0);
        assert_eq!(ptr2 % 8, 0);
        resetScratch();
    }

    #[test]
    fn scratch_alloc_alignment() {
        resetScratch();
        // Allocate 1 byte — should round up to 8.
        let ptr1 = allocScratch(1);
        let ptr2 = allocScratch(1);
        assert_eq!((ptr2 - ptr1) as usize, 8);
        resetScratch();
    }

    #[test]
    fn scratch_alloc_overflow() {
        resetScratch();
        // Try to allocate more than SCRATCH_SIZE.
        let ptr = allocScratch(3 * 1024 * 1024);
        assert_eq!(ptr, 0, "over-capacity alloc should return 0");
        resetScratch();
    }

    #[test]
    fn set_alp_exc_mode_valid() {
        setAlpExcMode(0);
        assert_eq!(ALP_EXC_MODE.load(Ordering::Relaxed), 0);
        setAlpExcMode(1);
        assert_eq!(ALP_EXC_MODE.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn set_alp_exc_mode_invalid_clamps() {
        setAlpExcMode(99);
        assert_eq!(ALP_EXC_MODE.load(Ordering::Relaxed), 0);
        setAlpExcMode(1); // restore
    }
}
