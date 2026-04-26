/**
 * Drain — streaming log template extractor (He et al., ICWS 2017),
 * TS reference implementation.
 *
 * Faithful port of `../rust-prototype/drain/src/lib.rs`, which is
 * itself a port of the published Python reference's semantics. The
 * Rust port cross-validates bit-identically against the Python
 * reference (ARI = 1.0 on five public log corpora). Keeping the TS
 * port byte-for-byte faithful to the Rust shape lets the two ports
 * serve as mutual oracles per the dual-implementation protocol.
 *
 * Algorithm:
 *   1. Tokenize each line on whitespace.
 *   2. Group by token count at depth 1 (root → length node).
 *   3. Walk a fixed-depth tree (default depth=4 → max node depth=2);
 *      each level keys on the i-th token. At a leaf there is a
 *      small list of templates.
 *   4. Compute similarity (matching positions / template length;
 *      wildcards count as non-matches in the numerator) with each
 *      candidate template. The best above `simTh` wins; merge by
 *      replacing mismatched positions in the template with `<*>`.
 *      Otherwise create a new template.
 *
 * Defaults match the published reference: depth=4, simTh=0.4,
 * maxChildren=100, parametrizeNumericTokens=true.
 */

import type { TemplateExtractor } from "./classify.js";

/** Wildcard token — matches the reference impl's `param_str = "<*>"`. */
export const PARAM_STR = "<*>";

export interface DrainConfig {
  depth: number;
  simTh: number;
  maxChildren: number;
  parametrizeNumericTokens: boolean;
}

export const DRAIN_DEFAULT_CONFIG: DrainConfig = {
  depth: 4,
  simTh: 0.4,
  maxChildren: 100,
  parametrizeNumericTokens: true,
};

interface DrainCluster {
  /** 1-based id assigned at first sight. */
  id: number;
  /** Mutable template tokens; wildcards are `PARAM_STR`. */
  template: string[];
  /** Hit count. */
  size: number;
}

interface DrainNode {
  /** Insertion-ordered to match the Rust impl's deterministic order. */
  children: Map<string, DrainNode>;
  /** Non-empty only at leaf nodes. */
  clusterIds: number[];
}

function makeNode(): DrainNode {
  return { children: new Map(), clusterIds: [] };
}

export class Drain implements TemplateExtractor {
  readonly config: DrainConfig;
  /** Root → length-node map (key = token count). */
  private readonly root: Map<number, DrainNode> = new Map();
  private readonly clusters: DrainCluster[] = [];
  private nextId: number = 0;

  constructor(config: DrainConfig = DRAIN_DEFAULT_CONFIG) {
    this.config = config;
  }

  templateCount(): number {
    return this.clusters.length;
  }

  *templates(): Iterable<{ id: number; template: string }> {
    for (const c of this.clusters) {
      yield { id: c.id, template: c.template.join(" ") };
    }
  }

  /**
   * Look up the template for a line without mutating state. Returns
   * undefined if no match above `simTh` exists.
   */
  matchTemplate(line: string): { templateId: number; vars: string[] } | undefined {
    const tokens = tokenize(line);
    const idx = this.treeSearch(tokens);
    if (idx === undefined) return undefined;
    const cluster = this.clusters[idx] as DrainCluster;
    return { templateId: cluster.id, vars: extractVars(cluster.template, tokens) };
  }

  /**
   * Match-or-add: same as `matchTemplate` but on a miss creates a
   * new cluster and on a hit merges the line's tokens into the
   * existing template (mismatched positions become wildcards).
   */
  matchOrAdd(line: string): { templateId: number; vars: string[]; isNew: boolean } {
    const tokens = tokenize(line);
    const idx = this.treeSearch(tokens);
    if (idx !== undefined) {
      const cluster = this.clusters[idx] as DrainCluster;
      mergeTemplate(cluster.template, tokens);
      cluster.size += 1;
      const vars = extractVars(cluster.template, tokens);
      return { templateId: cluster.id, vars, isNew: false };
    }
    this.nextId += 1;
    const id = this.nextId;
    const template = [...tokens];
    this.clusters.push({ id, template, size: 1 });
    this.addSeqToTree(id, template);
    // Newly inserted templates have no wildcards yet → no vars.
    return { templateId: id, vars: [], isNew: true };
  }

