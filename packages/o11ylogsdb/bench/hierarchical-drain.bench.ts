/**
 * hierarchical-drain — Drain on KVList sub-fields.
 *
 * When an OTLP body is a KVList (Pino, zap, slog), the *outer* body is
 * structured but the *inner* leaf strings (`msg`, `req.url`,
 * `error.message`) are still text-templatable. This bench measures
 * whether running Drain on these subfields collapses them as well as
 * Drain collapses raw-text bodies — i.e. is hierarchical Drain a useful
 * addition to the M4 columnar/per-key codec dispatch?
 *
 * Method:
 *   1. Load `bench/corpora/synthetic/pino_5k.ndjson` (5 K records).
 *   2. For each text-typed leaf path (`body.msg`, `body.req.url`, …),
 *      gather the per-row column of values.
 *   3. Run a fresh `Drain` over each column (one Drain per subfield,
 *      so template spaces don't pollute each other).
 *   4. Two-pass: ingest all values to converge the templates, then
 *      re-tokenize each value to extract `vars[]` against the final
 *      template (mirrors `DrainChunkPolicy.preEncode`).
 *   5. Encode the column as a packed binary stream of
 *      `[varint template_id][varint nvars][varint var_len + bytes]*`,
 *      ZSTD-19 the encoded form.
 *   6. Compare ZSTD-19(raw newline-joined column) vs
 *      ZSTD-19(template-form binary). Record per-subfield rows and an
 *      aggregate `body_text_leaves_total` row.
 *   7. Round-trip the first 32 records of every column and verify the
 *      reconstructed string matches the source value (whitespace-
 *      normalized — Drain tokenizes on whitespace).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { Drain, tokenize } from "../dist/drain.js";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

const CORPUS_NAME = "pino_5k";

function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate package root from ${import.meta.url}`);
}

function corpusPath(): string {
  return join(findPackageRoot(), "bench", "corpora", "synthetic", "pino_5k.ndjson");
}

const zstd19 = (b: Buffer): Buffer =>
  zstdCompressSync(b, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } });

// ── Recursive flatten of body → string-leaf columns ───────────────────

/**
 * Walk a JSON object and append leaf values to per-path string columns.
 * Only string-typed leaves are collected — numbers/booleans/nulls are
 * skipped because Drain on `null`/`200`/`30.5` is meaningless and
 * those columns are best handled by typed codecs (FoR, dict, …).
 *
 * Missing keys for a row are *not* padded — Drain only sees rows where
 * the key exists. The per-column `presence` array records which row
 * indices contributed values; non-present rows are preserved as empty
 * strings in the baseline column form so byte counts compare apples-to-
 * apples.
 */
interface LeafColumn {
  values: string[];
  presence: number[]; // row indices where a value was present
}

function collectStringLeaves(
  obj: unknown,
  prefix: string,
  rowIndex: number,
  columns: Map<string, LeafColumn>
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      collectStringLeaves(v, key, rowIndex, columns);
    }
    return;
  }
  if (typeof obj !== "string") return;
  let bucket = columns.get(prefix);
  if (!bucket) {
    bucket = { values: [], presence: [] };
    columns.set(prefix, bucket);
  }
  bucket.values.push(obj);
  bucket.presence.push(rowIndex);
}

// ── Varint helper (mirrors codec-columnar's pattern) ──────────────────

