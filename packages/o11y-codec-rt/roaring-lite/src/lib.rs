//! o11y-codec-rt-roaring-lite — minimal Roaring32 bitmap.
//!
//! A Roaring32 bitmap is a `Vec<(high16, Container)>` keyed on the
//! high 16 bits of each `u32`. Each container holds the matching
//! low 16 bits in one of two formats:
//!
//!   - **Array container** for cardinality < 4096: sorted `Vec<u16>`,
//!     2 bytes per value.
//!   - **Bitmap container** for cardinality ≥ 4096: packed
//!     `[u64; 1024]` bit array, 8 KB total.
//!
//! 4096 is the crossover where bitmap (8 KB flat) becomes more
//! compact than array (2 × n bytes). The full Roaring spec also
//! defines a run container for long contiguous ranges; this "lite"
//! subset omits it — engines that need run-encoded sparseness can
//! do so above this layer.
//!
//! Pure-Rust, `#![no_std]` with `extern crate alloc`. Used by the
//! `o11ylogsdb` engine for in-chunk postings (severity values,
//! attribute-key presence, low-cardinality columns) and by the
//! query path for AND-ing postings across columns.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

use alloc::boxed::Box;
use alloc::vec::Vec;

/// Cardinality at which an array container is promoted to a bitmap.
/// Bitmap (8 KB) becomes smaller than the array (2 × n bytes) once
/// `n ≥ 4096`.
pub const ARRAY_TO_BITMAP_CARDINALITY: usize = 4096;

/// Number of `u64` words in a bitmap container (`65536 / 64`).
const BITMAP_WORDS: usize = 1024;

// ── Containers ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Container {
    /// Sorted, deduplicated `u16` values. Always cardinality < 4096
    /// (the promotion fires at exactly 4096).
    Array(Vec<u16>),
    /// 65536-bit packed bitmap. Cardinality ≥ 4096.
    Bitmap(Box<[u64; BITMAP_WORDS]>),
}

impl Container {
    fn new_array() -> Self {
        Container::Array(Vec::new())
    }

    fn cardinality(&self) -> usize {
        match self {
            Container::Array(v) => v.len(),
            Container::Bitmap(b) => b.iter().map(|w| w.count_ones() as usize).sum(),
        }
    }

    fn contains(&self, value: u16) -> bool {
        match self {
            Container::Array(v) => v.binary_search(&value).is_ok(),
            Container::Bitmap(b) => {
                let word = value as usize / 64;
                let bit = value as usize % 64;
                (b[word] >> bit) & 1 != 0
            }
        }
    }

    /// Insert `value`; returns true if it was newly added. Promotes
    /// the container to a bitmap if the array's cardinality reaches
    /// `ARRAY_TO_BITMAP_CARDINALITY`.
    fn insert(&mut self, value: u16) -> bool {
        match self {
            Container::Array(v) => match v.binary_search(&value) {
                Ok(_) => false,
                Err(idx) => {
                    v.insert(idx, value);
                    if v.len() >= ARRAY_TO_BITMAP_CARDINALITY {
                        let mut bitmap = Box::new([0u64; BITMAP_WORDS]);
                        for &x in v.iter() {
                            let word = x as usize / 64;
                            let bit = x as usize % 64;
                            bitmap[word] |= 1u64 << bit;
                        }
                        *self = Container::Bitmap(bitmap);
                    }
                    true
                }
            },
            Container::Bitmap(b) => {
                let word = value as usize / 64;
                let bit = value as usize % 64;
                let was_set = (b[word] >> bit) & 1 != 0;
                b[word] |= 1u64 << bit;
                !was_set
            }
        }
    }

    /// Iterate the values in ascending order.
    fn iter(&self) -> ContainerIter<'_> {
        match self {
            Container::Array(v) => ContainerIter::Array(v.iter()),
            Container::Bitmap(b) => ContainerIter::Bitmap { bitmap: b, word_idx: 0, current: 0 },
        }
    }
}

