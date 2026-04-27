//! o11y-codec-rt-interner — string interner.
//!
//! FNV-1a hash + open-addressing linear probing. The host engine
//! supplies the four backing buffers and the two scalar counters:
//! a byte arena for the strings themselves, a parallel offsets table
//! that delimits each interned string, and a hash-table pair (slots
//! + parallel hash array) for lookup.
//!
//! Why borrow rather than allocate: the workspace is `#![no_std]`
//! with no allocator, and the engines that consume the interner
//! already own static-mut storage sized to their workload (metric
//! cardinality for `o11ytsdb`, log-attribute cardinality for
//! `o11ylogsdb`). Borrowing keeps the codec runtime allocator-free
//! and lets each engine pick its own capacity.
//!
//! Safety: the four buffers must be of the right shapes:
//!
//!   - `bytes`: arbitrary length (capacity for the string arena);
//!   - `offsets`: `max_strings + 1` entries — one per string, plus a
//!     trailing sentinel that holds `bytes_used` so each string's
//!     length is `offsets[i+1] - offsets[i]`;
//!   - `table` and `hashes`: equal length, must be a power of two.
//!
//! `Interner::new` validates the shapes and returns `None` on a
//! mismatch. Single-threaded use only — no internal synchronization.

#![cfg_attr(not(test), no_std)]

/// Sentinel for an empty hash-table slot. Exposed so callers can
/// initialize their `table` storage to the right value.
pub const EMPTY: u32 = u32::MAX;

#[inline(always)]
pub fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for &b in bytes {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

/// Borrowed view of an interner. Construct with `Interner::new` and
/// call `intern` / `resolve` / `reset`. The struct itself holds no
/// data — all state lives in the host's buffers.
pub struct Interner<'a> {
    /// Byte arena. Strings are written sequentially.
    bytes: &'a mut [u8],
    /// `offsets[i]` = start byte of string `i`; `offsets[i+1]` = end.
    offsets: &'a mut [u32],
    /// Hash-table slots: each entry is either `EMPTY` or a string id.
    /// Length must be a power of two.
    table: &'a mut [u32],
    /// Parallel array of full hashes for collision distinguishing.
    /// Same length as `table`.
    hashes: &'a mut [u32],
    /// Number of interned strings (next id to assign).
    count: &'a mut u32,
    /// Bytes used in `bytes`; offsets's first slot equals 0 at empty.
    bytes_used: &'a mut u32,
}

impl<'a> Interner<'a> {
    /// Build a new interner over caller-owned buffers. Returns
    /// `None` if the shapes don't match the documented invariants
    /// (table length not a power of two, offsets too short, etc.).
    ///
    /// Does *not* clear the buffers — the caller is responsible for
    /// calling [`reset`](Self::reset) to initialize a fresh interner,
    /// or for restoring previously-saved state.
    pub fn new(
        bytes: &'a mut [u8],
        offsets: &'a mut [u32],
        table: &'a mut [u32],
        hashes: &'a mut [u32],
        count: &'a mut u32,
        bytes_used: &'a mut u32,
    ) -> Option<Self> {
        if offsets.len() < 2 {
            return None;
        }
        if table.len() != hashes.len() || !table.len().is_power_of_two() {
            return None;
        }
        Some(Self { bytes, offsets, table, hashes, count, bytes_used })
    }

    /// Maximum strings this interner can hold (`offsets.len() - 1`).
    pub fn max_strings(&self) -> usize {
        self.offsets.len() - 1
    }

    /// Capacity of the byte arena.
    pub fn bytes_capacity(&self) -> usize {
        self.bytes.len()
    }

    /// Number of interned strings so far.
    pub fn count(&self) -> u32 {
        *self.count
    }

    /// Bytes used in the arena so far.
    pub fn bytes_used(&self) -> u32 {
        *self.bytes_used
    }

    /// Clear all state. Required before first use, or to recycle.
    pub fn reset(&mut self) {
        *self.count = 0;
        *self.bytes_used = 0;
        self.offsets[0] = 0;
        for slot in self.table.iter_mut() {
            *slot = EMPTY;
        }
        for h in self.hashes.iter_mut() {
            *h = 0;
        }
    }

