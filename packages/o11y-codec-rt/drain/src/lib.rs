//! o11y-codec-rt-drain — streaming log template extractor.
//!
//! In-house port of the Drain algorithm (He et al., "Drain: An Online
//! Log Parsing Approach with Fixed Depth Tree", ICWS 2017) following
//! the published Python reference's semantics. No FFI dependencies
//! and `no_std`-buildable for `wasm32-unknown-unknown`. The `extern "C"`
//! ABI lives in each consuming engine's binding crate.
//!
//! ## Algorithm reminder
//!
//! 1. Tokenize each line on whitespace.
//! 2. (Optional) replace tokens that look like numbers with `<*>` for
//!    tree-branching purposes.
//! 3. Group by token count at depth 1.
//! 4. Walk a fixed-depth tree (default `depth = 4` → max node depth = 2);
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

#![no_std]

extern crate alloc;

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use core::cmp::Ordering;

/// Sentinel string used both as the wildcard token in templates and as
/// the wildcard tree key. Matches the reference impl's `param_str`.
pub const PARAM_STR: &str = "<*>";

// ── Types ────────────────────────────────────────────────────────────

/// One template plus a usage count. We store templates as
/// `Vec<String>` to avoid the lifetime gymnastics of borrowed slices,
/// which keeps the binding crate's `extern "C"` ABI simpler at a small
/// RAM cost.
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
/// `PARAM_STR` for the wildcard branch). `cluster_ids` is non-empty
/// only at leaf nodes.
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

/// Drain configuration. Matches the reference impl's defaults out of
/// the box.
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
    /// Children of root keyed by token-count. Drain treats the
    /// root → length edge specially (the key is `len(tokens)`, not a
    /// token), so it lives separately from the per-prefix tree.
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

    /// Look up a cluster by index in `clusters()`. Useful for fast
    /// metadata reads after `add_line`.
    pub fn cluster(&self, idx: usize) -> Option<&Cluster> {
        self.clusters.get(idx)
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

    /// Tokenize a log line on ASCII whitespace. The reference impl
    /// calls `content.strip().split()` which splits on all whitespace
    /// and drops empty fields; Rust's `split_whitespace()` matches.
    fn tokenize(line: &str) -> Vec<&str> {
        line.split_whitespace().collect()
    }

    /// True if the token contains any ASCII digit. The reference impl
    /// uses `str.isdigit()` which on Python returns True for any
    /// Unicode digit; for log corpora ASCII is the realistic case and
    /// matches the reference impl within rounding error.
    fn has_numbers(token: &str) -> bool {
        token.bytes().any(|b| b.is_ascii_digit())
    }

    /// Compute (similarity, param_count). Mirrors `get_seq_distance`
    /// with `include_params = False`.
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
    /// candidate list for the best match above `sim_th`.
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

    /// Find the best match among `cluster_ids` for `tokens`. Tie-break
    /// on (max similarity, max param_count). Mirrors `fast_match`.
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
    /// `add_seq_to_prefix_tree`, including the slightly-finicky
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
    /// `<*>`. Mirrors `create_template`. Returns true if the template
    /// changed.
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
    /// (the host is responsible for any pre-masking; the reference
    /// impl installs no masking instructions by default).
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

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use alloc::vec;

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
    fn cluster_id_and_size_after_merge() {
        let mut d = Drain::new(Config::default());
        d.add_line("alpha beta gamma delta");
        d.add_line("alpha beta gamma epsilon");
        d.add_line("alpha beta gamma zeta");
        let cluster = d.cluster(0).unwrap();
        assert_eq!(cluster.id(), 1);
        assert_eq!(cluster.size(), 3);
    }

    #[test]
    fn matches_reference_impl_smoke() {
        // Three Apache-corpus-shaped lines that share template
        // "[notice] jk2_init() Found child <*> in scoreboard slot <*>".
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

    #[test]
    fn similarity_all_wildcards() {
        let template = vec!["<*>".into(), "<*>".into()];
        let line = vec!["x", "y"];
        let (sim, pc) = Drain::similarity(&template, &line);
        assert_eq!(sim, 0.0);
        assert_eq!(pc, 2);
    }

    #[test]
    fn ids_assigned_sequentially() {
        let mut d = Drain::new(Config::default());
        // Use distinct first tokens so each row creates a new cluster.
        let a = d.add_line("alpha 1 2 3");
        let b = d.add_line("beta 1 2 3");
        let c = d.add_line("gamma 1 2 3");
        assert_eq!(a, 1);
        assert_eq!(b, 2);
        assert_eq!(c, 3);
    }

    #[test]
    fn config_overrides_take_effect() {
        let cfg = Config {
            depth: 4,
            sim_th: 0.99,
            max_children: 100,
            parametrize_numeric_tokens: true,
        };
        // sim_th=0.99 means even one mismatched token forces a new cluster.
        let mut d = Drain::new(cfg);
        d.add_line("alpha beta gamma delta");
        d.add_line("alpha beta gamma epsilon");
        assert_eq!(d.cluster_count(), 2);
    }
}
