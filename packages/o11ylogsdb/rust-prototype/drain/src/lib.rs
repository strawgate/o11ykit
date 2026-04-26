//! o11y-drain — streaming log template extractor.
//!
//! In-house port of the Drain algorithm (He et al., "Drain: An Online
//! Log Parsing Approach with Fixed Depth Tree", ICWS 2017) following
//! the published reference's semantics. Designed to build
//! cleanly for `wasm32-unknown-unknown` with the size profile in
//! `Cargo.toml`. No std, no FFI dependencies (existing Rust ports of
//! the algorithm pull in a C regex library that doesn't build for
//! wasm32 without a sysroot).
//!
//! ## Algorithm reminder
//!
//! 1. Tokenize each line on whitespace.
//! 2. (Optional) replace tokens that look like numbers with `<*>` for
//!    tree-branching purposes.
//! 3. Group by token count at depth 1.
//! 4. Walk a fixed-depth tree (default depth=4 → max node depth=2);
//!    each level keys on the i-th token. At a leaf there is a small
//!    list of templates.
//! 5. Compute similarity (fraction of matching positions, ignoring
//!    wildcards in the template) with each leaf template. The best
//!    above `sim_th` wins; merge by replacing mismatched positions in
//!    the template with `<*>`. Otherwise create a new template.
//!
//! ## Default config
//!
//! `depth = 4`, `sim_th = 0.4`, `max_children = 100`,
//! `parametrize_numeric_tokens = true`. These match the published
//! reference defaults so cross-validation holds.
//!
//! ## ABI
//!
//! Exposes a minimal `extern "C"` ABI sufficient to drive the parser
//! from a JS/Wasm host: `drain_create`, `drain_ingest_line`,
//! `drain_template_count`, `drain_get_template`, `drain_destroy`.
//! The host owns line bytes and template-output buffers; the crate
//! never returns pointers to its internal storage.

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use core::cmp::Ordering;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── Minimal bump allocator (wasm32 only) ─────────────────────────────
//
// We use Vec/String/Box, so we need a global allocator. To keep the
// dependency surface zero (matching o11ytsdb's bare-metal approach),
// we ship a leak-only bump allocator backed by a 16 MB static arena.
// Drain state for one chunk-of-logs is small (a few hundred clusters,
// ~1 KB each); the host is expected to drain_destroy and re-create
// the parser per chunk. If that becomes cramping we can swap in a
// real allocator without touching the public ABI.
#[cfg(target_arch = "wasm32")]
mod bump_alloc {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::sync::atomic::{AtomicUsize, Ordering};

    const ARENA_SIZE: usize = 16 * 1024 * 1024;

    #[repr(align(16))]
    struct Arena(UnsafeCell<[u8; ARENA_SIZE]>);
    unsafe impl Sync for Arena {}

    static ARENA: Arena = Arena(UnsafeCell::new([0u8; ARENA_SIZE]));
    static OFFSET: AtomicUsize = AtomicUsize::new(0);

    pub struct Bump;

    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let align = layout.align();
            let size = layout.size();
            let base = ARENA.0.get() as *mut u8 as usize;
            loop {
                let off = OFFSET.load(Ordering::Relaxed);
                let aligned = (base + off + (align - 1)) & !(align - 1);
                let new_off = (aligned - base).saturating_add(size);
                if new_off > ARENA_SIZE {
                    return core::ptr::null_mut();
                }
                if OFFSET
                    .compare_exchange(off, new_off, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
                {
                    return aligned as *mut u8;
                }
            }
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {
            // Bump-leak: free is a no-op. Host re-creates the parser
            // per chunk; the arena is reset by reloading the module.
        }
    }

    #[global_allocator]
    static GLOBAL: Bump = Bump;
}

// ── Types ────────────────────────────────────────────────────────────

/// Sentinel string used both as the wildcard token in templates and as
/// the wildcard tree key. Matches the published reference's `param_str` default.
const PARAM_STR: &str = "<*>";

