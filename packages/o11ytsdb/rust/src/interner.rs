// ── String interner: FNV-1a hash, linear probing ────────────────────
//
// WASM-side string deduplication for metric names and label keys/values.
// Capacity: 200K unique strings, 8 MB total bytes, 512K hash table slots.

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
        internerReset();
        let id = reset_and_intern(b"hello");
        assert_eq!(id, 0);
        assert_eq!(resolve_to_vec(id), b"hello");
    }

    #[test]
    fn intern_deduplication() {
        internerReset();
        let id1 = reset_and_intern(b"metric.cpu");
        let id2 = reset_and_intern(b"metric.cpu");
        assert_eq!(id1, id2, "same string should return same id");
    }

    #[test]
    fn intern_distinct_strings() {
        internerReset();
        let id1 = reset_and_intern(b"alpha");
        let id2 = reset_and_intern(b"beta");
        assert_ne!(id1, id2);
        assert_eq!(resolve_to_vec(id1), b"alpha");
        assert_eq!(resolve_to_vec(id2), b"beta");
    }

    #[test]
    fn intern_reset_clears_state() {
        internerReset();
        reset_and_intern(b"before_reset");
        internerReset();
        // After reset, resolving id 0 should fail.
        let len = internerResolve(0, [0u8; 64].as_mut_ptr(), 64);
        assert_eq!(len, 0);
        // New intern should get id 0.
        let id = reset_and_intern(b"after_reset");
        assert_eq!(id, 0);
        assert_eq!(resolve_to_vec(id), b"after_reset");
    }

    #[test]
    fn intern_null_ptr_returns_max() {
        let id = internerIntern(core::ptr::null(), 5);
        assert_eq!(id, u32::MAX);
    }

    #[test]
    fn resolve_invalid_id() {
        internerReset();
        let mut buf = [0u8; 64];
        let len = internerResolve(999, buf.as_mut_ptr(), 64);
        assert_eq!(len, 0);
    }

    #[test]
    fn resolve_null_ptr() {
        let len = internerResolve(0, core::ptr::null_mut(), 64);
        assert_eq!(len, 0);
    }

    #[test]
    fn intern_empty_string() {
        internerReset();
        let id = reset_and_intern(b"");
        assert_eq!(id, 0);
        assert_eq!(resolve_to_vec(id), b"");
    }

    #[test]
    fn intern_many_strings() {
        internerReset();
        let mut ids = std::vec::Vec::new();
        for i in 0u32..100 {
            let s = std::format!("metric_{i:04}");
            let id = internerIntern(s.as_ptr(), s.len() as u32);
            assert_ne!(id, u32::MAX);
            ids.push((id, s));
        }
        // Verify all resolve correctly.
        for (id, s) in &ids {
            assert_eq!(resolve_to_vec(*id), s.as_bytes());
        }
        // Verify dedup — intern same strings again.
        for (id, s) in &ids {
            let id2 = internerIntern(s.as_ptr(), s.len() as u32);
            assert_eq!(*id, id2);
        }
    }

    #[test]
    fn fnv1a32_basic() {
        // Known FNV-1a values.
        assert_eq!(fnv1a32(b""), 0x811c9dc5);
        let h1 = fnv1a32(b"a");
        let h2 = fnv1a32(b"b");
        assert_ne!(h1, h2, "different inputs should hash differently");
    }
}
