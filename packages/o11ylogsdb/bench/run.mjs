#!/usr/bin/env node
/**
 * o11ylogsdb benchmark runner.
 *
 * Usage:
 *   node bench/run.mjs                      # run all maintained benches
 *   node bench/run.mjs bytes-per-log        # run one
 *   node bench/run.mjs --markdown           # print markdown table
 *   node bench/run.mjs --json results.json  # write JSON to path
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(__dirname, "results");
if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

const args = process.argv.slice(2);
const moduleArg = args.find((a) => !a.startsWith("--"));
const wantMarkdown = args.includes("--markdown");
const jsonIdx = args.indexOf("--json");
const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;

const modules = {
  "bytes-per-log": "../dist-bench/bytes-per-log.bench.js",
  "per-stream-chunking": "../dist-bench/per-stream-chunking.bench.js",
  "pino-roundtrip": "../dist-bench/pino-roundtrip.bench.js",
  "engine-roundtrip": "../dist-bench/engine-roundtrip.bench.js",
  "engine-drain": "../dist-bench/engine-drain.bench.js",
  "engine-columnar": "../dist-bench/engine-columnar.bench.js",
  "per-stream-drain": "../dist-bench/per-stream-drain.bench.js",
  "hierarchical-drain": "../dist-bench/hierarchical-drain.bench.js",
  "cross-chunk-dict": "../dist-bench/cross-chunk-dict.bench.js",
  "per-column-zstd": "../dist-bench/per-column-zstd.bench.js",
  "byte-decomposition": "../dist-bench/byte-decomposition.bench.js",
  "lossy-archive": "../dist-bench/lossy-archive.bench.js",
  "typed-int-column": "../dist-bench/typed-int-column.bench.js",
  "ngram-bloom": "../dist-bench/ngram-bloom.bench.js",
  "token-postings": "../dist-bench/token-postings.bench.js",
  "zstd-level-asymmetry": "../dist-bench/zstd-level-asymmetry.bench.js",
  "engine-tiered": "../dist-bench/engine-tiered.bench.js",
  "engine-typed": "../dist-bench/engine-typed.bench.js",
  "profile-policies": "../dist-bench/profile-policies.bench.js",
  "query-latency": "../dist-bench/query-latency.bench.js",
  "sustained-ingest": "../dist-bench/sustained-ingest.bench.js",
  "query-at-scale": "../dist-bench/query-at-scale.bench.js",
  "multi-stream": "../dist-bench/multi-stream.bench.js",
  "append-latency": "../dist-bench/append-latency.bench.js",
  "drain-churn": "../dist-bench/drain-churn.bench.js",
  compaction: "../dist-bench/compaction.bench.js",
  "pino-query": "../dist-bench/pino-query.bench.js",
  "comprehensive-storage": "../dist-bench/comprehensive-storage.bench.js",
  "comprehensive-query": "../dist-bench/comprehensive-query.bench.js",
  "ingest-throughput": "../dist-bench/ingest-throughput.bench.js",
};

const harnessImport = await import("../dist-bench/harness.js");
const profileImport = await import("../dist-bench/profile-harness.js");

const reports = [];
for (const [name, path] of Object.entries(modules)) {
  if (moduleArg && name !== moduleArg) continue;
  const mod = await import(path);
  console.log(`\n→ Running ${name}…`);
  const report = await mod.default();
  reports.push(report);

  // Profile reports carry `results` with `timing` field per row;
  // compression reports carry `compression`; sustained-ingest reports
  // carry `results` with `throughput` field (no timing/codec/etc).
  // Branch on shape.
  const isProfileReport = Array.isArray(report.results) && report.results[0]?.timing !== undefined;
  const isCompressionReport = Array.isArray(report.compression);

  if (wantMarkdown) {
    if (isProfileReport) {
      console.log(profileImport.renderProfileTable(report.results));
    } else if (isCompressionReport) {
      console.log(harnessImport.renderCompressionTable(report.compression));
    } else {
      // Untyped report (sustained-ingest, etc.) — bench writes its
      // own stderr-formatted summary; runner just persists JSON.
      console.log("(see stderr for human-readable summary)");
    }
  } else if (isProfileReport) {
    for (const r of report.results) {
      console.log(
        `  ${r.corpus.padEnd(11)} ${r.codec.padEnd(28)} ${r.bytesPerLog
          .toFixed(2)
          .padStart(
            8
          )} B/log  p50=${r.timing.p50.toFixed(1)}ms  p99=${r.timing.p99.toFixed(1)}ms  heapΔ=${formatDelta(r.memory.heapDeltaBytes)}  arrΔ=${formatDelta(r.memory.arrayBufferDeltaBytes)}`
      );
    }
  } else if (isCompressionReport) {
    for (const r of report.compression) {
      console.log(
        `  ${r.corpus.padEnd(11)} ${r.codec.padEnd(22)} ${r.bytesPerLog
          .toFixed(2)
          .padStart(
            8
          )} B/log  ${r.ratioVsRaw.toFixed(2)}× vs raw  ${r.ratioVsNdjson.toFixed(2)}× vs ndjson`
      );
    }
  }

  // Always write a timestamped JSON to bench/results/.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(resultsDir, `${name}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`  → ${outPath}`);
}

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(reports, null, 2));
}

console.log("\ndone.");

function formatDelta(bytes) {
  const sign = bytes < 0 ? "-" : "+";
  const abs = Math.abs(bytes);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}MB`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}KB`;
  return `${sign}${abs}B`;
}