    /// Intern `key`. Returns the assigned (or pre-existing) id, or
    /// `None` if either the string-count or byte-arena capacity is
    /// exhausted.
    ///
    /// `key` may be empty — empty strings get a stable id like any
    /// other.
    pub fn intern(&mut self, key: &[u8]) -> Option<u32> {
        let hash = fnv1a32(key);
        let mask = (self.table.len() - 1) as u32;
        let mut slot = hash & mask;

        loop {
            let existing = self.table[slot as usize];
            if existing == EMPTY {
                let id = *self.count;
                if id as usize >= self.max_strings() {
                    return None;
                }
                let start = *self.bytes_used as usize;
                let end = start + key.len();
                if end > self.bytes.len() {
                    return None;
                }
                self.bytes[start..end].copy_from_slice(key);
                self.offsets[id as usize] = *self.bytes_used;
                *self.bytes_used = end as u32;
                self.offsets[id as usize + 1] = *self.bytes_used;
                self.table[slot as usize] = id;
                self.hashes[slot as usize] = hash;
                *self.count = id + 1;
                return Some(id);
            }
            if self.hashes[slot as usize] == hash && self.equals(existing, key) {
                return Some(existing);
            }
            slot = (slot + 1) & mask;
        }
    }

    /// Resolve `id` to its byte slice. Returns `None` if `id` is
    /// out of range.
    pub fn resolve(&self, id: u32) -> Option<&[u8]> {
        if id >= *self.count {
            return None;
        }
        let start = self.offsets[id as usize] as usize;
        let end = self.offsets[id as usize + 1] as usize;
        Some(&self.bytes[start..end])
    }

