/**
 * ngram-bloom.
 *
 * Validates the PLAN.md M6 stance that "per-chunk binary fuse filtering
 * covers 95 % of substring search needs at a fraction of the cost"
 * by *measuring* the alternative: a Loki-Bloom-Compactor-style n-gram
 * filter per chunk. PLAN.md plans BF8 over template IDs and BF16 over
 * trace IDs, but explicitly rejects an n-gram body filter as too
 * expensive. This bench measures the cost (bytes/log) and the recall
 * + false-positive rate on realistic substring queries, so M6 has
 * data instead of a hunch.
 *
 * For each Loghub-2k corpus (treated as one 2K-row chunk) and each
 * filter configuration:
 *   - filter storage size in bytes
 *   - bytes-per-log overhead the filter adds to chunk total
 *   - recall on positive queries (literals drawn from real lines)
 *   - false-positive rate on negative queries (random ASCII never
 *     appearing in any line)
 *
 * Configurations:
 *   1. bloom_n3_1pct  — classic Bloom over trigrams, ~10 bits/key, k=7,
 *      target FPR 1 %.
 *   2. bloom_n4_1pct  — same, quadgrams.
 *   3. binary_fuse_n3 — Binary Fuse 8 (Lemire 2022) over the trigram
 *      set. Smaller per Lemire (~9 bits/key); immutable.
 *   4. token_filter   — Loki-style: split each line on non-alphanumeric,
 *      bloom over distinct words. Smaller (fewer items) but only
 *      catches whole-word substring queries.
 *
 * Implementation notes: Bloom + Binary Fuse 8 are written from scratch
 * in TS (no dependency footprint added to the bench). Both use
 * splitmix64 over `Math.imul`-style 32-bit halves to avoid BigInt in
 * the hot path. Binary Fuse construction follows the algorithm in
 * Graf & Lemire 2022 ("Binary Fuse Filters: Fast and Smaller Than
 * Xor Filters").
 *
 * Reusable filters are also exported from `src/index-bloom.ts` so the
 * eventual M6 implementation has a head start if the experiment shows
 * the cost is acceptable.
 */

import { loadAllAvailable } from "./corpora.js";
import { buildReport, type CompressionResult, nowMillis, ratio as ratioFn } from "./harness.js";
import {
  BinaryFuse8,
  Bloom,
  buildNGramSet,
  buildTokenSet,
  containsNGram,
  containsToken,
} from "./index-bloom-impl.js";

// ---------- query generation ----------

/** Deterministic Mulberry32 PRNG so the bench is reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick `n` positive substring queries from real lines.
 * Length uniformly in [4, 20].
 */
function positiveQueries(lines: string[], n: number, rng: () => number): string[] {
  const out: string[] = [];
  const longEnough = lines.filter((l) => l.length >= 20);
  const pool = longEnough.length > 0 ? longEnough : lines;
  if (pool.length === 0) return out;
  let attempts = 0;
  while (out.length < n && attempts < n * 10) {
    attempts++;
    const line = pool[Math.floor(rng() * pool.length)] as string;
    const len = 4 + Math.floor(rng() * 17); // 4..20
    if (line.length < len) continue;
    const start = Math.floor(rng() * (line.length - len + 1));
    const sub = line.slice(start, start + len);
    if (sub.length === len) out.push(sub);
  }
  return out;
}

/**
 * Generate `n` random ASCII strings of length 4..20 that DO NOT appear
 * in any line. Verified by linear scan (slow but correct, fine at 2K).
 */
function negativeQueries(corpusBlob: string, n: number, rng: () => number): string[] {
  const out: string[] = [];
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let attempts = 0;
  while (out.length < n && attempts < n * 50) {
    attempts++;
    const len = 4 + Math.floor(rng() * 17);
    let s = "";
    for (let i = 0; i < len; i++) {
      s += alphabet[Math.floor(rng() * alphabet.length)];
    }
    if (corpusBlob.indexOf(s) === -1) out.push(s);
  }
  return out;
}

// ---------- recall / FPR measurement ----------

interface FilterResult {
  /** Bytes used by the filter's storage (just the bit/byte array). */
  filterBytes: number;
  /** Distinct keys inserted (n-grams or tokens). */
  keyCount: number;
  /** Build time in ms. */
  buildMillis: number;
  /** True positives / |positives|. Should be 1.0. */
  recall: number;
  /** False positives / |negatives|. */
  fpr: number;
}

/**
 * Test a contains-fn over query sets. `genGrams` yields the n-grams
 * (or tokens) that the query reduces to under the filter's grammar.
 * A positive-substring query "hits" iff every gram it produces is in
 * the filter — that's the AND-of-grams predicate Loki uses.
 */
function evaluate(
  positives: string[],
  negatives: string[],
  contains: (q: string) => boolean
): { recall: number; fpr: number } {
  let pHit = 0;
  for (const q of positives) {
    if (contains(q)) pHit++;
  }
  let nHit = 0;
  for (const q of negatives) {
    if (contains(q)) nHit++;
  }
  return {
    recall: positives.length === 0 ? 1 : pHit / positives.length,
    fpr: negatives.length === 0 ? 0 : nHit / negatives.length,
  };
}

// ---------- per-config builders ----------

function buildBloomNGram(
  lines: string[],
  n: number,
  bitsPerKey: number
): { bloom: Bloom; keyCount: number; buildMs: number } {
  const t0 = nowMillis();
  const grams = buildNGramSet(lines, n);
  const k = Math.max(1, Math.round(bitsPerKey * Math.LN2));
  const bloom = new Bloom(grams.size, bitsPerKey, k);
  for (const g of grams) bloom.addStr(g);
  return { bloom, keyCount: grams.size, buildMs: nowMillis() - t0 };
}

