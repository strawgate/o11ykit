/**
 * token-postings.
 *
 * Validates Husky's per-token-hash Roaring postings design: at
 * chunk-close, build `Map<hash(token) % 64K, Roaring(row_indices)>`,
 * so that `body contains "timeout" AND severity ≥ WARN` is a Roaring
 * AND of two pre-computed bitmaps with no row decode for rejected
 * rows. Compares storage cost and substring-search recall vs the
 * trigram Bloom rejected by measurement (2.59 B/log, refuted at the
 * <1 B/log threshold).
 *
 * Configurations:
 *   - `bloom_n3`         — trigram Bloom baseline.
 *   - `postings_n3`      — trigram Roaring postings, modulus 64 K.
 *   - `postings_token`   — token Roaring postings (Husky's design).
 *
 * Per (corpus, config) we report:
 *   - storage in bytes/log,
 *   - recall on 100 positive substring queries (literals from real lines),
 *   - average row-set size returned for positive queries (the
 *     full-decode cost on a hit; smaller = better selectivity).
 *
 * Round-trip serialization is verified on one bitmap per chunk.
 */

import { loadAllAvailable } from "./corpora.js";
import { buildReport, type CompressionResult, nowMillis, ratio as ratioFn } from "./harness.js";
import { Bloom, buildNGramSet, containsNGram } from "./index-bloom-impl.js";
import {
  buildPostings,
  eachNGram,
  eachToken,
  hashStr32,
  lookupAnd,
  type PostingsIndex,
  Roaring32,
  serializePostings,
} from "./index-roaring-impl.js";

// ---------- query generation (mirrors ngram-bloom.bench.ts) ----------

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

// ---------- ground truth: which rows actually contain each query? ----------

/**
 * Brute-force which rows actually contain `q` as a substring.
 * Used both for recall measurement (vs filter "possibly contains")
 * and to bound posting-list selectivity.
 */
function trueMatchingRows(lines: string[], q: string): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").indexOf(q) !== -1) out.add(i);
  }
  return out;
}

// ---------- evaluators ----------

interface PostingsEval {
  /** TPs / |positives|. Required to be 1.0 for a correct index. */
  recall: number;
  /** Mean cardinality of returned row set across positive queries. */
  avgRowSetSize: number;
  /** Mean true-positive count across positive queries. */
  avgTrueMatches: number;
  /** Mean overhead = (returned - true) on positive queries. */
  avgOverhead: number;
}

/**
 * For the postings index, evaluate against positive substring queries.
 * For an n-gram postings index, the query is split into n-grams and
 * the row sets AND-intersected. For a token-postings index, the query
 * is split into whole-tokens — substrings that span token boundaries
 * cannot be answered (recall < 1).
 */
function evalPostings(
  idx: PostingsIndex,
  positives: string[],
  lines: string[],
  splitter: (q: string) => string[]
): PostingsEval {
  let recallNum = 0;
  let totalRowSet = 0;
  let totalTrue = 0;
  let totalOver = 0;
  let evaluated = 0;
  for (const q of positives) {
    const truth = trueMatchingRows(lines, q);
    const parts = splitter(q);
    if (parts.length === 0) {
      // Query reduces to nothing — counts as a recall miss only if there
      // are real matches; otherwise skip.
      if (truth.size > 0) {
        // Postings index can't answer; treat as "all rows possibly match"
        // (the calling executor would fall back to scan).
        recallNum += 1;
        totalRowSet += lines.length;
        totalTrue += truth.size;
        totalOver += lines.length - truth.size;
        evaluated++;
      }
      continue;
    }
    const rows = lookupAnd(idx, parts, lines.length);
    let hits = 0;
    let returnedSize = 0;
    if (rows !== null) {
      returnedSize = rows.size;
      // recall: every truth row must appear in returned set
      let allFound = true;
      for (const tr of truth) {
        if (!rows.has(tr)) {
          allFound = false;
          break;
        }
      }
      hits = allFound ? 1 : 0;
    } else {
      // index says definitely-absent
      hits = truth.size === 0 ? 1 : 0;
    }
    recallNum += hits;
    totalRowSet += returnedSize;
    totalTrue += truth.size;
    totalOver += Math.max(0, returnedSize - truth.size);
    evaluated++;
  }
  return {
    recall: evaluated === 0 ? 1 : recallNum / evaluated,
    avgRowSetSize: evaluated === 0 ? 0 : totalRowSet / evaluated,
    avgTrueMatches: evaluated === 0 ? 0 : totalTrue / evaluated,
    avgOverhead: evaluated === 0 ? 0 : totalOver / evaluated,
  };
}

