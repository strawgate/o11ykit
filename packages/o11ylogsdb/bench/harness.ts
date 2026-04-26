/**
 * o11ylogsdb benchmark harness — minimal viable measurement.
 *
 * Records timing percentiles and per-(corpus, codec) compression
 * results. JSON-serializable for CI regression detection.
 */

export interface CompressionResult {
  corpus: string;
  codec: string;
  inputBytes: number;
  outputBytes: number;
  logCount: number;
  bytesPerLog: number;
  /** Ratio vs raw text (input as plain log lines). */
  ratioVsRaw: number;
  /** Ratio vs raw OTLP/NDJSON (the 20× gate metric in PLAN.md). */
  ratioVsNdjson: number;
  encodeMillis: number;
}

export interface BenchReport {
  module: string;
  timestamp: string;
  commit: string | null;
  node: string;
  compression: CompressionResult[];
}

export function bytesPerLog(outputBytes: number, logCount: number): number {
  return outputBytes / logCount;
}

export function ratio(rawBytes: number, compressedBytes: number): number {
  return rawBytes / compressedBytes;
}

export function nowMillis(): number {
  // process.hrtime.bigint() → ms float
  const ns = process.hrtime.bigint();
  return Number(ns) / 1_000_000;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Render a list of compression results as a markdown table grouped
 * by corpus, with codec rows. Sorted within each corpus by B/log
 * ascending (best first).
 */
export function renderCompressionTable(results: CompressionResult[]): string {
  const corpora = [...new Set(results.map((r) => r.corpus))];
  const lines: string[] = [];
  lines.push("| corpus | codec | input | output | logs | B/log | ×raw | ×ndjson | encode |");
  lines.push("|---|---|--:|--:|--:|--:|--:|--:|--:|");
  for (const corpus of corpora) {
    const rows = results
      .filter((r) => r.corpus === corpus)
      .sort((a, b) => a.bytesPerLog - b.bytesPerLog);
    for (const r of rows) {
      lines.push(
        `| ${r.corpus} | ${r.codec} | ${formatBytes(r.inputBytes)} | ${formatBytes(
          r.outputBytes
        )} | ${r.logCount.toLocaleString()} | ${r.bytesPerLog.toFixed(2)} | ${r.ratioVsRaw.toFixed(2)}× | ${r.ratioVsNdjson.toFixed(2)}× | ${r.encodeMillis.toFixed(0)} ms |`
      );
    }
  }
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

export function buildReport(module: string, compression: CompressionResult[]): BenchReport {
  return {
    module,
    timestamp: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? null,
    node: process.version,
    compression,
  };
}
