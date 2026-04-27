//! o11y-codec-rt-fsst — Fast Static Symbol Table string codec.
//!
//! Reference: Boncz, Neumann, Leis, "FSST: Fast Random Access String
//! Compression" (VLDB 2020). Per-chunk symbol table built from a sample;
//! greedy left-to-right encode replacing input substrings with 1-byte
//! symbol ids; an escape byte (0xFF) precedes any byte that no symbol
//! matched.
//!
//! This first cut prioritizes correctness: greedy encode, sequential
//! decode, naive k-gram-frequency-based symbol-table builder.
//! Suffix-counting selection, hash-accelerated encode, and branch-free
//! SIMD decode are follow-up optimization work.
//!
//! ## Wire format
//!
//! - Each output byte is either a **symbol id** (`0..0xFF`) — emit
//!   `table.symbol(id)`'s bytes — or the **escape byte** (`0xFF`)
//!   followed by a single literal byte — emit that literal verbatim.
//! - The encoder picks the longest matching symbol at each position
//!   and falls back to escape when nothing matches.
//! - The symbol table itself is *not* embedded in the output; the
//!   caller persists the table out-of-band (typically once per chunk).

#![cfg_attr(not(test), no_std)]

extern crate alloc;

use alloc::vec::Vec;

/// Maximum number of symbols a table can hold. Byte `0xFF` is reserved
/// as the escape marker, so symbol ids span `0..=254`.
pub const FSST_MAX_SYMBOLS: usize = 255;

/// Maximum bytes per symbol. The published algorithm's sweet spot.
pub const FSST_MAX_SYMBOL_LEN: usize = 8;

/// Escape byte. When the encoder can't match any symbol, it emits
/// this byte followed by the literal input byte.
pub const FSST_ESCAPE: u8 = 0xFF;

// ── Symbol table ─────────────────────────────────────────────────────

/// Static symbol table. Symbols are stored in a flat byte buffer with
/// a parallel lengths array; the table never reallocates after
/// construction.
#[derive(Debug, Clone)]
pub struct SymbolTable {
    /// Concatenated symbol bytes. `symbols[offsets[i]..offsets[i+1]]`
    /// is symbol `i` (id = `i`).
    bytes: Vec<u8>,
    /// `count + 1` offsets into `bytes`. The trailing entry holds the
    /// total length so each symbol's bytes are
    /// `&bytes[offsets[i] as usize..offsets[i+1] as usize]`.
    offsets: Vec<u16>,
    count: u8,
}

impl Default for SymbolTable {
    fn default() -> Self {
        Self::empty()
    }
}

impl SymbolTable {
    /// Empty table — every input byte will encode as an escape pair.
    /// Decoders given an empty table only handle escape sequences.
    pub fn empty() -> Self {
        Self { bytes: Vec::new(), offsets: alloc::vec![0u16], count: 0 }
    }

    /// Build a table from caller-supplied symbol bytes. Each symbol's
    /// length must be in `1..=FSST_MAX_SYMBOL_LEN`. Returns `None` if
    /// the input violates the contract (too many symbols, an empty
    /// symbol, or one longer than `FSST_MAX_SYMBOL_LEN`).
    pub fn from_symbols(symbols: &[&[u8]]) -> Option<Self> {
        if symbols.len() > FSST_MAX_SYMBOLS {
            return None;
        }
        let mut bytes = Vec::with_capacity(symbols.len() * FSST_MAX_SYMBOL_LEN);
        let mut offsets = Vec::with_capacity(symbols.len() + 1);
        offsets.push(0u16);
        for &sym in symbols {
            if sym.is_empty() || sym.len() > FSST_MAX_SYMBOL_LEN {
                return None;
            }
            bytes.extend_from_slice(sym);
            offsets.push(bytes.len() as u16);
        }
        Some(Self { bytes, offsets, count: symbols.len() as u8 })
    }