enum ContainerIter<'a> {
    Array(core::slice::Iter<'a, u16>),
    Bitmap { bitmap: &'a [u64; BITMAP_WORDS], word_idx: usize, current: u64 },
}

impl Iterator for ContainerIter<'_> {
    type Item = u16;
    fn next(&mut self) -> Option<u16> {
        match self {
            ContainerIter::Array(it) => it.next().copied(),
            ContainerIter::Bitmap { bitmap, word_idx, current } => loop {
                if *current != 0 {
                    let bit = current.trailing_zeros() as u16;
                    *current &= *current - 1;
                    return Some((*word_idx as u16 - 1) * 64 + bit);
                }
                if *word_idx >= BITMAP_WORDS {
                    return None;
                }
                *current = bitmap[*word_idx];
                *word_idx += 1;
            },
        }
    }
}

// ── Top-level Roaring32 ──────────────────────────────────────────────

/// Roaring32 bitmap. Internally `Vec<(high16, Container)>` sorted by
/// high16. Insertion is O(log K + log n) where K is the number of
/// containers and n is the cardinality of the matching container.
#[derive(Debug, Clone, Default)]
pub struct RoaringLite {
    containers: Vec<(u16, Container)>,
}

impl RoaringLite {
    pub fn new() -> Self {
        Self { containers: Vec::new() }
    }

    /// Total number of distinct values in the bitmap.
    pub fn cardinality(&self) -> u64 {
        self.containers.iter().map(|(_, c)| c.cardinality() as u64).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.containers.iter().all(|(_, c)| c.cardinality() == 0)
    }

    pub fn contains(&self, value: u32) -> bool {
        let high = (value >> 16) as u16;
        let low = (value & 0xFFFF) as u16;
        self.containers
            .binary_search_by_key(&high, |(h, _)| *h)
            .map(|idx| self.containers[idx].1.contains(low))
            .unwrap_or(false)
    }

    /// Insert `value`; returns true if it was newly added.
    pub fn insert(&mut self, value: u32) -> bool {
        let high = (value >> 16) as u16;
        let low = (value & 0xFFFF) as u16;
        match self.containers.binary_search_by_key(&high, |(h, _)| *h) {
            Ok(idx) => self.containers[idx].1.insert(low),
            Err(idx) => {
                let mut c = Container::new_array();
                c.insert(low);
                self.containers.insert(idx, (high, c));
                true
            }
        }
    }

    /// Iterate all values in ascending order.
    pub fn iter(&self) -> impl Iterator<Item = u32> + '_ {
        self.containers.iter().flat_map(|(high, c)| {
            let high = *high as u32;
            c.iter().map(move |low| (high << 16) | low as u32)
        })
    }

    /// Bitmap intersection. Returns a fresh `RoaringLite`.
    pub fn and(a: &Self, b: &Self) -> Self {
        let mut out = Self::new();
        let mut i = 0;
        let mut j = 0;
        while i < a.containers.len() && j < b.containers.len() {
            let (ah, ac) = &a.containers[i];
            let (bh, bc) = &b.containers[j];
            match ah.cmp(bh) {
                core::cmp::Ordering::Less => i += 1,
                core::cmp::Ordering::Greater => j += 1,
                core::cmp::Ordering::Equal => {
                    let merged = container_and(ac, bc);
                    if merged.cardinality() > 0 {
                        out.containers.push((*ah, merged));
                    }
                    i += 1;
                    j += 1;
                }
            }
        }
        out
    }

    /// Bitmap union. Returns a fresh `RoaringLite`.
    pub fn or(a: &Self, b: &Self) -> Self {
        let mut out = Self::new();
        let mut i = 0;
        let mut j = 0;
        while i < a.containers.len() || j < b.containers.len() {
            if i >= a.containers.len() {
                out.containers.push(b.containers[j].clone());
                j += 1;
                continue;
            }
            if j >= b.containers.len() {
                out.containers.push(a.containers[i].clone());
                i += 1;
                continue;
            }
            let (ah, ac) = &a.containers[i];
            let (bh, bc) = &b.containers[j];
            match ah.cmp(bh) {
                core::cmp::Ordering::Less => {
                    out.containers.push((*ah, ac.clone()));
                    i += 1;
                }
                core::cmp::Ordering::Greater => {
                    out.containers.push((*bh, bc.clone()));
                    j += 1;
                }
                core::cmp::Ordering::Equal => {
                    out.containers.push((*ah, container_or(ac, bc)));
                    i += 1;
                    j += 1;
                }
            }
        }
        out
    }
}