/// One template plus a usage count. We store templates as
/// `Vec<String>` to avoid the lifetime gymnastics of borrowed slices,
/// which keeps the `extern "C"` ABI simpler at a small RAM cost.
#[derive(Debug, Clone)]
pub struct Cluster {
    template: Vec<String>,
    id: u32,
    size: u32,
}

impl Cluster {
    fn new(tokens: &[&str], id: u32) -> Self {
        Self {
            template: tokens.iter().map(|s| (*s).into()).collect(),
            id,
            size: 1,
        }
    }
    pub fn id(&self) -> u32 {
        self.id
    }
    pub fn size(&self) -> u32 {
        self.size
    }
    pub fn template_tokens(&self) -> &[String] {
        &self.template
    }
}

/// One internal tree node. Children are keyed by token (or by
/// `PARAM_STR` for the wildcard branch). `cluster_ids` is non-empty only
/// at leaf nodes.
#[derive(Debug, Default)]
struct Node {
    children: Vec<(String, Box<Node>)>,
    cluster_ids: Vec<u32>,
}

impl Node {
    fn child(&self, key: &str) -> Option<&Node> {
        self.children
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, n)| n.as_ref())
    }
    fn child_mut(&mut self, key: &str) -> Option<&mut Node> {
        self.children
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, n)| n.as_mut())
    }
    fn has_child(&self, key: &str) -> bool {
        self.children.iter().any(|(k, _)| k == key)
    }
    fn insert_child(&mut self, key: String) -> &mut Node {
        self.children.push((key, Box::new(Node::default())));
        self.children.last_mut().unwrap().1.as_mut()
    }
    fn child_count(&self) -> usize {
        self.children.len()
    }
}

/// Drain configuration. Matches the published reference's defaults out of the box.
#[derive(Debug, Clone)]
pub struct Config {
    pub depth: u32,
    pub sim_th: f32,
    pub max_children: u32,
    pub parametrize_numeric_tokens: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            depth: 4,
            sim_th: 0.4,
            max_children: 100,
            parametrize_numeric_tokens: true,
        }
    }
}

/// Streaming Drain parser. Owns the prefix tree and all clusters.
pub struct Drain {
    cfg: Config,
    /// Children of root keyed by token-count string. We separate this
    /// from the per-prefix tree because Drain treats the root → length
    /// edge specially (the key is `len(tokens)`, not a token).
    root: Vec<(u32, Box<Node>)>,
    clusters: Vec<Cluster>,
    next_id: u32,
}

impl Drain {
    pub fn new(cfg: Config) -> Self {
        Self {
            cfg,
            root: Vec::new(),
            clusters: Vec::new(),
            next_id: 0,
        }
    }

    pub fn cluster_count(&self) -> usize {
        self.clusters.len()
    }

    pub fn clusters(&self) -> &[Cluster] {
        &self.clusters
    }

    fn root_child(&self, n: u32) -> Option<&Node> {
        self.root.iter().find(|(k, _)| *k == n).map(|(_, n)| n.as_ref())
    }
    fn root_child_mut(&mut self, n: u32) -> Option<&mut Node> {
        self.root
            .iter_mut()
            .find(|(k, _)| *k == n)
            .map(|(_, n)| n.as_mut())
    }
    fn root_insert(&mut self, n: u32) -> &mut Node {
        self.root.push((n, Box::new(Node::default())));
        self.root.last_mut().unwrap().1.as_mut()
    }

    /// Tokenize a log line on ASCII whitespace. The reference impl calls
    /// `content.strip().split()` which splits on all whitespace and
    /// drops empty fields. Rust's `split_whitespace()` matches.
    fn tokenize(line: &str) -> Vec<&str> {
        line.split_whitespace().collect()
    }

    /// True if the token contains any ASCII digit. The reference impl uses
    /// `str.isdigit()` over each char which on Python returns True
    /// for any Unicode digit; for log corpora ASCII is the realistic
    /// case and matche. The reference impl within rounding error.
    fn has_numbers(token: &str) -> bool {
        token.bytes().any(|b| b.is_ascii_digit())
    }

