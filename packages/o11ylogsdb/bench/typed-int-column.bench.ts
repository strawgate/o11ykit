/**
 * typed-int-column — validates whether typed integer encoding for
 * the per-template `blk_<int>` columns in HDFS actually beats the
 * raw-string-as-ZSTD path measured in Experiment P.
 *
 * Method: for the HDFS-2k corpus, find every template variable slot
 * whose values all match `blk_-?\d+` (the HDFS block-ID shape).
 * For each such slot, compare four codec paths:
 *
 *   1. raw_string_zstd-19   — concatenate raw string values, ZSTD-19.
 *      Reference baseline (matches Experiment P numbers).
 *   2. int64_le_zstd-19     — parse each value as i64, write raw 8-byte
 *      LE per row, ZSTD-19.
 *   3. delta_varint_zstd-19 — first int64 raw, then signed deltas as
 *      ZigZag-varints, ZSTD-19.
 *   4. for_bitpack_zstd-19  — Frame-of-Reference: subtract min(); fixed
 *      bit-width = ceil(log2(max-min+1)); pack into u8 bytes; ZSTD-19.
 *
 * Hypothesis: paths 2-4 substantially beat path 1, validating that
 * per-template variable typing for integer-shaped slots is a real
 * M4 win on HDFS.
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

const BLOCK_ID = /^blk_-?\d+$/;
const SIGNED_INT64 = /^-?\d+$/;

interface IntSlot {
  templateId: number;
  slotIndex: number;
  recordCount: number;
  values: bigint[];
  rawValues: string[];
  shape: "blk_int" | "signed_int";
}

function findIntSlots(corpus: Corpus): IntSlot[] {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const drain = new Drain();
  for (let i = 0; i < lines.length; i++) drain.matchOrAdd(lines[i] as string);
  const templates = new Map<number, string[]>();
  for (const t of drain.templates()) {
    templates.set(
      t.id,
      t.template.split(/\s+/).filter((s) => s.length > 0)
    );
  }

  // Per (tplId, slotIdx): collected values.
  const valuesByKey = new Map<string, { tplId: number; slotIdx: number; values: string[] }>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const tokens = tokenize(line);
    // Re-derive cluster id deterministically by re-matching.
    const m = drain.matchTemplate(line);
    if (!m) continue;
    const tplId = m.templateId;
    const tpl = templates.get(tplId);
    if (!tpl || tpl.length !== tokens.length) continue;
    let slotIdx = 0;
    for (let j = 0; j < tpl.length; j++) {
      if (tpl[j] === PARAM_STR) {
        const key = `${tplId}/${slotIdx}`;
        let entry = valuesByKey.get(key);
        if (!entry) {
          entry = { tplId, slotIdx, values: [] };
          valuesByKey.set(key, entry);
        }
        entry.values.push(tokens[j] as string);
        slotIdx++;
      }
    }
  }

  const out: IntSlot[] = [];
  for (const { tplId, slotIdx, values } of valuesByKey.values()) {
    if (values.length < 50) continue; // skip too-small slots
    let shape: IntSlot["shape"] | undefined;
    if (values.every((v) => BLOCK_ID.test(v))) shape = "blk_int";
    else if (values.every((v) => SIGNED_INT64.test(v))) shape = "signed_int";
    if (!shape) continue;
    const ints = values.map((v) => (shape === "blk_int" ? BigInt(v.slice(4)) : BigInt(v)));
    out.push({
      templateId: tplId,
      slotIndex: slotIdx,
      recordCount: values.length,
      values: ints,
      rawValues: values,
      shape,
    });
  }
  return out;
}

function int64LeBytes(values: bigint[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setBigInt64(i * 8, values[i] as bigint, true);
  }
  return out;
}

function pushZigZagVarint(buf: number[], v: bigint): void {
  // ZigZag for signed: (v << 1) ^ (v >> 63)
  let zz = (v << 1n) ^ (v >> 63n);
  while (zz >= 0x80n) {
    buf.push(Number(zz & 0x7fn) | 0x80);
    zz >>= 7n;
  }
  buf.push(Number(zz));
}

function deltaVarint(values: bigint[]): Uint8Array {
  if (values.length === 0) return new Uint8Array();
  const buf: number[] = [];
  // First value raw int64 LE.
  const first = new Uint8Array(8);
  new DataView(first.buffer).setBigInt64(0, values[0] as bigint, true);
  for (const b of first) buf.push(b);
  let prev = values[0] as bigint;
  for (let i = 1; i < values.length; i++) {
    const delta = (values[i] as bigint) - prev;
    pushZigZagVarint(buf, delta);
    prev = values[i] as bigint;
  }
  return new Uint8Array(buf);
}

function forBitpack(values: bigint[]): Uint8Array {
  if (values.length === 0) return new Uint8Array();
  let min = values[0] as bigint;
  let max = values[0] as bigint;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  let width = 0;
  if (range > 0n) {
    let r = range;
    while (r > 0n) {
      r >>= 1n;
      width++;
    }
  }
  // Header: 8 B min + 1 B width.
  const totalBits = values.length * width;
  const dataLen = Math.ceil(totalBits / 8);
  const out = new Uint8Array(8 + 1 + dataLen);
  new DataView(out.buffer).setBigInt64(0, min, true);
  out[8] = width & 0xff;
  let bitCursor = 0;
  for (const v of values) {
    let residual = v - min;
    for (let b = 0; b < width; b++) {
      const bit = Number(residual & 1n);
      const byteIdx = 9 + (bitCursor >> 3);
      const bitInByte = bitCursor & 7;
      out[byteIdx] = (out[byteIdx] as number) | (bit << bitInByte);
      residual >>= 1n;
      bitCursor++;
    }
  }
  return out;
}

function measure(slot: IntSlot): CompressionResult[] {
  const enc = new TextEncoder();
  const raw = enc.encode(slot.rawValues.join("\n"));
  const rawZstd = zstd19(raw);
  const i64 = int64LeBytes(slot.values);
  const i64Zstd = zstd19(i64);
  const dv = deltaVarint(slot.values);
  const dvZstd = zstd19(dv);
  const fp = forBitpack(slot.values);
  const fpZstd = zstd19(fp);

  const slotKey = `tpl${slot.templateId}/slot${slot.slotIndex}/${slot.shape}/n${slot.recordCount}`;
  const make = (codec: string, out: Uint8Array): CompressionResult => ({
    corpus: "HDFS-slot",
    codec: `${slotKey}/${codec}`,
    inputBytes: raw.length,
    outputBytes: out.length,
    logCount: slot.recordCount,
    bytesPerLog: bytesPerLog(out.length, slot.recordCount),
    ratioVsRaw: ratioFn(raw.length, out.length),
    ratioVsNdjson: ratioFn(raw.length, out.length),
    encodeMillis: 0,
  });

  return [
    make("raw_string_zstd-19", rawZstd),
    make("int64_le_zstd-19", i64Zstd),
    make("delta_varint_zstd-19", dvZstd),
    make("for_bitpack_zstd-19", fpZstd),
  ];
}

export default async function run() {
  const corpora = loadAllAvailable("2k");
  const hdfs = corpora.find((c) => c.name === "HDFS");
  if (!hdfs) throw new Error("HDFS-2k corpus not present.");

  const t0 = nowMillis();
  const slots = findIntSlots(hdfs);
  const t1 = nowMillis();

  process.stderr.write(
    `  HDFS: found ${slots.length} integer-shaped slots (>= 50 records each, ${(t1 - t0).toFixed(0)} ms)\n`
  );

  const compression: CompressionResult[] = [];
  for (const slot of slots) {
    compression.push(...measure(slot));
  }
  return buildReport("typed-int-column", compression);
}
