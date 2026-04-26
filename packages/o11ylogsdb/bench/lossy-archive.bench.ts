/**
 * Lossy archive compression benchmark.
 *
 * For each Loghub-2k corpus, applies progressively more aggressive
 * *lossy* normalizations to the raw text and measures ZSTD-19 output
 * size. Establishes the cold-tier (M5 background-compaction) lower
 * bound: how much storage is on the table if we accept information
 * loss in archive storage?
 *
 * Round-trip is intentionally *not* checked. These transforms are
 * deliberately destructive — round-tripping would require side-channel
 * storage of the lost information, which would defeat the experiment.
 * Each transform documents its "information lost" in the comments
 * below, and the results.md spells out what would and would not be
 * recoverable.
 *
 * Transforms (cumulative — each level applies on top of the previous):
 *   1. baseline                  — raw text, ZSTD-19. (Lossless.)
 *   2. normalize_whitespace      — collapse \s+ to ' ', strip trailing
 *                                  whitespace. Lost: original whitespace
 *                                  layout, multi-space alignment, tabs.
 *   3. round_timestamps_ms       — round timestamp tokens with sub-ms
 *                                  precision down to ms. Lost: micro/
 *                                  nanosecond fractional digits.
 *   4. mask_numeric_ids          — replace runs of >=8 consecutive
 *                                  digits with `<N>`. Lost: actual
 *                                  block IDs / pids / counters.
 *   5. mask_ip_addresses         — replace IPv4/IPv6 addresses with
 *                                  `<IP>`. Lost: source/dest IPs.
 *   6. drop_sub_msec             — round numeric tokens that look like
 *                                  ns/µs (>=10 digits, or fractional
 *                                  parts >3 digits) to ms granularity.
 *                                  Lost: high-resolution durations.
 *   7. canonical_normalize_all   — apply 2+3+4+5+6 (this is what an
 *                                  M5 background compactor would do).
 *
 * Bonus aggressive transforms (independent of the cumulative chain):
 *   - templates_only             — replace each line with its Drain
 *                                  template-id. Lost: every variable
 *                                  in the line. Recovers "what kinds
 *                                  of events happened" but no values.
 *   - temporal_downsample_5x     — keep only every 5th line within
 *                                  each Drain template-id. Lost: 80%
 *                                  of the lines.
 *   - severity_tier_drop_debug   — drop every line whose detected
 *                                  severity is DEBUG / TRACE. Lost:
 *                                  debug-level events entirely.
 */

import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { Drain } from "../dist/drain.js";
import { type Corpus, loadAllAvailable } from "./corpora.js";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

const ZSTD_19 = (b: Buffer): Buffer =>
  zstdCompressSync(b, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
  });

// ── Transform primitives ──────────────────────────────────────────────

/** Collapse runs of whitespace; strip trailing whitespace per line. */
function normalizeWhitespace(line: string): string {
  return line.replace(/[ \t\f\v]+/g, " ").replace(/[ \t\f\v]+$/g, "");
}

/**
 * Round timestamps with sub-ms precision down to ms.
 *
 * Targets two common formats observed in Loghub:
 *   - ISO-ish `YYYY-MM-DD-HH.MM.SS.ffffff` (BGL): 6-digit fractional
 *     seconds → 3-digit (drop µs/ns).
 *   - `YYYY-MM-DD HH:MM:SS.ffffff` (OpenStack-style): same.
 *   - Bare `HH:MM:SS.ffffff` clock fragments.
 *
 * Information lost: digits past millisecond (positions 4+ after the
 * fractional point).
 */
function roundTimestampsMs(line: string): string {
  // BGL: 2005-06-03-15.42.50.675872 → 2005-06-03-15.42.50.675
  let out = line.replace(/(\d{4}-\d{2}-\d{2}-\d{2}\.\d{2}\.\d{2}\.)(\d{3})\d+/g, "$1$2");
  // ISO with space + colons: 2017-05-16 00:00:00.272123 → 2017-05-16 00:00:00.272
  out = out.replace(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.)(\d{3})\d+/g, "$1$2");
  // Bare clock: 04:47:44.123456 → 04:47:44.123
  out = out.replace(/(\b\d{2}:\d{2}:\d{2}\.)(\d{3})\d+/g, "$1$2");
  return out;
}

/**
 * Replace runs of 8+ consecutive digits (block IDs, pids, counters)
 * with the placeholder `<N>`. Note that we do *not* touch shorter
 * digit runs — keeps timestamps and small numbers intact.
 *
 * Information lost: the actual numeric value of long-id tokens.
 */
function maskNumericIds(line: string): string {
  return line.replace(/-?\d{8,}/g, "<N>");
}

/**
 * Replace IPv4 and (best-effort) IPv6 addresses with `<IP>`.
 *
 * IPv4: dotted-quad, each octet 1-3 digits.
 * IPv6: stricter than the textbook regex — requires either a
 *   double-colon `::` or at least one hex group containing a hex
 *   letter (a-f), so we don't match `HH:MM:SS` clock fragments.
 *
 * Information lost: source/dest IP addresses.
 */
function maskIpAddresses(line: string): string {
  // IPv4
  let out = line.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<IP>");
  // IPv6 with double-colon
  out = out.replace(/\b[0-9a-fA-F:]*::[0-9a-fA-F:]+\b/g, "<IP>");
  // IPv6 full form: must contain at least one hex letter to avoid
  // matching HH:MM:SS or MM:SS clock fragments.
  out = out.replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, (m) =>
    /[a-fA-F]/.test(m) ? "<IP>" : m
  );
  return out;
}