    /// Compute (similarity, param_count). Mirrors
    /// `Drain.get_seq_distance` with `include_params=False`.
    fn similarity(template: &[String], line: &[&str]) -> (f32, u32) {
        debug_assert_eq!(template.len(), line.len());
        if template.is_empty() {
            return (1.0, 0);
        }
        let mut sim_tokens: u32 = 0;
        let mut param_count: u32 = 0;
        for (t1, t2) in template.iter().zip(line.iter()) {
            if t1 == PARAM_STR {
                param_count += 1;
                continue;
            }
            if t1 == *t2 {
                sim_tokens += 1;
            }
        }
        (sim_tokens as f32 / template.len() as f32, param_count)
    }

    /// Walk the tree to find the candidate leaf, then linear-scan the
    /// candidate list for the best match above `sim_th`. Returns the
    /// matched cluster index in `self.clusters`, if any.
    fn tree_search(&self, tokens: &[&str]) -> Option<usize> {
        let token_count = tokens.len() as u32;
        let cur = self.root_child(token_count)?;

        // Empty log: the single cluster lives at the length node.
        if token_count == 0 {
            return cur
                .cluster_ids
                .first()
                .and_then(|cid| self.cluster_index(*cid));
        }

        let max_node_depth = self.cfg.depth.saturating_sub(2);
        let mut node = cur;
        let mut depth = 1u32;
        for token in tokens {
            if depth >= max_node_depth {
                break;
            }
            if depth == token_count {
                break;
            }
            let next = node.child(token).or_else(|| node.child(PARAM_STR))?;
            node = next;
            depth += 1;
        }

        self.fast_match(&node.cluster_ids, tokens)
    }

    /// Find the best match among `cluster_ids` for `tokens`. Returns
    /// the cluster index on tie-break: max similarity, then max
    /// param_count. Mirror. The reference impl `fast_match`.
    fn fast_match(&self, cluster_ids: &[u32], tokens: &[&str]) -> Option<usize> {
        let mut max_sim: f32 = -1.0;
        let mut max_pc: i64 = -1;
        let mut best: Option<usize> = None;
        for cid in cluster_ids {
            let idx = match self.cluster_index(*cid) {
                Some(i) => i,
                None => continue,
            };
            let cluster = &self.clusters[idx];
            if cluster.template.len() != tokens.len() {
                continue;
            }
            let (sim, pc) = Self::similarity(&cluster.template, tokens);
            let pc_i = pc as i64;
            let better = match sim.partial_cmp(&max_sim).unwrap_or(Ordering::Equal) {
                Ordering::Greater => true,
                Ordering::Equal => pc_i > max_pc,
                Ordering::Less => false,
            };
            if better {
                max_sim = sim;
                max_pc = pc_i;
                best = Some(idx);
            }
        }
        if max_sim >= self.cfg.sim_th {
            best
        } else {
            None
        }
    }

    fn cluster_index(&self, id: u32) -> Option<usize> {
        // Cluster IDs are assigned sequentially starting at 1; no
        // eviction in this port, so id == index + 1 in practice. Be
        // defensive and search if the invariant ever breaks.
        let guess = id as usize;
        if guess > 0 && guess <= self.clusters.len() && self.clusters[guess - 1].id == id {
            return Some(guess - 1);
        }
        self.clusters.iter().position(|c| c.id == id)
    }