impl FromIterator<u32> for RoaringLite {
    fn from_iter<I: IntoIterator<Item = u32>>(iter: I) -> Self {
        let mut r = Self::new();
        for v in iter {
            r.insert(v);
        }
        r
    }
}

// ── Container intersection ───────────────────────────────────────────

fn container_and(a: &Container, b: &Container) -> Container {
    match (a, b) {
        (Container::Array(av), Container::Array(bv)) => {
            // Linear merge of two sorted slices.
            let mut out = Vec::with_capacity(av.len().min(bv.len()));
            let mut i = 0;
            let mut j = 0;
            while i < av.len() && j < bv.len() {
                match av[i].cmp(&bv[j]) {
                    core::cmp::Ordering::Less => i += 1,
                    core::cmp::Ordering::Greater => j += 1,
                    core::cmp::Ordering::Equal => {
                        out.push(av[i]);
                        i += 1;
                        j += 1;
                    }
                }
            }
            Container::Array(out)
        }
        (Container::Bitmap(ab), Container::Bitmap(bb)) => {
            let mut bitmap = Box::new([0u64; BITMAP_WORDS]);
            let mut card = 0usize;
            for w in 0..BITMAP_WORDS {
                let v = ab[w] & bb[w];
                bitmap[w] = v;
                card += v.count_ones() as usize;
            }
            if card < ARRAY_TO_BITMAP_CARDINALITY {
                bitmap_to_array(&bitmap)
            } else {
                Container::Bitmap(bitmap)
            }
        }
        (Container::Array(av), Container::Bitmap(bb)) | (Container::Bitmap(bb), Container::Array(av)) => {
            let mut out = Vec::with_capacity(av.len());
            for &x in av {
                let word = x as usize / 64;
                let bit = x as usize % 64;
                if (bb[word] >> bit) & 1 != 0 {
                    out.push(x);
                }
            }
            Container::Array(out)
        }
    }
}

// ── Container union ──────────────────────────────────────────────────

fn container_or(a: &Container, b: &Container) -> Container {
    match (a, b) {
        (Container::Array(av), Container::Array(bv)) => {
            // Linear merge, dedup.
            let mut out = Vec::with_capacity(av.len() + bv.len());
            let mut i = 0;
            let mut j = 0;
            while i < av.len() && j < bv.len() {
                match av[i].cmp(&bv[j]) {
                    core::cmp::Ordering::Less => {
                        out.push(av[i]);
                        i += 1;
                    }
                    core::cmp::Ordering::Greater => {
                        out.push(bv[j]);
                        j += 1;
                    }
                    core::cmp::Ordering::Equal => {
                        out.push(av[i]);
                        i += 1;
                        j += 1;
                    }
                }
            }
            out.extend_from_slice(&av[i..]);
            out.extend_from_slice(&bv[j..]);
            if out.len() >= ARRAY_TO_BITMAP_CARDINALITY {
                array_to_bitmap(&out)
            } else {
                Container::Array(out)
            }
        }
        (Container::Bitmap(ab), Container::Bitmap(bb)) => {
            let mut bitmap = Box::new([0u64; BITMAP_WORDS]);
            for w in 0..BITMAP_WORDS {
                bitmap[w] = ab[w] | bb[w];
            }
            Container::Bitmap(bitmap)
        }
        (Container::Array(av), Container::Bitmap(bb))
        | (Container::Bitmap(bb), Container::Array(av)) => {
            let mut bitmap = (*bb).clone();
            for &x in av {
                let word = x as usize / 64;
                let bit = x as usize % 64;
                bitmap[word] |= 1u64 << bit;
            }
            Container::Bitmap(bitmap)
        }
    }
}