/**
 * Round numeric durations with sub-ms precision to ms granularity.
 *
 * Heuristic:
 *   - Decimal numbers with >3 fractional digits → truncate to 3.
 *     (e.g. `time: 0.2477829` → `time: 0.247`.)
 *   - Standalone integer runs of >=10 digits that look like
 *     epoch-ns or counters: truncated to 10 digits (epoch-second
 *     level). This overlaps with mask_numeric_ids when chained.
 *
 * Information lost: micro/nanosecond duration precision.
 */
function dropSubMsec(line: string): string {
  let out = line.replace(/(\d+\.\d{3})\d+/g, "$1");
  // 10+-digit integer epoch-ish counters → first 10 digits.
  out = out.replace(/(?<![\d.])(\d{10})\d+(?![\d.])/g, "$1");
  return out;
}

// ── Cumulative pipeline ──────────────────────────────────────────────

type LineFn = (line: string) => string;

function compose(...fns: LineFn[]): LineFn {
  return (line) => fns.reduce((acc, fn) => fn(acc), line);
}

const TRANSFORMS: { name: string; fn: LineFn }[] = [
  { name: "baseline", fn: (l) => l },
  { name: "normalize_whitespace", fn: normalizeWhitespace },
  {
    name: "round_timestamps_ms",
    fn: compose(normalizeWhitespace, roundTimestampsMs),
  },
  {
    name: "mask_numeric_ids",
    fn: compose(normalizeWhitespace, roundTimestampsMs, maskNumericIds),
  },
  {
    name: "mask_ip_addresses",
    fn: compose(normalizeWhitespace, roundTimestampsMs, maskNumericIds, maskIpAddresses),
  },
  {
    name: "drop_sub_msec",
    fn: compose(
      normalizeWhitespace,
      roundTimestampsMs,
      maskNumericIds,
      maskIpAddresses,
      dropSubMsec
    ),
  },
  {
    name: "canonical_normalize_all",
    fn: compose(
      normalizeWhitespace,
      roundTimestampsMs,
      maskNumericIds,
      maskIpAddresses,
      dropSubMsec
    ),
  },
];

// ── Bonus aggressive transforms ──────────────────────────────────────

/** Replace every line with its Drain template-id (one int per line). */
function templatesOnly(corpus: Corpus): Buffer {
  const drain = new Drain();
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const ids: number[] = [];
  for (const line of lines) {
    const m = drain.matchOrAdd(line);
    ids.push(m.templateId);
  }
  return Buffer.from(`${ids.join("\n")}\n`);
}

/** Keep every Nth line per template-id. Drops 1 - 1/N of the corpus. */
function temporalDownsample(corpus: Corpus, factor: number): Buffer {
  const drain = new Drain();
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const counters = new Map<number, number>();
  const kept: string[] = [];
  for (const line of lines) {
    const m = drain.matchOrAdd(line);
    const c = (counters.get(m.templateId) ?? 0) + 1;
    counters.set(m.templateId, c);
    if (c % factor === 1) kept.push(line);
  }
  return Buffer.from(`${kept.join("\n")}\n`);
}

/**
 * Drop lines whose detected severity is DEBUG/TRACE.
 *
 * Detection is a regex over common severity tokens (case-insensitive).
 * Loghub-2k corpora contain few/no DEBUG lines, so this is essentially
 * a no-op on most corpora — included for completeness.
 */
function severityDropDebug(corpus: Corpus): Buffer {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const re = /\b(DEBUG|TRACE|VERB(?:OSE)?)\b/i;
  const kept = lines.filter((l) => !re.test(l));
  return Buffer.from(`${kept.join("\n")}\n`);
}

// ── Measurement ──────────────────────────────────────────────────────

function applyLineTransform(corpus: Corpus, fn: LineFn): Buffer {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  return Buffer.from(`${lines.map(fn).join("\n")}\n`);
}

function measure(
  corpus: Corpus,
  codecName: string,
  transformedInput: Buffer,
  logCount: number
): CompressionResult {
  const t0 = nowMillis();
  const out = ZSTD_19(transformedInput);
  const t1 = nowMillis();
  return {
    corpus: corpus.name,
    codec: codecName,
    inputBytes: transformedInput.length,
    outputBytes: out.length,
    logCount,
    bytesPerLog: bytesPerLog(out.length, logCount),
    ratioVsRaw: ratioFn(corpus.text.length, out.length),
    ratioVsNdjson: ratioFn(corpus.ndjson.length, out.length),
    encodeMillis: t1 - t0,
  };
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) {
    throw new Error(
      "No corpora present at bench/corpora/loghub-2k/. " +
        "Run `bash bench/scripts/download-loghub.sh` to fetch."
    );
  }
  const compression: CompressionResult[] = [];
  for (const corpus of corpora) {
    // Cumulative line-level transforms.
    for (const t of TRANSFORMS) {
      const buf = applyLineTransform(corpus, t.fn);
      compression.push(measure(corpus, `text_zstd-19_${t.name}`, buf, corpus.count));
    }
    // Bonus aggressive transforms.
    const tplBuf = templatesOnly(corpus);
    compression.push(measure(corpus, "text_zstd-19_templates_only", tplBuf, corpus.count));

    const dsBuf = temporalDownsample(corpus, 5);
    const dsLines = dsBuf
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0).length;
    compression.push(measure(corpus, "text_zstd-19_temporal_downsample_5x", dsBuf, dsLines));

    const dbBuf = severityDropDebug(corpus);
    const dbLines = dbBuf
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0).length;
    compression.push(measure(corpus, "text_zstd-19_severity_drop_debug", dbBuf, dbLines));
  }
  return buildReport("lossy-archive", compression);
}