function pushVarint(out: number[], n: number): void {
  if (!Number.isFinite(n) || n < 0) throw new Error("varint must be non-negative");
  let x = n >>> 0;
  while (x >= 0x80) {
    out.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  out.push(x & 0x7f);
}

function readVarint(buf: Uint8Array, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  while (true) {
    if (pos.i >= buf.length) throw new Error("varint: read past end");
    const b = buf[pos.i++] as number;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error("varint overflow");
  }
  return result >>> 0;
}

// ── Drain encode: two-pass extract + binary encode ────────────────────

interface TemplateForm {
  templateId: number;
  vars: string[];
}

interface ColumnEncoded {
  /** Drain instance after both passes (templates frozen). */
  drain: Drain;
  /** Per-row template form, in the same order as the input column. */
  forms: TemplateForm[];
  /** Packed binary blob ready for ZSTD. */
  binary: Uint8Array;
  /** Sum of var bytes alone (for reasoning about var-stream entropy). */
  varBytes: number;
}

const enc = new TextEncoder();

function ingestAndEncode(values: string[]): ColumnEncoded {
  // Pass 1: ingest every value into Drain to converge templates.
  const drain = new Drain();
  for (const v of values) {
    drain.matchOrAdd(v);
  }

  // Snapshot final templates (id → tokens).
  const templateById = new Map<number, string[]>();
  for (const t of drain.templates()) {
    templateById.set(t.id, tokenize(t.template));
  }

  // Pass 2: re-match each value against the now-frozen templates and
  // extract vars at wildcard positions.
  const forms: TemplateForm[] = new Array(values.length);
  const out: number[] = [];
  let varBytes = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as string;
    const m = drain.matchTemplate(v);
    if (!m) {
      // Should never happen — value was ingested above.
      throw new Error(`hierarchical-drain: post-ingest match miss for value ${JSON.stringify(v)}`);
    }
    forms[i] = m;
    pushVarint(out, m.templateId);
    pushVarint(out, m.vars.length);
    for (const v0 of m.vars) {
      const bytes = enc.encode(v0);
      pushVarint(out, bytes.length);
      for (let j = 0; j < bytes.length; j++) out.push(bytes[j] as number);
      varBytes += bytes.length;
    }
  }
  return { drain, forms, binary: Uint8Array.from(out), varBytes };
}

// ── Round-trip ────────────────────────────────────────────────────────

const dec = new TextDecoder();

/**
 * Decode the binary form back to strings using the supplied template
 * dictionary. We reconstruct via `Drain.reconstruct` (token-join with
 * single spaces) — note this is a whitespace-normalized form, matching
 * the Drain tokenizer's input. We compare against the same
 * whitespace-normalized form of the source.
 */
function decode(binary: Uint8Array, templateById: Map<number, string[]>): string[] {
  const out: string[] = [];
  const pos = { i: 0 };
  while (pos.i < binary.length) {
    const tid = readVarint(binary, pos);
    const nvars = readVarint(binary, pos);
    const vars: string[] = new Array(nvars);
    for (let i = 0; i < nvars; i++) {
      const len = readVarint(binary, pos);
      const bytes = binary.subarray(pos.i, pos.i + len);
      pos.i += len;
      vars[i] = dec.decode(bytes);
    }
    const tmpl = templateById.get(tid);
    if (!tmpl) throw new Error(`decode: unknown template id ${tid}`);
    out.push(Drain.reconstruct(tmpl, vars));
  }
  return out;
}

function whitespaceNormalize(s: string): string {
  return s
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .join(" ");
}