    #[inline(always)]
    fn equals(&self, id: u32, key: &[u8]) -> bool {
        let start = self.offsets[id as usize] as usize;
        let end = self.offsets[id as usize + 1] as usize;
        if end - start != key.len() {
            return false;
        }
        self.bytes[start..end] == *key
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // The tests build a small interner over local buffers — no static
    // state, so cargo test's parallel runner is fine.

    fn fixture() -> (
        std::vec::Vec<u8>,
        std::vec::Vec<u32>,
        std::vec::Vec<u32>,
        std::vec::Vec<u32>,
        u32,
        u32,
    ) {
        // 1 KB arena, 64 strings max, 256-slot hash table (power of two).
        let bytes = std::vec![0u8; 1024];
        let offsets = std::vec![0u32; 65];
        let table = std::vec![EMPTY; 256];
        let hashes = std::vec![0u32; 256];
        (bytes, offsets, table, hashes, 0u32, 0u32)
    }

    fn with_interner<F, R>(f: F) -> R
    where
        F: FnOnce(&mut Interner<'_>) -> R,
    {
        let (mut bytes, mut offsets, mut table, mut hashes, mut count, mut bytes_used) = fixture();
        let mut interner = Interner::new(
            &mut bytes,
            &mut offsets,
            &mut table,
            &mut hashes,
            &mut count,
            &mut bytes_used,
        )
        .unwrap();
        interner.reset();
        f(&mut interner)
    }

    #[test]
    fn intern_and_resolve_single() {
        with_interner(|i| {
            let id = i.intern(b"hello").unwrap();
            assert_eq!(id, 0);
            assert_eq!(i.resolve(id), Some(&b"hello"[..]));
        });
    }

    #[test]
    fn intern_deduplication() {
        with_interner(|i| {
            let id1 = i.intern(b"metric.cpu").unwrap();
            let id2 = i.intern(b"metric.cpu").unwrap();
            assert_eq!(id1, id2);
            assert_eq!(i.count(), 1);
        });
    }

    #[test]
    fn intern_distinct_strings() {
        with_interner(|i| {
            let id1 = i.intern(b"alpha").unwrap();
            let id2 = i.intern(b"beta").unwrap();
            assert_ne!(id1, id2);
            assert_eq!(i.resolve(id1), Some(&b"alpha"[..]));
            assert_eq!(i.resolve(id2), Some(&b"beta"[..]));
        });
    }

    #[test]
    fn reset_clears_state() {
        with_interner(|i| {
            i.intern(b"before").unwrap();
            assert_eq!(i.count(), 1);
            i.reset();
            assert_eq!(i.count(), 0);
            assert_eq!(i.resolve(0), None);
            let id = i.intern(b"after").unwrap();
            assert_eq!(id, 0);
            assert_eq!(i.resolve(id), Some(&b"after"[..]));
        });
    }

    #[test]
    fn intern_empty_string() {
        with_interner(|i| {
            let id = i.intern(b"").unwrap();
            assert_eq!(id, 0);
            assert_eq!(i.resolve(id), Some(&b""[..]));
        });
    }

    #[test]
    fn resolve_invalid_id() {
        with_interner(|i| {
            assert_eq!(i.resolve(0), None); // never interned
            assert_eq!(i.resolve(999), None);
        });
    }

    #[test]
    fn intern_many_strings() {
        with_interner(|i| {
            let mut ids = std::vec::Vec::new();
            for n in 0u32..50 {
                let s = std::format!("metric_{n:04}");
                let id = i.intern(s.as_bytes()).unwrap();
                ids.push((id, s));
            }
            for (id, s) in &ids {
                assert_eq!(i.resolve(*id), Some(s.as_bytes()));
            }
            // Dedup on second pass.
            for (id, s) in &ids {
                assert_eq!(i.intern(s.as_bytes()).unwrap(), *id);
            }
        });
    }

    #[test]
    fn intern_returns_none_at_string_capacity() {
        // 4-string fixture: 0..3 succeed, 4th returns None.
        let mut bytes = std::vec![0u8; 1024];
        let mut offsets = std::vec![0u32; 5]; // 4 strings + sentinel
        let mut table = std::vec![EMPTY; 16];
        let mut hashes = std::vec![0u32; 16];
        let mut count = 0u32;
        let mut bytes_used = 0u32;
        let mut i = Interner::new(
            &mut bytes,
            &mut offsets,
            &mut table,
            &mut hashes,
            &mut count,
            &mut bytes_used,
        )
        .unwrap();
        i.reset();
        assert_eq!(i.intern(b"a").unwrap(), 0);
        assert_eq!(i.intern(b"b").unwrap(), 1);
        assert_eq!(i.intern(b"c").unwrap(), 2);
        assert_eq!(i.intern(b"d").unwrap(), 3);
        assert_eq!(i.intern(b"e"), None);
    }

    #[test]
    fn intern_returns_none_at_byte_capacity() {
        // 8-byte arena: "hello" + "world" (5+5=10) busts the limit.
        let mut bytes = std::vec![0u8; 8];
        let mut offsets = std::vec![0u32; 4];
        let mut table = std::vec![EMPTY; 8];
        let mut hashes = std::vec![0u32; 8];
        let mut count = 0u32;
        let mut bytes_used = 0u32;
        let mut i = Interner::new(
            &mut bytes,
            &mut offsets,
            &mut table,
            &mut hashes,
            &mut count,
            &mut bytes_used,
        )
        .unwrap();
        i.reset();
        assert_eq!(i.intern(b"hello").unwrap(), 0);
        assert_eq!(i.intern(b"world"), None);
    }

    #[test]
    fn new_rejects_non_power_of_two_table() {
        let mut bytes = std::vec![0u8; 64];
        let mut offsets = std::vec![0u32; 4];
        let mut table = std::vec![EMPTY; 17]; // not power of two
        let mut hashes = std::vec![0u32; 17];
        let mut count = 0u32;
        let mut bytes_used = 0u32;
        let r = Interner::new(
            &mut bytes,
            &mut offsets,
            &mut table,
            &mut hashes,
            &mut count,
            &mut bytes_used,
        );
        assert!(r.is_none());
    }

    #[test]
    fn new_rejects_table_hashes_length_mismatch() {
        let mut bytes = std::vec![0u8; 64];
        let mut offsets = std::vec![0u32; 4];
        let mut table = std::vec![EMPTY; 16];
        let mut hashes = std::vec![0u32; 32];
        let mut count = 0u32;
        let mut bytes_used = 0u32;
        let r = Interner::new(
            &mut bytes,
            &mut offsets,
            &mut table,
            &mut hashes,
            &mut count,
            &mut bytes_used,
        );
        assert!(r.is_none());
    }

    #[test]
    fn fnv1a_known_values() {
        assert_eq!(fnv1a32(b""), 0x811c9dc5);
        assert_ne!(fnv1a32(b"a"), fnv1a32(b"b"));
    }
}