function buildFuseNGram(
  lines: string[],
  n: number
): { fuse: BinaryFuse8; keyCount: number; buildMs: number } {
  const t0 = nowMillis();
  const grams = buildNGramSet(lines, n);
  const keys = new BigUint64Array(grams.size);
  let i = 0;
  for (const g of grams) {
    keys[i++] = BinaryFuse8.hashKeyStr(g);
  }
  const fuse = BinaryFuse8.build(keys);
  return { fuse, keyCount: grams.size, buildMs: nowMillis() - t0 };
}

function buildBloomTokens(
  lines: string[],
  bitsPerKey: number
): { bloom: Bloom; keyCount: number; buildMs: number } {
  const t0 = nowMillis();
  const tokens = buildTokenSet(lines);
  const k = Math.max(1, Math.round(bitsPerKey * Math.LN2));
  const bloom = new Bloom(tokens.size, bitsPerKey, k);
  for (const t of tokens) bloom.addStr(t);
  return { bloom, keyCount: tokens.size, buildMs: nowMillis() - t0 };
}

// ---------- bench main ----------

interface ConfigRow extends FilterResult {
  corpus: string;
  config: string;
  /** Bytes-per-log added to a chunk total by adopting this filter. */
  bytesPerLog: number;
  /** Logs in chunk. */
  logCount: number;
  /** Bits per key (filterBytes*8 / keyCount). */
  bitsPerKey: number;
}

const SEED = 0x5eed5eed;
const POSITIVES = 100;
const NEGATIVES = 1000;

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) {
    throw new Error("No 2K corpora found. Run scripts/download-loghub.sh.");
  }

  const compression: CompressionResult[] = [];
  const detail: ConfigRow[] = [];

  for (const corpus of corpora) {
    const text = corpus.text.toString("utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    const corpusBlob = lines.join("\n");
    const rng = mulberry32(SEED ^ corpus.name.length);

    const positives = positiveQueries(lines, POSITIVES, rng);
    const negatives = negativeQueries(corpusBlob, NEGATIVES, rng);

    // Sanity: every positive query is in fact present.
    for (const q of positives) {
      if (corpusBlob.indexOf(q) === -1) {
        throw new Error(`positive sanity failed on ${corpus.name}: ${q}`);
      }
    }

    const inputBytes = corpus.text.length;
    const logCount = corpus.count;
    const rawNdjson = corpus.ndjson.length;

    const configs: Array<{
      name: string;
      build: () => {
        filterBytes: number;
        keyCount: number;
        buildMs: number;
        contains: (q: string) => boolean;
      };
    }> = [
      {
        name: "bloom_n3_1pct",
        build: () => {
          const { bloom, keyCount, buildMs } = buildBloomNGram(lines, 3, 10);
          return {
            filterBytes: bloom.byteLength,
            keyCount,
            buildMs,
            contains: (q: string) => containsNGram(q, 3, (g: string) => bloom.hasStr(g)),
          };
        },
      },
      {
        name: "bloom_n4_1pct",
        build: () => {
          const { bloom, keyCount, buildMs } = buildBloomNGram(lines, 4, 10);
          return {
            filterBytes: bloom.byteLength,
            keyCount,
            buildMs,
            contains: (q: string) => containsNGram(q, 4, (g: string) => bloom.hasStr(g)),
          };
        },
      },
      {
        name: "binary_fuse_n3",
        build: () => {
          const { fuse, keyCount, buildMs } = buildFuseNGram(lines, 3);
          return {
            filterBytes: fuse.byteLength,
            keyCount,
            buildMs,
            contains: (q: string) =>
              containsNGram(q, 3, (g: string) => fuse.hasKey(BinaryFuse8.hashKeyStr(g))),
          };
        },
      },
      {
        name: "token_filter",
        build: () => {
          const { bloom, keyCount, buildMs } = buildBloomTokens(lines, 10);
          return {
            filterBytes: bloom.byteLength,
            keyCount,
            buildMs,
            contains: (q: string) => containsToken(q, (t: string) => bloom.hasStr(t)),
          };
        },
      },
    ];

    for (const cfg of configs) {
      const { filterBytes, keyCount, buildMs, contains } = cfg.build();
      const { recall, fpr } = evaluate(positives, negatives, contains);
      const bpl = filterBytes / logCount;
      const bitsPerKey = keyCount === 0 ? 0 : (filterBytes * 8) / keyCount;
      detail.push({
        corpus: corpus.name,
        config: cfg.name,
        filterBytes,
        keyCount,
        buildMillis: buildMs,
        recall,
        fpr,
        bytesPerLog: bpl,
        logCount,
        bitsPerKey,
      });

      // Render filter cost as a CompressionResult so the existing
      // markdown table / JSON pipeline picks it up cleanly.
      // `outputBytes` = filter bytes alone; `bytesPerLog` = per-log
      // overhead the chunk would inherit. We stash recall/FPR/keys
      // into the codec name so they survive the JSON dump.
      compression.push({
        corpus: corpus.name,
        codec: `${cfg.name}_recall=${recall.toFixed(2)}_fpr=${fpr.toFixed(3)}_keys=${keyCount}_bpk=${bitsPerKey.toFixed(1)}`,
        inputBytes,
        outputBytes: filterBytes,
        logCount,
        bytesPerLog: bpl,
        ratioVsRaw: ratioFn(inputBytes, filterBytes),
        ratioVsNdjson: ratioFn(rawNdjson, filterBytes),
        encodeMillis: buildMs,
      });
    }
  }

  const report = buildReport("ngram-bloom", compression);
  // Stash the structured detail rows on the report — non-standard but
  // harmless; JSON dump preserves it for results.md authoring.
  (report as unknown as { detail: ConfigRow[] }).detail = detail;
  return report;
}
