/**
 * byte-decomposition — break down where the bytes go in a corpus
 * after Drain templating, to inform M4 per-column codec
 * specialization priorities.
 *
 * For each Loghub-2k corpus:
 *   1. Run Drain to extract templates.
 *   2. For each record, identify which template it matched and what
 *      its variable values are.
 *   3. Per template: count records, count variable slots, and measure
 *      the bytes contributed by each variable position (raw + ZSTD-19
 *      compressed in isolation).
 *   4. Identify the top-3 highest-cost variable positions per corpus.
 *
 * The hypothesis: for HDFS / BGL / OpenStack (which are stuck at
 * 22+ B/log in `engine_columnar_zstd-19`), one or two variable
 * positions dominate the bytes — the per-line block IDs, IP:port
 * tuples, embedded timestamps. Identifying them tells us where
 * codec specialization (FoR+bitpack for monotonic block IDs, dict
 * for IP:port, delta-encoding for embedded timestamps) would yield
 * the most leverage.
 *
 * Output: per-template + per-slot stats. Ordinary CompressionResult
 * shape; the "codec" field encodes the slot identifier so the bench
 * harness JSON output stays usable.
 */

import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { Drain, PARAM_STR, tokenize } from "../dist/index.js";
import { type Corpus, loadAllAvailable } from "./corpora.js";
import {
  buildReport,
  bytesPerLog,
  type CompressionResult,
  nowMillis,
  ratio as ratioFn,
} from "./harness.js";

const zstd19 = (b: Uint8Array): Buffer =>
  zstdCompressSync(b, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
  });

interface SlotStats {
  templateId: number;
  templateText: string;
  templateRecordCount: number;
  slotIndex: number;
  cardinality: number;
  totalRawBytes: number;
  zstdBytes: number;
  /** A short example of values in this slot. */
  exampleValues: string[];
}

function decomposeCorpus(corpus: Corpus): SlotStats[] {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const drain = new Drain();

  // Pass 1: ingest all records into Drain so templates are stable.
  const tplIds: number[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    tplIds[i] = drain.matchOrAdd(lines[i] as string).templateId;
  }

  // Snapshot templates.
  const templatesById = new Map<number, string[]>();
  for (const t of drain.templates()) {
    templatesById.set(
      t.id,
      t.template.split(/\s+/).filter((s) => s.length > 0)
    );
  }

  // Pass 2: for each (template, slot), collect the per-record values.
  // Map<template_id, Map<slot_index, string[]>>
  const slotsByTemplate = new Map<number, Map<number, string[]>>();
  const recordCount = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const tplId = tplIds[i] as number;
    const template = templatesById.get(tplId);
    if (!template) continue;
    const tokens = tokenize(lines[i] as string);
    if (tokens.length !== template.length) continue;
    recordCount.set(tplId, (recordCount.get(tplId) ?? 0) + 1);
    let slotsMap = slotsByTemplate.get(tplId);
    if (!slotsMap) {
      slotsMap = new Map();
      slotsByTemplate.set(tplId, slotsMap);
    }
    let slotIdx = 0;
    for (let j = 0; j < template.length; j++) {
      if (template[j] === PARAM_STR) {
        let arr = slotsMap.get(slotIdx);
        if (!arr) {
          arr = [];
          slotsMap.set(slotIdx, arr);
        }
        arr.push(tokens[j] as string);
        slotIdx++;
      }
    }
  }

  // Compute per-slot stats.
  const out: SlotStats[] = [];
  const enc = new TextEncoder();
  for (const [tplId, slotsMap] of slotsByTemplate) {
    const template = templatesById.get(tplId) as string[];
    const templateText = template.join(" ");
    const recCount = recordCount.get(tplId) ?? 0;
    for (const [slotIdx, values] of slotsMap) {
      const concat = values.join("\n");
      const raw = enc.encode(concat);
      const zstd = zstd19(raw);
      const distinct = new Set(values);
      out.push({
        templateId: tplId,
        templateText,
        templateRecordCount: recCount,
        slotIndex: slotIdx,
        cardinality: distinct.size,
        totalRawBytes: raw.length,
        zstdBytes: zstd.length,
        exampleValues: [...distinct].slice(0, 3),
      });
    }
  }

  // Sort by zstd bytes descending — biggest costs first.
  out.sort((a, b) => b.zstdBytes - a.zstdBytes);
  return out;
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) throw new Error("No corpora present at bench/corpora/loghub-2k/.");
  const compression: CompressionResult[] = [];

  for (const corpus of corpora) {
    const t0 = nowMillis();
    const stats = decomposeCorpus(corpus);
    const t1 = nowMillis();
    // Take the top 5 most expensive slots per corpus.
    const topN = Math.min(5, stats.length);
    for (let i = 0; i < topN; i++) {
      const s = stats[i] as SlotStats;
      const codecLabel = `tpl${s.templateId}/slot${s.slotIndex}/card${s.cardinality}/n${s.templateRecordCount}`;
      compression.push({
        corpus: corpus.name,
        codec: codecLabel,
        inputBytes: s.totalRawBytes,
        outputBytes: s.zstdBytes,
        logCount: s.templateRecordCount,
        bytesPerLog: bytesPerLog(s.zstdBytes, s.templateRecordCount),
        ratioVsRaw: ratioFn(s.totalRawBytes, s.zstdBytes),
        ratioVsNdjson: ratioFn(s.totalRawBytes, s.zstdBytes),
        encodeMillis: i === 0 ? t1 - t0 : 0,
      });
      // Print example values to stderr for visibility.
      process.stderr.write(
        `  ${corpus.name} tpl=${s.templateId} slot=${s.slotIndex} card=${s.cardinality} ` +
          `n=${s.templateRecordCount} raw=${s.totalRawBytes} zstd=${s.zstdBytes} ` +
          `bpl=${(s.zstdBytes / s.templateRecordCount).toFixed(2)}\n` +
          `    examples: ${s.exampleValues.map((v) => JSON.stringify(v.slice(0, 60))).join(", ")}\n`
      );
    }
  }

  return buildReport("byte-decomposition", compression);
}