// ── Container conversion helpers ─────────────────────────────────────

fn array_to_bitmap(values: &[u16]) -> Container {
    let mut bitmap = Box::new([0u64; BITMAP_WORDS]);
    for &x in values {
        let word = x as usize / 64;
        let bit = x as usize % 64;
        bitmap[word] |= 1u64 << bit;
    }
    Container::Bitmap(bitmap)
}

fn bitmap_to_array(bitmap: &[u64; BITMAP_WORDS]) -> Container {
    let mut out = Vec::new();
    for (w, &word) in bitmap.iter().enumerate() {
        let base = (w * 64) as u16;
        let mut bits = word;
        while bits != 0 {
            let b = bits.trailing_zeros() as u16;
            out.push(base + b);
            bits &= bits - 1;
        }
    }
    Container::Array(out)
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    #[test]
    fn empty_bitmap() {
        let r = RoaringLite::new();
        assert_eq!(r.cardinality(), 0);
        assert!(r.is_empty());
        assert!(!r.contains(0));
        assert!(r.iter().next().is_none());
    }

    #[test]
    fn insert_and_contains() {
        let mut r = RoaringLite::new();
        assert!(r.insert(5));
        assert!(r.insert(100));
        assert!(r.insert(5_000_000));
        assert!(!r.insert(5)); // dup
        assert_eq!(r.cardinality(), 3);
        assert!(r.contains(5));
        assert!(r.contains(100));
        assert!(r.contains(5_000_000));
        assert!(!r.contains(6));
    }

    #[test]
    fn iter_ascending_order() {
        let r: RoaringLite = [42u32, 1, 100, 65535, 65536, 70000].iter().copied().collect();
        let collected: std::vec::Vec<u32> = r.iter().collect();
        let mut expected = std::vec![1u32, 42, 100, 65535, 65536, 70000];
        expected.sort();
        assert_eq!(collected, expected);
    }

    #[test]
    fn array_promotes_to_bitmap_at_4096() {
        let mut r = RoaringLite::new();
        // All values share high16=0 → single container; insert 4096 of them.
        for v in 0u32..4096 {
            r.insert(v);
        }
        assert_eq!(r.cardinality(), 4096);
        // Insert 4097th value in same container — exercises the bitmap path.
        r.insert(40_000);
        assert!(r.contains(40_000));
        // All originals still present.
        for v in 0u32..4096 {
            assert!(r.contains(v), "missing {v}");
        }
    }

    #[test]
    fn high_cardinality_dense_block() {
        let mut r = RoaringLite::new();
        for v in 0u32..10_000 {
            r.insert(v);
        }
        assert_eq!(r.cardinality(), 10_000);
        for v in 0u32..10_000 {
            assert!(r.contains(v));
        }
        assert!(!r.contains(10_001));
    }

    #[test]
    fn cross_container_distinct_high16() {
        let mut r = RoaringLite::new();
        // Three different high16 values, each gets its own container.
        r.insert(1); // high=0
        r.insert(0x10000); // high=1
        r.insert(0x20000); // high=2
        assert_eq!(r.cardinality(), 3);
        for v in [1u32, 0x10000, 0x20000] {
            assert!(r.contains(v));
        }
    }

    #[test]
    fn and_array_array() {
        let a: RoaringLite = [1u32, 2, 3, 4, 5].iter().copied().collect();
        let b: RoaringLite = [3u32, 4, 5, 6, 7].iter().copied().collect();
        let inter = RoaringLite::and(&a, &b);
        let got: std::vec::Vec<u32> = inter.iter().collect();
        assert_eq!(got, std::vec![3u32, 4, 5]);
    }

    #[test]
    fn and_disjoint_high16() {
        let a: RoaringLite = [1u32, 2, 3].iter().copied().collect();
        let b: RoaringLite = [0x10000u32, 0x10001].iter().copied().collect();
        let inter = RoaringLite::and(&a, &b);
        assert_eq!(inter.cardinality(), 0);
    }

    #[test]
    fn and_bitmap_bitmap() {
        let mut a = RoaringLite::new();
        let mut b = RoaringLite::new();
        for v in 0u32..5000 {
            a.insert(v);
        }
        for v in 2500u32..7500 {
            b.insert(v);
        }
        let inter = RoaringLite::and(&a, &b);
        assert_eq!(inter.cardinality(), 2500);
        for v in 2500u32..5000 {
            assert!(inter.contains(v));
        }
        assert!(!inter.contains(2499));
        assert!(!inter.contains(5000));
    }

    #[test]
    fn and_array_bitmap_mixed() {
        let mut a = RoaringLite::new();
        // a is a small array container.
        for v in [10u32, 20, 30, 40, 50] {
            a.insert(v);
        }
        // b is dense → bitmap.
        let mut b = RoaringLite::new();
        for v in 0u32..5000 {
            b.insert(v);
        }
        let inter = RoaringLite::and(&a, &b);
        let got: std::vec::Vec<u32> = inter.iter().collect();
        assert_eq!(got, std::vec![10u32, 20, 30, 40, 50]);
    }

    #[test]
    fn or_array_array() {
        let a: RoaringLite = [1u32, 3, 5].iter().copied().collect();
        let b: RoaringLite = [2u32, 4, 5, 6].iter().copied().collect();
        let union = RoaringLite::or(&a, &b);
        let got: std::vec::Vec<u32> = union.iter().collect();
        assert_eq!(got, std::vec![1u32, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn or_disjoint_high16_concatenates() {
        let a: RoaringLite = [1u32, 2].iter().copied().collect();
        let b: RoaringLite = [0x10000u32].iter().copied().collect();
        let union = RoaringLite::or(&a, &b);
        let got: std::vec::Vec<u32> = union.iter().collect();
        assert_eq!(got, std::vec![1u32, 2, 0x10000]);
    }

    #[test]
    fn or_promotes_when_combined_cardinality_high() {
        let mut a = RoaringLite::new();
        let mut b = RoaringLite::new();
        for v in 0u32..3000 {
            a.insert(v);
        }
        for v in 3000u32..5000 {
            b.insert(v);
        }
        let union = RoaringLite::or(&a, &b);
        assert_eq!(union.cardinality(), 5000);
        for v in 0u32..5000 {
            assert!(union.contains(v));
        }
    }

    #[test]
    fn and_demotes_bitmap_to_array_when_sparse() {
        let mut a = RoaringLite::new();
        let mut b = RoaringLite::new();
        for v in 0u32..5000 {
            a.insert(v);
        }
        // b dense too, but only overlaps with a few of a's values.
        for v in 5000u32..10_000 {
            b.insert(v);
        }
        b.insert(123);
        b.insert(456);
        let inter = RoaringLite::and(&a, &b);
        // Only 123 and 456 are in both.
        assert_eq!(inter.cardinality(), 2);
        assert!(inter.contains(123));
        assert!(inter.contains(456));
    }

    #[test]
    fn duplicate_inserts_dont_grow_cardinality() {
        let mut r = RoaringLite::new();
        for _ in 0..10 {
            r.insert(42);
        }
        assert_eq!(r.cardinality(), 1);
    }

    #[test]
    fn full_u32_range_corners() {
        let mut r = RoaringLite::new();
        r.insert(0);
        r.insert(u32::MAX);
        r.insert(u32::MAX / 2);
        assert_eq!(r.cardinality(), 3);
        assert!(r.contains(0));
        assert!(r.contains(u32::MAX));
        assert!(r.contains(u32::MAX / 2));
    }
}