/** Bloom evaluator: yes/no per query, no row-level info. */
interface BloomEval {
  recall: number;
  /** "Returned size" for a Bloom hit is the whole chunk; for a miss, 0. */
  avgRowSetSize: number;
  avgTrueMatches: number;
  avgOverhead: number;
}

function evalBloom(
  positives: string[],
  lines: string[],
  contains: (q: string) => boolean
): BloomEval {
  let recallNum = 0;
  let totalRowSet = 0;
  let totalTrue = 0;
  let totalOver = 0;
  for (const q of positives) {
    const truth = trueMatchingRows(lines, q);
    const possibly = contains(q);
    // recall counts "every true match is reachable": for Bloom, a
    // "yes" lets the executor scan and find every match; a "no" loses
    // them all (since the executor would prune the chunk).
    if (truth.size === 0) {
      recallNum += 1;
    } else {
      recallNum += possibly ? 1 : 0;
    }
    const returned = possibly ? lines.length : 0;
    totalRowSet += returned;
    totalTrue += truth.size;
    totalOver += Math.max(0, returned - truth.size);
  }
  return {
    recall: positives.length === 0 ? 1 : recallNum / positives.length,
    avgRowSetSize: positives.length === 0 ? 0 : totalRowSet / positives.length,
    avgTrueMatches: positives.length === 0 ? 0 : totalTrue / positives.length,
    avgOverhead: positives.length === 0 ? 0 : totalOver / positives.length,
  };
}

// ---------- bench main ----------

interface ConfigRow {
  corpus: string;
  config: string;
  storageBytes: number;
  bytesPerLog: number;
  logCount: number;
  bucketCount: number;
  recall: number;
  avgRowSetSize: number;
  avgTrueMatches: number;
  avgOverhead: number;
  buildMillis: number;
  /** Estimated decode-cost ratio vs full chunk scan: avgRowSetSize / logCount. */
  decodeFraction: number;
}

