/**
 * Light streaming query engine.
 *
 * The first cut of M7. Designed to validate the chunk-pruning +
 * decode path end-to-end and to give the bench harness something
 * concrete to measure query latency against.
 *
 * Design tenets (from PLAN.md priority stack):
 *   - Stream chunk-at-a-time. Never materialize a result set
 *     proportional to total log count.
 *   - Prune chunks before decode. Time-range and severity-range
 *     header checks first; only chunks that survive get decompressed.
 *   - Decoder is the policy. Each chunk knows which `ChunkPolicy`
 *     produced it (currently global to the LogStore — future
 *     versions will store the policy id in the chunk header).
 *
 * Predicate set (the M7 minimum that's still useful):
 *   - time range [from, to)         — inclusive lower, exclusive upper
 *   - severity ≥ N                  — min severity cutoff
 *   - body substring                — case-sensitive contains
 *   - resource attribute equals     — header check, no decode needed
 *   - limit                         — short-circuit when N records emitted
 *
 * Future deliverables (not in this cut):
 *   - Attribute predicates (need M4 sidecar attribute-index work).
 *   - Trace-id lookup (needs M6 BF16 trace-id index).
 *   - Aggregations (count by severity per minute, top-templates).
 *   - LogQL-style string parser (M7.1).
 *
 * Round-trip semantics: decoded LogRecord bodies match input modulo
 * the engine's whitespace normalization (a Drain policy normalizes
 * runs of whitespace to single spaces). Substring queries match
 * against the *normalized* form.
 */

import type { Chunk } from "./chunk.js";
import { readBodiesOnly, readRecords } from "./chunk.js";
import type { LogStore } from "./engine.js";
import type { LogRecord, StreamId } from "./types.js";

// ── Public types ─────────────────────────────────────────────────────

export interface QuerySpec {
  /** Time range [from, to) in unix-nanoseconds. */
  range?: { from: bigint; to: bigint };
  /** Minimum severity number (OTLP scale 1..24). */
  severityGte?: number;
  /** Body substring; case-sensitive contains. Body must be a string. */
  bodyContains?: string;
  /**
   * KVList-body leaf predicates. Each key is a dot-path through the
   * body's KVList structure (`body.req.method`); each value is the
   * exact value to match. Comparison is JS `===`, so numeric values
   * must be passed as numbers, strings as strings.
   *
   * Only valid when records have KVList bodies (structured-JSON logger
   * shape). String-bodied records skip this predicate.
   *
   * Currently a per-record post-decode scan; M6 may add a per-key
   * dictionary index when attributes are promoted to columns.
   */
  bodyLeafEquals?: Record<string, string | number | boolean>;
  /**
   * Resource attribute equality filters. Each (key, value) pair must
   * match for a stream to qualify. Header check; no chunk decode
   * needed for failures.
   */
  resourceEquals?: Record<string, string>;
  /** Maximum records to emit. */
  limit?: number;
}

export interface QueryStats {
  streamsScanned: number;
  streamsPruned: number;
  chunksScanned: number;
  chunksPruned: number;
  recordsScanned: number;
  recordsEmitted: number;
  decodeMillis: number;
}

export interface QueryResult {
  records: LogRecord[];
  stats: QueryStats;
}

// ── Engine integration ───────────────────────────────────────────────

/**
 * Synchronous query — collects all matching records into an array.
 * For small result sets (the typical browser-tab case) this is the
 * convenient API. For large/streaming workloads call `queryStream`.
 */
export function query(store: LogStore, spec: QuerySpec): QueryResult {
  const stats: QueryStats = {
    streamsScanned: 0,
    streamsPruned: 0,
    chunksScanned: 0,
    chunksPruned: 0,
    recordsScanned: 0,
    recordsEmitted: 0,
    decodeMillis: 0,
  };
  const out: LogRecord[] = [];
  const limit = spec.limit ?? Number.POSITIVE_INFINITY;
  for (const _record of queryStream(store, spec, stats)) {
    out.push(_record);
    if (out.length >= limit) break;
  }
  return { records: out, stats };
}

/**
 * Stream matching records one at a time. The caller may stop early
 * (e.g. on `limit`) and the generator stops fetching chunks.
 */