function verifyRoundTrip(field: string, values: string[], encoded: ColumnEncoded): void {
  const templateById = new Map<number, string[]>();
  for (const t of encoded.drain.templates()) {
    templateById.set(t.id, tokenize(t.template));
  }
  const decoded = decode(encoded.binary, templateById);
  if (decoded.length !== values.length) {
    throw new Error(
      `hierarchical-drain[${field}]: round-trip count mismatch ${decoded.length} vs ${values.length}`
    );
  }
  const checkN = Math.min(32, values.length);
  for (let i = 0; i < checkN; i++) {
    const want = whitespaceNormalize(values[i] as string);
    const got = decoded[i] as string;
    if (got !== want) {
      throw new Error(
        `hierarchical-drain[${field}]: mismatch at row ${i}\n` +
          `  expected: ${JSON.stringify(want)}\n` +
          `  got:      ${JSON.stringify(got)}`
      );
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────

interface FieldOutcome {
  field: string;
  /** Total row count in the corpus (for B/log denominator). */
  totalRows: number;
  /** Rows where this field was present (subset of totalRows). */
  presentRows: number;
  /** Distinct templates extracted by Drain. */
  templates: number;
  /** ZSTD-19 of newline-joined raw values. */
  baselineBytes: number;
  /** ZSTD-19 of packed binary template form. */
  templateBytes: number;
  /** Embedded template dict size (sum of utf-8 template token bytes). */
  dictBytes: number;
  /** Var-bytes inside the binary (informational). */
  varBytes: number;
}

function encodeTemplateDict(drain: Drain): Buffer {
  // Embed dict as: [varint n_templates][per template: varint id, varint
  // utf8_len, bytes]. Costed once per column since the dict is the
  // hierarchical-drain overhead vs raw ZSTD.
  const out: number[] = [];
  let n = 0;
  const tmpls: { id: number; bytes: Uint8Array }[] = [];
  for (const t of drain.templates()) {
    tmpls.push({ id: t.id, bytes: enc.encode(t.template) });
    n++;
  }
  pushVarint(out, n);
  for (const t of tmpls) {
    pushVarint(out, t.id);
    pushVarint(out, t.bytes.length);
    for (let i = 0; i < t.bytes.length; i++) out.push(t.bytes[i] as number);
  }
  return Buffer.from(Uint8Array.from(out));
}

export default async function run() {
  const path = corpusPath();
  if (!existsSync(path)) {
    throw new Error(
      `Pino corpus not found at ${path}. ` +
        `Generate it with: python3 bench/scripts/generate-pino-corpus.py`
    );
  }
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);

  // Collect every string-leaf column from body.*.
  const columns = new Map<string, LeafColumn>();
  for (let i = 0; i < lines.length; i++) {
    const env = JSON.parse(lines[i] as string) as { body: unknown };
    collectStringLeaves(env.body, "", i, columns);
  }

  const totalRows = lines.length;
  const outcomes: FieldOutcome[] = [];
  const compression: CompressionResult[] = [];

  // Sort columns by present-row count desc so the headline subfields
  // appear first in the table.
  const sortedFields = [...columns.keys()].sort(
    (a, b) => (columns.get(b)?.values.length ?? 0) - (columns.get(a)?.values.length ?? 0)
  );

  let aggregateBaseline = 0;
  let aggregateTemplate = 0;
  let aggregateDict = 0;
  let aggregateSelective = 0;
  const selectiveChoices: { field: string; chose: "baseline" | "drain"; saved: number }[] = [];

  for (const field of sortedFields) {
    const col = columns.get(field) as LeafColumn;
    const values = col.values;
    const presentRows = values.length;

    // Baseline: ZSTD-19 over newline-joined raw values.
    const rawBuf = Buffer.from(`${values.join("\n")}\n`);
    const tBase0 = nowMillis();
    const baselineOut = zstd19(rawBuf);
    const tBase1 = nowMillis();

    // Template form: Drain → packed binary → ZSTD-19.
    const tEnc0 = nowMillis();
    const encoded = ingestAndEncode(values);
    const tEnc1 = nowMillis();

    // Verify round-trip on the first 32 records.
    verifyRoundTrip(field, values, encoded);

    const dictBuf = encodeTemplateDict(encoded.drain);
    const dictOut = zstd19(dictBuf);
    const tplBuf = Buffer.from(encoded.binary);
    const tTpl0 = nowMillis();
    const templateOut = zstd19(tplBuf);
    const tTpl1 = nowMillis();
    const templateTotalBytes = templateOut.length + dictOut.length;

    const baselineBytes = baselineOut.length;

    aggregateBaseline += baselineBytes;
    aggregateTemplate += templateTotalBytes;
    aggregateDict += dictOut.length;

    // Selective: pick whichever encoding is smaller for this column.
    // Models a realistic per-column codec dispatch that falls back to
    // raw ZSTD when Drain doesn't help (high-cardinality columns like
    // UUIDs and userIds).
    const chose: "baseline" | "drain" = templateTotalBytes < baselineBytes ? "drain" : "baseline";
    const selectiveBytes = Math.min(baselineBytes, templateTotalBytes);
    aggregateSelective += selectiveBytes;
    selectiveChoices.push({
      field,
      chose,
      saved: baselineBytes - selectiveBytes,
    });

    outcomes.push({
      field,
      totalRows,
      presentRows,
      templates: encoded.drain.templateCount(),
      baselineBytes,
      templateBytes: templateTotalBytes,
      dictBytes: dictOut.length,
      varBytes: encoded.varBytes,
    });

    // Per-field rows (B/log normalized over total rows so columns are
    // comparable to the engine-level numbers in pino-roundtrip).
    compression.push({
      corpus: `${field}`,
      codec: `${field}_baseline_zstd-19`,
      inputBytes: rawBuf.length,
      outputBytes: baselineBytes,
      logCount: totalRows,
      bytesPerLog: bytesPerLog(baselineBytes, totalRows),
      ratioVsRaw: ratioFn(rawBuf.length, baselineBytes),
      ratioVsNdjson: ratioFn(rawBuf.length, baselineBytes),
      encodeMillis: tBase1 - tBase0,
    });
    compression.push({
      corpus: `${field}`,
      codec: `${field}_drain_zstd-19`,
      inputBytes: rawBuf.length,
      outputBytes: templateTotalBytes,
      logCount: totalRows,
      bytesPerLog: bytesPerLog(templateTotalBytes, totalRows),
      ratioVsRaw: ratioFn(rawBuf.length, templateTotalBytes),
      ratioVsNdjson: ratioFn(rawBuf.length, templateTotalBytes),
      encodeMillis: tEnc1 - tEnc0 + (tTpl1 - tTpl0),
    });
  }

  // Aggregate row across all string-leaf columns.
  compression.push({
    corpus: "ALL_STRING_LEAVES",
    codec: "baseline_zstd-19",
    inputBytes: 0,
    outputBytes: aggregateBaseline,
    logCount: totalRows,
    bytesPerLog: bytesPerLog(aggregateBaseline, totalRows),
    ratioVsRaw: 0,
    ratioVsNdjson: 0,
    encodeMillis: 0,
  });
  compression.push({
    corpus: "ALL_STRING_LEAVES",
    codec: "drain_zstd-19",
    inputBytes: 0,
    outputBytes: aggregateTemplate,
    logCount: totalRows,
    bytesPerLog: bytesPerLog(aggregateTemplate, totalRows),
    ratioVsRaw: 0,
    ratioVsNdjson: 0,
    encodeMillis: 0,
  });
  compression.push({
    corpus: "ALL_STRING_LEAVES",
    codec: "selective_zstd-19",
    inputBytes: 0,
    outputBytes: aggregateSelective,
    logCount: totalRows,
    bytesPerLog: bytesPerLog(aggregateSelective, totalRows),
    ratioVsRaw: 0,
    ratioVsNdjson: 0,
    encodeMillis: 0,
  });
  compression.push({
    corpus: "ALL_STRING_LEAVES",
    codec: "drain_dict_overhead",
    inputBytes: 0,
    outputBytes: aggregateDict,
    logCount: totalRows,
    bytesPerLog: bytesPerLog(aggregateDict, totalRows),
    ratioVsRaw: 0,
    ratioVsNdjson: 0,
    encodeMillis: 0,
  });

  // Surface the per-field outcomes as a final synthetic block in
  // CompressionResult shape (fits the JSON serializer; not rendered as
  // prose here — see results.md for the digested table).
  for (const o of outcomes) {
    const choice = selectiveChoices.find((c) => c.field === o.field);
    const chose = choice ? choice.chose : "?";
    compression.push({
      corpus: `__INFO__${o.field}`,
      codec: `templates=${o.templates};presence=${o.presentRows};vars=${o.varBytes};chose=${chose}`,
      inputBytes: 0,
      outputBytes: 0,
      logCount: o.presentRows,
      bytesPerLog: 0,
      ratioVsRaw: 0,
      ratioVsNdjson: 0,
      encodeMillis: 0,
    });
  }

  return buildReport("hierarchical-drain", compression);
}

// Re-export for the runner discovery glob; matches sibling pattern.
export const corpusName = CORPUS_NAME;