  /**
   * Reconstruct a line from a (template, vars) pair. Used by
   * `DrainChunkPolicy.postDecode`.
   */
  static reconstruct(template: string[], vars: readonly string[]): string {
    let varCursor = 0;
    const out: string[] = [];
    for (const t of template) {
      if (t === PARAM_STR) {
        out.push(vars[varCursor++] ?? "");
      } else {
        out.push(t);
      }
    }
    return out.join(" ");
  }

  // ── Internals ──────────────────────────────────────────────────────

  /** Walk the tree to a leaf and `fastMatch` against its candidates. */
  private treeSearch(tokens: readonly string[]): number | undefined {
    const tokenCount = tokens.length;
    const lengthNode = this.root.get(tokenCount);
    if (!lengthNode) return undefined;

    if (tokenCount === 0) {
      const cid = lengthNode.clusterIds[0];
      return cid !== undefined ? this.clusterIndex(cid) : undefined;
    }

    const maxNodeDepth = Math.max(0, this.config.depth - 2);
    let node: DrainNode = lengthNode;
    let depth = 1;
    for (const token of tokens) {
      if (depth >= maxNodeDepth) break;
      if (depth === tokenCount) break;
      const next = node.children.get(token) ?? node.children.get(PARAM_STR);
      if (!next) return undefined;
      node = next;
      depth += 1;
    }
    return this.fastMatch(node.clusterIds, tokens);
  }

  /**
   * Find the best match among `clusterIds` for `tokens`. Tie-breaks
   * on (max similarity, max param_count). Mirrors the reference impl `fast_match`.
   */
  private fastMatch(clusterIds: readonly number[], tokens: readonly string[]): number | undefined {
    let maxSim = -1;
    let maxPc = -1;
    let best: number | undefined;
    for (const cid of clusterIds) {
      const idx = this.clusterIndex(cid);
      if (idx === undefined) continue;
      const cluster = this.clusters[idx] as DrainCluster;
      if (cluster.template.length !== tokens.length) continue;
      const [sim, pc] = similarity(cluster.template, tokens);
      let better = false;
      if (sim > maxSim) better = true;
      else if (sim === maxSim && pc > maxPc) better = true;
      if (better) {
        maxSim = sim;
        maxPc = pc;
        best = idx;
      }
    }
    return maxSim >= this.config.simTh ? best : undefined;
  }

  private clusterIndex(id: number): number | undefined {
    // Cluster IDs are sequential from 1 with no eviction — id - 1
    // should be the index. Defensive lookup if the invariant breaks.
    const guess = id - 1;
    if (guess >= 0 && guess < this.clusters.length && this.clusters[guess]?.id === id) {
      return guess;
    }
    for (let i = 0; i < this.clusters.length; i++) {
      if (this.clusters[i]?.id === id) return i;
    }
    return undefined;
  }