const SEED = 0x5eed5eed;
const POSITIVES = 100;
const MODULUS = 65536;

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
    const rng = mulberry32(SEED ^ corpus.name.length);
    const positives = positiveQueries(lines, POSITIVES, rng);

    // Sanity: every positive query is in fact present.
    for (const q of positives) {
      if (text.indexOf(q) === -1) {
        throw new Error(`positive sanity failed on ${corpus.name}: ${q}`);
      }
    }

    const inputBytes = corpus.text.length;
    const logCount = corpus.count;
    const rawNdjson = corpus.ndjson.length;

    // ---------- bloom_n3 (R baseline) ----------
    {
      const t0 = nowMillis();
      const grams = buildNGramSet(lines, 3);
      const k = Math.max(1, Math.round(10 * Math.LN2));
      const bloom = new Bloom(grams.size, 10, k);
      for (const g of grams) bloom.addStr(g);
      const buildMs = nowMillis() - t0;
      const ev = evalBloom(positives, lines, (q) => containsNGram(q, 3, (g) => bloom.hasStr(g)));
      const bytes = bloom.byteLength;
      const bpl = bytes / logCount;
      detail.push({
        corpus: corpus.name,
        config: "bloom_n3",
        storageBytes: bytes,
        bytesPerLog: bpl,
        logCount,
        bucketCount: grams.size,
        recall: ev.recall,
        avgRowSetSize: ev.avgRowSetSize,
        avgTrueMatches: ev.avgTrueMatches,
        avgOverhead: ev.avgOverhead,
        buildMillis: buildMs,
        decodeFraction: ev.avgRowSetSize / logCount,
      });
      compression.push({
        corpus: corpus.name,
        codec: `bloom_n3_recall=${ev.recall.toFixed(2)}_rows=${ev.avgRowSetSize.toFixed(0)}`,
        inputBytes,
        outputBytes: bytes,
        logCount,
        bytesPerLog: bpl,
        ratioVsRaw: ratioFn(inputBytes, bytes),
        ratioVsNdjson: ratioFn(rawNdjson, bytes),
        encodeMillis: buildMs,
      });
    }

    // ---------- postings_n3 ----------
    {
      const t0 = nowMillis();
      const idx = buildPostings(lines, MODULUS, function* (line) {
        // dedupe within line via the row-side Set in buildPostings
        for (const g of eachNGram(line, 3)) yield g;
      });
      const ser = serializePostings(idx);
      const buildMs = nowMillis() - t0;

      // Round-trip verify one container to catch serialization bugs.
      verifyOneRoundTrip(idx, corpus.name);

      const ev = evalPostings(idx, positives, lines, (q) => {
        const out: string[] = [];
        for (const g of eachNGram(q, 3)) out.push(g);
        return out;
      });
      const bytes = ser.length;
      const bpl = bytes / logCount;
      detail.push({
        corpus: corpus.name,
        config: "postings_n3",
        storageBytes: bytes,
        bytesPerLog: bpl,
        logCount,
        bucketCount: idx.buckets.size,
        recall: ev.recall,
        avgRowSetSize: ev.avgRowSetSize,
        avgTrueMatches: ev.avgTrueMatches,
        avgOverhead: ev.avgOverhead,
        buildMillis: buildMs,
        decodeFraction: ev.avgRowSetSize / logCount,
      });
      compression.push({
        corpus: corpus.name,
        codec: `postings_n3_recall=${ev.recall.toFixed(2)}_rows=${ev.avgRowSetSize.toFixed(0)}`,
        inputBytes,
        outputBytes: bytes,
        logCount,
        bytesPerLog: bpl,
        ratioVsRaw: ratioFn(inputBytes, bytes),
        ratioVsNdjson: ratioFn(rawNdjson, bytes),
        encodeMillis: buildMs,
      });
    }

    // ---------- postings_token (Husky's design) ----------
    {
      const t0 = nowMillis();
      const idx = buildPostings(lines, MODULUS, function* (line) {
        for (const t of eachToken(line)) yield t;
      });
      const ser = serializePostings(idx);
      const buildMs = nowMillis() - t0;

      const ev = evalPostings(idx, positives, lines, (q) => {
        const out: string[] = [];
        for (const t of eachToken(q)) out.push(t);
        return out;
      });
      const bytes = ser.length;
      const bpl = bytes / logCount;
      detail.push({
        corpus: corpus.name,
        config: "postings_token",
        storageBytes: bytes,
        bytesPerLog: bpl,
        logCount,
        bucketCount: idx.buckets.size,
        recall: ev.recall,
        avgRowSetSize: ev.avgRowSetSize,
        avgTrueMatches: ev.avgTrueMatches,
        avgOverhead: ev.avgOverhead,
        buildMillis: buildMs,
        decodeFraction: ev.avgRowSetSize / logCount,
      });
      compression.push({
        corpus: corpus.name,
        codec: `postings_token_recall=${ev.recall.toFixed(2)}_rows=${ev.avgRowSetSize.toFixed(0)}`,
        inputBytes,
        outputBytes: bytes,
        logCount,
        bytesPerLog: bpl,
        ratioVsRaw: ratioFn(inputBytes, bytes),
        ratioVsNdjson: ratioFn(rawNdjson, bytes),
        encodeMillis: buildMs,
      });
    }
  }

  const report = buildReport("token-postings", compression);
  (report as unknown as { detail: ConfigRow[] }).detail = detail;
  return report;
}

/**
 * Pick one bucket out of the index, serialize and deserialize it, and
 * confirm the round-tripped bitmap iterates to the exact same set.
 */
function verifyOneRoundTrip(idx: PostingsIndex, corpusName: string): void {
  const first = idx.buckets.entries().next();
  if (first.done) return;
  const [, bm] = first.value as [number, Roaring32];
  const bytes = bm.serialize();
  const back = Roaring32.deserialize(bytes);
  const a = bm.toArray();
  const b = back.toArray();
  if (a.length !== b.length) {
    throw new Error(
      `Roaring round-trip on ${corpusName}: card mismatch ${a.length} vs ${b.length}`
    );
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(`Roaring round-trip on ${corpusName}: value mismatch at ${i}`);
    }
  }
  // Also exercise hashStr32 stability and andCardinality.
  void hashStr32("smoketest", MODULUS);
  void bm.andCardinality(back);
}