    /// Insert a freshly-created cluster into the prefix tree. Mirrors
    //. The reference impl `add_seq_to_prefix_tree`, including the slightly-finicky
    /// `max_children` bookkeeping.
    fn add_seq_to_tree(&mut self, cluster_id: u32, template: &[String]) {
        let token_count = template.len() as u32;
        let max_node_depth = self.cfg.depth.saturating_sub(2);
        let max_children = self.cfg.max_children as usize;
        let parametrize_numeric = self.cfg.parametrize_numeric_tokens;

        // Root → length node.
        let length_node: &mut Node = if self.root_child(token_count).is_some() {
            self.root_child_mut(token_count).unwrap()
        } else {
            self.root_insert(token_count)
        };

        if token_count == 0 {
            length_node.cluster_ids = alloc::vec![cluster_id];
            return;
        }

        let mut cur = length_node;
        let mut current_depth = 1u32;
        for token in template {
            if current_depth >= max_node_depth || current_depth >= token_count {
                cur.cluster_ids.push(cluster_id);
                break;
            }

            let token_str: &str = token.as_str();
            if !cur.has_child(token_str) {
                if parametrize_numeric && Self::has_numbers(token_str) {
                    if !cur.has_child(PARAM_STR) {
                        cur = cur.insert_child(PARAM_STR.into());
                    } else {
                        cur = cur.child_mut(PARAM_STR).unwrap();
                    }
                } else if cur.has_child(PARAM_STR) {
                    if cur.child_count() < max_children {
                        cur = cur.insert_child(token_str.into());
                    } else {
                        cur = cur.child_mut(PARAM_STR).unwrap();
                    }
                } else if cur.child_count() + 1 < max_children {
                    cur = cur.insert_child(token_str.into());
                } else if cur.child_count() + 1 == max_children {
                    cur = cur.insert_child(PARAM_STR.into());
                } else {
                    cur = cur.child_mut(PARAM_STR).unwrap();
                }
            } else {
                cur = cur.child_mut(token_str).unwrap();
            }

            current_depth += 1;
        }
    }

    /// Merge `tokens` into `template`: positions that disagree become
    /// `<*>`. Mirror. The reference impl `create_template`. Returns true if the
    /// template changed.
    fn merge_template(template: &mut [String], tokens: &[&str]) -> bool {
        debug_assert_eq!(template.len(), tokens.len());
        let mut changed = false;
        for (slot, t2) in template.iter_mut().zip(tokens.iter()) {
            if slot.as_str() != *t2 && slot.as_str() != PARAM_STR {
                *slot = PARAM_STR.into();
                changed = true;
            }
        }
        changed
    }

    /// Ingest one log line. Returns the cluster ID assigned to this
    /// line. Mirrors `TemplateMiner.add_log_message` minus the masker
    /// (the host is responsible for any pre-masking; the reference impl
    /// installs no masking instructions by default).
    pub fn add_line(&mut self, line: &str) -> u32 {
        let tokens = Self::tokenize(line);
        match self.tree_search(&tokens) {
            Some(idx) => {
                let cluster = &mut self.clusters[idx];
                Self::merge_template(&mut cluster.template, &tokens);
                cluster.size += 1;
                cluster.id
            }
            None => {
                self.next_id += 1;
                let id = self.next_id;
                let cluster = Cluster::new(&tokens, id);
                let template = cluster.template.clone();
                self.clusters.push(cluster);
                self.add_seq_to_tree(id, &template);
                id
            }
        }
    }

    /// Return the template string for the cluster at `idx` joined with
    /// single spaces. Allocates.
    pub fn template_string(&self, idx: usize) -> Option<String> {
        let cluster = self.clusters.get(idx)?;
        Some(cluster.template.join(" "))
    }
}

// ── extern "C" ABI ───────────────────────────────────────────────────
//
// Pointers handed out by these functions belong to the host once
// returned. Constructing/destroying the parser uses Box::into_raw /
// Box::from_raw, the same pattern o11ytsdb uses for its own engines.

/// Construct a parser with default config. Returns an opaque pointer
/// the host must pass to all other entry points and finally release
/// with `drain_destroy`.
#[no_mangle]
pub extern "C" fn drain_create() -> *mut Drain {
    Box::into_raw(Box::new(Drain::new(Config::default())))
}

/// Construct a parser with custom config. `sim_th` is in basis points
/// (e.g. 4000 = 0.4) so the ABI stays integer-only.
#[no_mangle]
pub extern "C" fn drain_create_with(
    depth: u32,
    sim_th_bp: u32,
    max_children: u32,
    parametrize_numeric: u32,
) -> *mut Drain {
    let cfg = Config {
        depth: depth.max(3),
        sim_th: (sim_th_bp as f32) / 10_000.0,
        max_children: max_children.max(2),
        parametrize_numeric_tokens: parametrize_numeric != 0,
    };
    Box::into_raw(Box::new(Drain::new(cfg)))
}