  /**
   * Insert a freshly-created cluster into the prefix tree. Mirrors
   * the reference impl `add_seq_to_prefix_tree`, including the slightly-finicky
   * `max_children` bookkeeping.
   */
  private addSeqToTree(clusterId: number, template: readonly string[]): void {
    const tokenCount = template.length;
    const maxNodeDepth = Math.max(0, this.config.depth - 2);
    const maxChildren = this.config.maxChildren;
    const parametrizeNumeric = this.config.parametrizeNumericTokens;

    let lengthNode = this.root.get(tokenCount);
    if (!lengthNode) {
      lengthNode = makeNode();
      this.root.set(tokenCount, lengthNode);
    }

    if (tokenCount === 0) {
      lengthNode.clusterIds = [clusterId];
      return;
    }

    let cur = lengthNode;
    let currentDepth = 1;
    for (const token of template) {
      if (currentDepth >= maxNodeDepth || currentDepth >= tokenCount) {
        cur.clusterIds.push(clusterId);
        break;
      }

      if (cur.children.has(token)) {
        cur = cur.children.get(token) as DrainNode;
      } else if (parametrizeNumeric && hasNumbers(token)) {
        if (cur.children.has(PARAM_STR)) {
          cur = cur.children.get(PARAM_STR) as DrainNode;
        } else {
          const fresh = makeNode();
          cur.children.set(PARAM_STR, fresh);
          cur = fresh;
        }
      } else if (cur.children.has(PARAM_STR)) {
        if (cur.children.size < maxChildren) {
          const fresh = makeNode();
          cur.children.set(token, fresh);
          cur = fresh;
        } else {
          cur = cur.children.get(PARAM_STR) as DrainNode;
        }
      } else if (cur.children.size + 1 < maxChildren) {
        const fresh = makeNode();
        cur.children.set(token, fresh);
        cur = fresh;
      } else if (cur.children.size + 1 === maxChildren) {
        const fresh = makeNode();
        cur.children.set(PARAM_STR, fresh);
        cur = fresh;
      } else {
        cur = cur.children.get(PARAM_STR) as DrainNode;
      }

      currentDepth += 1;
    }
  }
}

// ── Helpers (module-private but exported for tests / cross-validation)

/** Whitespace tokenizer — matches `str.split_whitespace()`. */
export function tokenize(line: string): string[] {
  // Manual whitespace tokenizer — Experiment X CPU profile (2026-04-26)
  // showed line.split(/\s+/).filter(...) at ~1.5 % of total ingest CPU
  // because regex-engine setup + an extra filter pass costs more than
  // a hand-rolled scan for short log lines. This produces identical
  // output to the regex form for ASCII whitespace, which is what
  // typical log corpora and OTLP bodies contain in practice.
  const out: string[] = [];
  const len = line.length;
  let start = -1;
  for (let i = 0; i < len; i++) {
    const c = line.charCodeAt(i);
    // Match \s: tab(9), LF(10), VT(11), FF(12), CR(13), space(32), nbsp(160).
    const isWs = c === 32 || (c >= 9 && c <= 13) || c === 160;
    if (isWs) {
      if (start >= 0) {
        out.push(line.substring(start, i));
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0) out.push(line.substring(start, len));
  return out;
}

/** True if any byte is an ASCII digit. */
function hasNumbers(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) return true;
  }
  return false;
}

/**
 * Similarity = matching positions / template length (wildcards count
 * as non-matches in the numerator). Returns `(sim, paramCount)`.
 * Caller guarantees length equality.
 */
export function similarity(
  template: readonly string[],
  tokens: readonly string[]
): [number, number] {
  if (template.length === 0) return [1, 0];
  let simTokens = 0;
  let paramCount = 0;
  for (let i = 0; i < template.length; i++) {
    const t1 = template[i];
    const t2 = tokens[i];
    if (t1 === PARAM_STR) {
      paramCount += 1;
      continue;
    }
    if (t1 === t2) simTokens += 1;
  }
  return [simTokens / template.length, paramCount];
}

/** Mismatched positions become wildcards. Mutates `template` in place. */
export function mergeTemplate(template: string[], tokens: readonly string[]): boolean {
  let changed = false;
  for (let i = 0; i < template.length; i++) {
    const slot = template[i];
    const tok = tokens[i];
    if (slot !== tok && slot !== PARAM_STR) {
      template[i] = PARAM_STR;
      changed = true;
    }
  }
  return changed;
}

/** Extract variable values at wildcard positions. */
function extractVars(template: readonly string[], tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === PARAM_STR) out.push(tokens[i] ?? "");
  }
  return out;
}