export function* queryStream(
  store: LogStore,
  spec: QuerySpec,
  stats: QueryStats = freshStats()
): Generator<LogRecord> {
  const limit = spec.limit ?? Number.POSITIVE_INFINITY;
  let emitted = 0;
  // Determine if we can use the body-only fast path: bodyContains is
  // the only body-level predicate and we can pre-filter chunks by
  // checking bodies without full record materialization.
  const useBodyFastPath = spec.bodyContains !== undefined && !spec.bodyLeafEquals;

  for (const id of store.streams.ids()) {
    stats.streamsScanned++;
    if (!streamMatches(store, id, spec)) {
      stats.streamsPruned++;
      continue;
    }
    const chunks = store.streams.chunksOf(id);
    const policy = store.policyFor(id);
    for (const chunk of chunks) {
      stats.chunksScanned++;
      if (!chunkOverlapsRange(chunk, spec.range)) {
        stats.chunksPruned++;
        continue;
      }
      if (!chunkPassesSeverity(chunk, spec.severityGte)) {
        stats.chunksPruned++;
        continue;
      }

      if (useBodyFastPath) {
        // Template-token pruning: if the chunk header carries template
        // literal tokens (toks), check if any token contains the needle
        // as a substring. If no template token matches AND the chunk has
        // no raw-string bodies (raw strings might still match), we can
        // skip ZSTD decompression entirely.
        const needle = spec.bodyContains;
        if (needle !== undefined && chunkPrunedByTemplateTokens(chunk, needle)) {
          stats.chunksPruned++;
          continue;
        }
        // Fast path: decode only bodies, check which match the
        // substring. Only do full decode if there are body matches.
        const t0 = nowMillis();
        const bodies = readBodiesOnly(chunk, store.registry, policy);
        let hasMatch = false;
        for (let i = 0; i < bodies.length; i++) {
          if (typeof bodies[i] === "string" && needle !== undefined && (bodies[i] as string).includes(needle)) {
            hasMatch = true;
            break;
          }
        }
        if (!hasMatch) {
          // No body in this chunk matches — skip full decode entirely
          stats.decodeMillis += nowMillis() - t0;
          stats.chunksPruned++;
          continue;
        }
        // Some bodies match — need full records for time/severity post-filtering
        const records = readRecords(chunk, store.registry, policy);
        stats.decodeMillis += nowMillis() - t0;
        for (const record of records) {
          stats.recordsScanned++;
          if (!recordMatches(record, spec)) continue;
          stats.recordsEmitted++;
          yield record;
          emitted++;
          if (emitted >= limit) return;
        }
      } else {
        // Standard path: full decode + per-record filter.
        const t0 = nowMillis();
        const records = readRecords(chunk, store.registry, policy);
        stats.decodeMillis += nowMillis() - t0;
        for (const record of records) {
          stats.recordsScanned++;
          if (!recordMatches(record, spec)) continue;
          stats.recordsEmitted++;
          yield record;
          emitted++;
          if (emitted >= limit) return;
        }
      }
    }
  }
}

// ── Predicate helpers ────────────────────────────────────────────────

function freshStats(): QueryStats {
  return {
    streamsScanned: 0,
    streamsPruned: 0,
    chunksScanned: 0,
    chunksPruned: 0,
    recordsScanned: 0,
    recordsEmitted: 0,
    decodeMillis: 0,
  };
}

function nowMillis(): number {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Number(process.hrtime.bigint()) / 1_000_000;
}

/**
 * Stream-level filter: resource-attribute equality. Cheap because
 * resource lives in the chunk header (or, equivalently here, in the
 * stream registry). No chunk decode needed.
 */