/// Ingest one log line. `ptr` points to UTF-8 bytes of length `len`
/// in WASM linear memory; the parser copies what it needs. Returns
/// the cluster ID, or 0 on error (null parser, invalid UTF-8).
///
/// # Safety
/// Caller guarantees `parser` was returned by `drain_create*` and not
/// yet destroyed, and that `ptr..ptr+len` is a valid byte range.
#[no_mangle]
pub unsafe extern "C" fn drain_ingest_line(parser: *mut Drain, ptr: *const u8, len: u32) -> u32 {
    if parser.is_null() || (len > 0 && ptr.is_null()) {
        return 0;
    }
    let bytes = core::slice::from_raw_parts(ptr, len as usize);
    let line = match core::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    (&mut *parser).add_line(line)
}

/// Number of templates currently held by the parser.
///
/// # Safety
/// Caller guarantees `parser` was returned by `drain_create*` and not
/// yet destroyed.
#[no_mangle]
pub unsafe extern "C" fn drain_template_count(parser: *const Drain) -> u32 {
    if parser.is_null() {
        return 0;
    }
    (&*parser).cluster_count() as u32
}

/// Copy the joined template string at `idx` into `out_ptr..out_ptr+cap`
/// and return the number of bytes written, or 0 if `idx` is out of
/// range or `cap` is too small.
///
/// # Safety
/// Caller guarantees the output range is writeable.
#[no_mangle]
pub unsafe extern "C" fn drain_get_template(
    parser: *const Drain,
    idx: u32,
    out_ptr: *mut u8,
    cap: u32,
) -> u32 {
    if parser.is_null() || out_ptr.is_null() {
        return 0;
    }
    let drain = &*parser;
    let s = match drain.template_string(idx as usize) {
        Some(s) => s,
        None => return 0,
    };
    let bytes = s.as_bytes();
    if bytes.len() > cap as usize {
        return 0;
    }
    core::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, bytes.len());
    bytes.len() as u32
}

/// Cluster ID and size for the template at `idx`. Packed into a single
/// u64: high 32 bits = cluster_id, low 32 bits = size.
///
/// # Safety
/// Caller guarantees `parser` was returned by `drain_create*` and not
/// yet destroyed.
#[no_mangle]
pub unsafe extern "C" fn drain_get_template_meta(parser: *const Drain, idx: u32) -> u64 {
    if parser.is_null() {
        return 0;
    }
    let drain = &*parser;
    match drain.clusters().get(idx as usize) {
        Some(c) => ((c.id as u64) << 32) | c.size as u64,
        None => 0,
    }
}