    pub fn count(&self) -> u8 {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn symbol(&self, id: u8) -> Option<&[u8]> {
        if id >= self.count {
            return None;
        }
        let start = self.offsets[id as usize] as usize;
        let end = self.offsets[id as usize + 1] as usize;
        Some(&self.bytes[start..end])
    }

    /// Longest-match scan: return `(id, len)` for the longest symbol
    /// that prefixes `src`, or `None` if no symbol matches. O(N*L)
    /// where N=count and L=FSST_MAX_SYMBOL_LEN; correctness-first.
    pub fn longest_match(&self, src: &[u8]) -> Option<(u8, usize)> {
        let mut best: Option<(u8, usize)> = None;
        for id in 0..self.count {
            let sym = self.symbol(id).unwrap();
            if sym.len() > src.len() {
                continue;
            }
            if &src[..sym.len()] == sym {
                let take = match best {
                    Some((_, len)) => sym.len() > len,
                    None => true,
                };
                if take {
                    best = Some((id, sym.len()));
                }
            }
        }
        best
    }
}

// ── Encode ───────────────────────────────────────────────────────────

/// Greedy left-to-right encode. Returns bytes written, or 0 if `dst`
/// is too small.
///
/// At every input position, the encoder tries to match the longest
/// symbol from `table`; on a hit it emits the symbol id (1 byte) and
/// advances by the symbol's length. On a miss it emits `FSST_ESCAPE`
/// followed by the literal input byte (2 bytes) and advances by 1.
///
/// Worst case (no symbols match) the output is 2× the input size, so
/// callers should size `dst >= 2 * src.len()`.
pub fn encode(table: &SymbolTable, src: &[u8], dst: &mut [u8]) -> usize {
    let mut sp = 0;
    let mut dp = 0;
    while sp < src.len() {
        match table.longest_match(&src[sp..]) {
            Some((id, len)) => {
                if dp >= dst.len() {
                    return 0;
                }
                dst[dp] = id;
                dp += 1;
                sp += len;
            }
            None => {
                if dp + 1 >= dst.len() {
                    return 0;
                }
                dst[dp] = FSST_ESCAPE;
                dst[dp + 1] = src[sp];
                dp += 2;
                sp += 1;
            }
        }
    }
    dp
}

// ── Decode ───────────────────────────────────────────────────────────

/// Sequential decode. Returns bytes written, or 0 if `dst` is too
/// small or `src` is malformed (escape with no following byte, or a
/// symbol id that's out of range).
pub fn decode(table: &SymbolTable, src: &[u8], dst: &mut [u8]) -> usize {
    let mut sp = 0;
    let mut dp = 0;
    while sp < src.len() {
        let b = src[sp];
        if b == FSST_ESCAPE {
            sp += 1;
            if sp >= src.len() {
                return 0;
            }
            if dp >= dst.len() {
                return 0;
            }
            dst[dp] = src[sp];
            dp += 1;
            sp += 1;
        } else {
            let sym = match table.symbol(b) {
                Some(s) => s,
                None => return 0,
            };
            if dp + sym.len() > dst.len() {
                return 0;
            }
            dst[dp..dp + sym.len()].copy_from_slice(sym);
            dp += sym.len();
            sp += 1;
        }
    }
    dp
}

// ── Symbol-table builder (correctness-first) ────────────────────────

/// Build a symbol table from a sample of input strings. Naive
/// frequency-based selection: count k-gram occurrences for k in
/// `1..=FSST_MAX_SYMBOL_LEN`, score each by `count * (k - 1)` (the
/// bytes saved per occurrence vs literal+escape encoding), and pick
/// the top `FSST_MAX_SYMBOLS` by score.
///
/// Won't match the published paper's compression ratio (which uses
/// suffix counting + iterative refinement), but produces valid tables
/// that round-trip correctly under [`encode`]/[`decode`].
pub fn build_symbol_table(samples: &[&[u8]]) -> SymbolTable {
    // Count every k-gram for k in 1..=8.
    let mut counts: Vec<(Vec<u8>, u32)> = Vec::new();
    for &sample in samples {
        for start in 0..sample.len() {
            for k in 1..=FSST_MAX_SYMBOL_LEN {
                if start + k > sample.len() {
                    break;
                }
                let kgram = &sample[start..start + k];
                if let Some(entry) = counts.iter_mut().find(|(s, _)| s.as_slice() == kgram) {
                    entry.1 += 1;
                } else {
                    counts.push((kgram.to_vec(), 1));
                }
            }
        }
    }

    // Score: count * (len - 1). Single-byte k-grams have score 0 — but
    // they still need to appear in the table so that *every* byte the
    // encoder might see can encode without an escape if frequent
    // enough. To make sure single bytes are eligible, give them a
    // minimum score of `count` (so a frequent byte still beats a
    // 2-byte that occurs once).
    let mut scored: Vec<(Vec<u8>, u32, i64)> = counts
        .into_iter()
        .map(|(s, c)| {
            let saved = if s.len() == 1 { c as i64 } else { c as i64 * (s.len() as i64 - 1) };
            (s, c, saved)
        })
        .collect();
    scored.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.0.len().cmp(&a.0.len())));

    let take = scored.len().min(FSST_MAX_SYMBOLS);
    let chosen: Vec<&[u8]> = scored.iter().take(take).map(|(s, _, _)| s.as_slice()).collect();
    SymbolTable::from_symbols(&chosen).expect("frequency-built symbols are valid")
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use alloc::vec;

    fn roundtrip(table: &SymbolTable, input: &[u8]) {
        let mut enc = vec![0u8; input.len() * 2 + 16];
        let n = encode(table, input, &mut enc);
        assert!(n > 0 || input.is_empty(), "encode failed");
        let mut dec = vec![0u8; input.len()];
        let m = decode(table, &enc[..n], &mut dec);
        assert_eq!(m, input.len());
        assert_eq!(&dec[..m], input);
    }

    #[test]
    fn empty_input_roundtrips() {
        let table = SymbolTable::empty();
        let mut dst = [0u8; 4];
        assert_eq!(encode(&table, b"", &mut dst), 0);
        assert_eq!(decode(&table, &[], &mut dst), 0);
    }

    #[test]
    fn empty_table_uses_only_escapes() {
        let table = SymbolTable::empty();
        let input = b"hello";
        let mut enc = [0u8; 32];
        let n = encode(&table, input, &mut enc);
        // Each input byte produces 2 output bytes (escape + literal).
        assert_eq!(n, input.len() * 2);
        for i in 0..input.len() {
            assert_eq!(enc[i * 2], FSST_ESCAPE);
            assert_eq!(enc[i * 2 + 1], input[i]);
        }
        roundtrip(&table, input);
    }

    #[test]
    fn manual_table_picks_longest_symbol() {
        // Symbols: "the", "th", "e".
        let table = SymbolTable::from_symbols(&[b"the", b"th", b"e"]).unwrap();
        // Encoding "the" should pick "the" (id 0), one byte.
        let mut enc = [0u8; 8];
        let n = encode(&table, b"the", &mut enc);
        assert_eq!(n, 1);
        assert_eq!(enc[0], 0);
        roundtrip(&table, b"the");
    }

    #[test]
    fn falls_back_to_escape_when_no_match() {
        let table = SymbolTable::from_symbols(&[b"foo", b"bar"]).unwrap();
        let mut enc = [0u8; 16];
        // "x" has no symbol, so encode is escape + 'x' (2 bytes).
        let n = encode(&table, b"x", &mut enc);
        assert_eq!(n, 2);
        assert_eq!(enc[0], FSST_ESCAPE);
        assert_eq!(enc[1], b'x');
    }

    #[test]
    fn mixed_match_and_escape() {
        let table = SymbolTable::from_symbols(&[b"foo"]).unwrap();
        roundtrip(&table, b"foobar");
    }

    #[test]
    fn build_table_from_samples() {
        let samples: &[&[u8]] = &[
            b"hello world",
            b"hello there",
            b"hello again",
            b"world peace",
        ];
        let table = build_symbol_table(samples);
        assert!(table.count() > 0);
        for &s in samples {
            roundtrip(&table, s);
        }
    }

    #[test]
    fn build_table_compresses_repeated_strings() {
        // 64 copies of "errorerrorerror" — a single symbol "error"
        // should win and the encoded output should be < 4× the input
        // (vs 2× for all-escape).
        let mut sample = std::vec::Vec::new();
        for _ in 0..64 {
            sample.extend_from_slice(b"errorerrorerror");
        }
        let samples: &[&[u8]] = &[&sample];
        let table = build_symbol_table(samples);
        let mut enc = vec![0u8; sample.len() * 2 + 16];
        let n = encode(&table, &sample, &mut enc);
        // With "error" as a 5-byte symbol, every 5 bytes encodes as 1.
        // Conservative bound: well under input length.
        assert!(n < sample.len(), "FSST should compress repeated strings; n={n} input={}", sample.len());
        roundtrip(&table, &sample);
    }

    #[test]
    fn from_symbols_rejects_too_many() {
        // 256 symbols exceeds the 255 limit.
        let big: std::vec::Vec<&[u8]> = (0..256).map(|_| b"ab" as &[u8]).collect();
        assert!(SymbolTable::from_symbols(&big).is_none());
    }

    #[test]
    fn from_symbols_rejects_empty_symbol() {
        let empty: &[u8] = b"";
        assert!(SymbolTable::from_symbols(&[b"foo", empty]).is_none());
    }

    #[test]
    fn from_symbols_rejects_overlong_symbol() {
        let too_long: &[u8] = b"123456789"; // 9 bytes > FSST_MAX_SYMBOL_LEN=8
        assert!(SymbolTable::from_symbols(&[too_long]).is_none());
    }

    #[test]
    fn decode_rejects_truncated_escape() {
        let table = SymbolTable::empty();
        // A lone escape byte with no literal following.
        let enc = [FSST_ESCAPE];
        let mut dst = [0u8; 8];
        assert_eq!(decode(&table, &enc, &mut dst), 0);
    }

    #[test]
    fn decode_rejects_unknown_id() {
        // Empty table — id 0 is out of range.
        let table = SymbolTable::empty();
        let enc = [0u8];
        let mut dst = [0u8; 8];
        assert_eq!(decode(&table, &enc, &mut dst), 0);
    }

    #[test]
    fn encode_returns_zero_on_undersized_dst() {
        let table = SymbolTable::empty();
        let mut tiny = [0u8; 1]; // need 2 bytes for one escape pair
        assert_eq!(encode(&table, b"x", &mut tiny), 0);
    }

    #[test]
    fn decode_returns_zero_on_undersized_dst() {
        let table = SymbolTable::from_symbols(&[b"foo"]).unwrap();
        let enc = [0u8]; // decodes to 3 bytes
        let mut tiny = [0u8; 2];
        assert_eq!(decode(&table, &enc, &mut tiny), 0);
    }

    #[test]
    fn longest_match_picks_correctly() {
        let table = SymbolTable::from_symbols(&[b"a", b"ab", b"abc"]).unwrap();
        assert_eq!(table.longest_match(b"abcd"), Some((2, 3)));
        assert_eq!(table.longest_match(b"ab"), Some((1, 2)));
        assert_eq!(table.longest_match(b"a"), Some((0, 1)));
        assert_eq!(table.longest_match(b"x"), None);
    }

    #[test]
    fn special_bytes_round_trip() {
        // 0x00, 0xFE, 0xFF (escape) all need to round-trip cleanly via
        // the escape mechanism even when they are *symbols* themselves.
        let bytes_table = SymbolTable::from_symbols(&[
            &[0x00u8] as &[u8],
            &[0xFEu8] as &[u8],
        ])
        .unwrap();
        // Direct match for 0x00 → id 0.
        // 0xFF (escape sentinel) is not a symbol, so it encodes via
        // the escape pair: [FSST_ESCAPE, 0xFF].
        let input = [0x00u8, 0xFEu8, 0xFFu8, 0xFEu8];
        roundtrip(&bytes_table, &input);
    }
}