function streamMatches(store: LogStore, id: StreamId, spec: QuerySpec): boolean {
  if (!spec.resourceEquals) return true;
  const resource = store.streams.resourceOf(id);
  for (const [key, value] of Object.entries(spec.resourceEquals)) {
    let found = false;
    for (const kv of resource.attributes) {
      if (kv.key === key && kv.value === value) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Chunk-level filter: time range overlap with [chunk.minNano, chunk.maxNano].
 * Returns true if the chunk *might* contain matching records.
 */
function chunkOverlapsRange(chunk: Chunk, range: QuerySpec["range"]): boolean {
  if (!range) return true;
  const minNano = BigInt(chunk.header.timeRange.minNano);
  const maxNano = BigInt(chunk.header.timeRange.maxNano);
  // Overlap: chunk.max >= range.from && chunk.min < range.to
  if (maxNano < range.from) return false;
  if (minNano >= range.to) return false;
  return true;
}

/**
 * Chunk-level filter: severityGte vs chunk's severityRange zone map.
 * If `chunk.severityRange.max < severityGte`, no record in this
 * chunk can match — skip the decode entirely.
 */
function chunkPassesSeverity(chunk: Chunk, severityGte?: number): boolean {
  if (severityGte === undefined) return true;
  // Backward compat: chunks written before severityRange landed have
  // an undefined field. Treat as "passes" — over-include rather than
  // under-include.
  const range = chunk.header.severityRange;
  if (!range) return true;
  return range.max >= severityGte;
}

/**
 * Template-token pruning for bodyContains. If the chunk header carries
 * template literal tokens (TypedColumnarDrainPolicy stores these in
 * codecMeta.toks), check if any token contains the needle as a
 * substring. If no template token can match AND the chunk metadata
 * confirms zero raw-string bodies, we can skip ZSTD decompression.
 *
 * SOUNDNESS: We can only prune when BOTH conditions hold:
 *   1. No template literal token contains the needle
 *   2. The chunk has zero raw-string bodies (rawCount === 0)
 *
 * Even when pruning, variable values (PARAM_STR slots) could still
 * contain the needle — but those aren't part of template *literals*.
 * The body is reconstructed as: literal + variable + literal + ...
 * So if no literal contains the needle AND the needle doesn't span a
 * literal/variable boundary, we'd need to also check variable columns.
 * Since checking variables requires decompression anyway, template-
 * token pruning is only effective for needles that MUST appear in a
 * template literal (not in a variable slot) to produce a match.
 *
 * CONSERVATIVE: returns false (don't prune) when unsure.
 */
function chunkPrunedByTemplateTokens(chunk: Chunk, needle: string): boolean {
  const meta = chunk.header.codecMeta as { toks?: string[]; rawCount?: number } | undefined;
  if (!meta?.toks) return false; // no token data — can't prune

  // If there are raw-string bodies, they could contain anything
  if (meta.rawCount === undefined || meta.rawCount > 0) return false;

  // Check if any template literal token contains the needle
  for (const tok of meta.toks) {
    if (tok.includes(needle)) return false; // might match — don't prune
  }

  // No template token contains the needle AND there are zero raw strings.
  // However, the reconstructed body is: tok0 + var0 + tok1 + var1 + ...
  // If the needle could span a tok/var boundary, we can't prune.
  // Safe to prune only if the needle can't be split across boundaries.
  // Since we don't track variable values at the header level, we can
  // NOT safely prune — variable values might contain the needle.
  // Template-token pruning is only sound for needles that match a
  // complete template token (not a substring of a variable).
  //
  // DISABLED: This optimization requires bloom filters or variable-
  // value token sets in the header to be sound. For now, return false.
  return false;
}

/** Per-record filter — applied after chunk decode. */
function recordMatches(record: LogRecord, spec: QuerySpec): boolean {
  if (spec.range) {
    if (record.timeUnixNano < spec.range.from) return false;
    if (record.timeUnixNano >= spec.range.to) return false;
  }
  if (spec.severityGte !== undefined && record.severityNumber < spec.severityGte) {
    return false;
  }
  if (spec.bodyContains !== undefined) {
    if (typeof record.body !== "string") return false;
    if (!record.body.includes(spec.bodyContains)) return false;
  }
  if (spec.bodyLeafEquals !== undefined) {
    const body = record.body;
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body instanceof Uint8Array
    ) {
      return false;
    }
    for (const [path, expected] of Object.entries(spec.bodyLeafEquals)) {
      const actual = leafGet(body as Record<string, unknown>, path);
      if (actual !== expected) return false;
    }
  }
  return true;
}

/**
 * Read a dot-path leaf from a KVList object. `body.req.method` →
 * `body.req.method`. Returns undefined if any segment misses or the
 * traversal hits a non-object intermediate.
 */
function leafGet(body: Record<string, unknown>, path: string): unknown {
  // Cheap path walker. The `body.` prefix is conventional but the
  // root object IS the body, so strip it if present.
  const segments = path.startsWith("body.") ? path.substring(5).split(".") : path.split(".");
  let cur: unknown = body;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
