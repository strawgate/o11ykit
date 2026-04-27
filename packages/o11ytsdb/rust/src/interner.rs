// ── String interner extern "C" shims ────────────────────────────────
//
// The pure-Rust interner lives in packages/o11y-codec-rt/interner/.
// This file owns the WASM-side static-mut storage (8 MB byte arena,
// 200K offset table, 512K hash table) that the workspace `Interner`
// borrows on each call.

use o11y_codec_rt_interner::{Interner, EMPTY};

const INTERN_MAX_STRINGS: usize = 200_000;
const INTERN_MAX_BYTES: usize = 8 * 1024 * 1024;
const INTERN_TABLE_SIZE: usize = 1 << 19;

static mut INTERN_BYTES: [u8; INTERN_MAX_BYTES] = [0; INTERN_MAX_BYTES];
static mut INTERN_OFFSETS: [u32; INTERN_MAX_STRINGS + 1] = [0; INTERN_MAX_STRINGS + 1];
static mut INTERN_TABLE: [u32; INTERN_TABLE_SIZE] = [EMPTY; INTERN_TABLE_SIZE];
static mut INTERN_HASHES: [u32; INTERN_TABLE_SIZE] = [0; INTERN_TABLE_SIZE];
static mut INTERN_COUNT: u32 = 0;
static mut INTERN_BYTES_USED: u32 = 0;

/// Build an `Interner` borrowing the static-mut backing store. Single-
/// threaded use only — wasm32 cdylib runs single-threaded by design.
#[allow(static_mut_refs)]
fn with_interner<R>(f: impl FnOnce(&mut Interner<'_>) -> R) -> R {
    // SAFETY: single-threaded WASM cdylib; one borrow at a time per call.
    let mut interner = unsafe {
        Interner::new(
            &mut INTERN_BYTES,
            &mut INTERN_OFFSETS,
            &mut INTERN_TABLE,
            &mut INTERN_HASHES,
            &mut INTERN_COUNT,
            &mut INTERN_BYTES_USED,
        )
    }
    .expect("interner buffer shapes are statically valid");
    f(&mut interner)
}

#[no_mangle]
pub extern "C" fn internerReset() {
    with_interner(|i| i.reset());
}

#[no_mangle]
pub extern "C" fn internerIntern(ptr: *const u8, len: u32) -> u32 {
    if ptr.is_null() {
        return u32::MAX;
    }
    let input = unsafe { core::slice::from_raw_parts(ptr, len as usize) };
    with_interner(|i| i.intern(input).unwrap_or(u32::MAX))
}

#[no_mangle]
pub extern "C" fn internerResolve(id: u32, out_ptr: *mut u8, out_cap: u32) -> u32 {
    if out_ptr.is_null() {
        return 0;
    }
    with_interner(|i| match i.resolve(id) {
        Some(bytes) => {
            if bytes.len() > out_cap as usize {
                return 0;
            }
            // SAFETY: caller-supplied pointer with a declared capacity.
            let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, bytes.len()) };
            out.copy_from_slice(bytes);
            bytes.len() as u32
        }
        None => 0,
    })
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    fn reset_and_intern(s: &[u8]) -> u32 {
        internerIntern(s.as_ptr(), s.len() as u32)
    }

    fn resolve_to_vec(id: u32) -> std::vec::Vec<u8> {
        let mut buf = [0u8; 256];
        let len = internerResolve(id, buf.as_mut_ptr(), 256);
        buf[..len as usize].to_vec()
    }

    #[test]
    fn intern_and_resolve_single() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        internerReset();
        let id = reset_and_intern(b"hello");
        assert_eq!(id, 0);
        assert_eq!(resolve_to_vec(id), b"hello");
    }

    #[test]
    fn intern_deduplication() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        internerReset();
        let id1 = reset_and_intern(b"metric.cpu");
        let id2 = reset_and_intern(b"metric.cpu");
        assert_eq!(id1, id2);
    }

    #[test]
    fn intern_distinct_strings() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        internerReset();
        let id1 = reset_and_intern(b"alpha");
        let id2 = reset_and_intern(b"beta");
        assert_ne!(id1, id2);
        assert_eq!(resolve_to_vec(id1), b"alpha");
        assert_eq!(resolve_to_vec(id2), b"beta");
    }

    #[test]
    fn intern_null_ptr_returns_max() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let id = internerIntern(core::ptr::null(), 5);
        assert_eq!(id, u32::MAX);
    }

    #[test]
    fn resolve_null_ptr() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        let len = internerResolve(0, core::ptr::null_mut(), 64);
        assert_eq!(len, 0);
    }

    #[test]
    fn resolve_invalid_id() {
        let _g = crate::test_lock::LOCK.lock().unwrap();
        internerReset();
        let len = internerResolve(999, [0u8; 64].as_mut_ptr(), 64);
        assert_eq!(len, 0);
    }
}