/// Drop the parser. After this call the pointer is invalid.
///
/// # Safety
/// Caller guarantees `parser` was returned by `drain_create*` and not
/// yet destroyed.
#[no_mangle]
pub unsafe extern "C" fn drain_destroy(parser: *mut Drain) {
    if !parser.is_null() {
        drop(Box::from_raw(parser));
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;
    use std::vec;

    #[test]
    fn empty_input_is_one_cluster() {
        let mut d = Drain::new(Config::default());
        let id1 = d.add_line("");
        let id2 = d.add_line("   ");
        assert_eq!(id1, id2);
        assert_eq!(d.cluster_count(), 1);
    }

    #[test]
    fn identical_lines_share_cluster() {
        let mut d = Drain::new(Config::default());
        let a = d.add_line("connection refused for host alpha");
        let b = d.add_line("connection refused for host alpha");
        assert_eq!(a, b);
        assert_eq!(d.cluster_count(), 1);
    }

    #[test]
    fn similar_lines_merge_with_wildcard() {
        let mut d = Drain::new(Config::default());
        d.add_line("connection refused for host alpha");
        d.add_line("connection refused for host beta");
        d.add_line("connection refused for host gamma");
        assert_eq!(d.cluster_count(), 1);
        let tmpl = d.template_string(0).unwrap();
        assert_eq!(tmpl, "connection refused for host <*>");
    }

    #[test]
    fn different_token_counts_split_clusters() {
        let mut d = Drain::new(Config::default());
        d.add_line("packet dropped on eth0");
        d.add_line("packet dropped on interface eth0 by firewall");
        assert_eq!(d.cluster_count(), 2);
    }

    #[test]
    fn numeric_token_branches_through_wildcard() {
        let mut d = Drain::new(Config::default());
        // First three tokens are identical; the 4th is numeric so the
        // tree branches under <*>. With depth=4, max_node_depth=2, the
        // first two non-length tokens decide the leaf; both are
        // identical, so we expect a single cluster after merge.
        d.add_line("user 17 logged in from 10.0.0.1");
        d.add_line("user 42 logged in from 10.0.0.2");
        assert_eq!(d.cluster_count(), 1);
        let tmpl = d.template_string(0).unwrap();
        assert!(tmpl.contains("<*>"));
    }

    #[test]
    fn template_count_meta_packs_id_and_size() {
        let mut d = Drain::new(Config::default());
        d.add_line("alpha beta gamma delta");
        d.add_line("alpha beta gamma epsilon");
        d.add_line("alpha beta gamma zeta");
        let meta = unsafe { drain_get_template_meta(&d as *const _, 0) };
        let id = (meta >> 32) as u32;
        let size = (meta & 0xffff_ffff) as u32;
        assert_eq!(id, 1);
        assert_eq!(size, 3);
    }

    #[test]
    fn ffi_lifecycle_round_trips() {
        unsafe {
            let p = drain_create();
            let line = b"alpha beta gamma";
            let id = drain_ingest_line(p, line.as_ptr(), line.len() as u32);
            assert_eq!(id, 1);
            assert_eq!(drain_template_count(p), 1);
            let mut buf = [0u8; 64];
            let n = drain_get_template(p, 0, buf.as_mut_ptr(), buf.len() as u32);
            assert_eq!(&buf[..n as usize], b"alpha beta gamma");
            drain_destroy(p);
        }
    }

    #[test]
    fn matches_drain3_apache_smoke() {
        // Three Loghub-Apache-shaped lines that share template
        // "[Sun Dec 04 ...] [notice] jk2_init() Found child <*> in scoreboard slot <*>"
        // After tokenizing we just check the trailing portion.
        let mut d = Drain::new(Config::default());
        d.add_line("[notice] jk2_init() Found child 6725 in scoreboard slot 7");
        d.add_line("[notice] jk2_init() Found child 6726 in scoreboard slot 8");
        d.add_line("[notice] jk2_init() Found child 6728 in scoreboard slot 9");
        assert_eq!(d.cluster_count(), 1);
        let tmpl = d.template_string(0).unwrap();
        assert!(tmpl.contains("Found child <*>"));
        assert!(tmpl.contains("scoreboard slot <*>"));
    }

    #[test]
    fn distinct_prefixes_split() {
        let mut d = Drain::new(Config::default());
        d.add_line("INFO worker started");
        d.add_line("INFO worker stopped");
        d.add_line("ERROR disk full");
        d.add_line("ERROR disk degraded");
        // 4 templates, 4 token count: under depth=4 and matching prefix
        // tokens, INFO/ERROR + worker/disk decide the leaf.
        assert!(d.cluster_count() >= 2);
    }

    #[test]
    fn similarity_basic() {
        let template = vec![
            "alpha".into(),
            "<*>".into(),
            "gamma".into(),
            "delta".into(),
        ];
        let line = vec!["alpha", "beta", "gamma", "delta"];
        let (sim, pc) = Drain::similarity(&template, &line);
        // 3 of 4 non-wildcard slots match; ratio = 3/4.
        assert!((sim - 0.75).abs() < 1e-6);
        assert_eq!(pc, 1);
    }
}
