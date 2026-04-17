#!/usr/bin/env node
/**
 * Diagnostic: dump ALP chunk internals and audit storage byte breakdown.
 *
 * For each of the 10 benchmark patterns, encodes one chunk (640 samples)
 * and parses the binary layout to show exactly where bytes go:
 *
 *   ALP values chunk:
 *     header (14 B): count, exponent, bit_width, min_int, exc_count
 *     FoR payload:   ⌈count × bw / 8⌉ bytes
 *     exc positions: exc_count × 2 bytes (omitted when exc_count == count)
 *     exc FoR-u64:   8 (min_u64) + 1 (exc_bw) + ⌈exc_count × exc_bw / 8⌉
 *
 *   Timestamp chunk:
 *     delta-of-delta Gorilla encoding (bit-level, variable width)
 *
 * Usage:
 *   node bench/diag-chunks.mjs [pattern-name]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');

// ── Load WASM ────────────────────────────────────────────────────────

const wasmBytes = readFileSync(join(pkgDir, 'wasm/o11ytsdb-rust.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
const w = instance.exports;
const mem = () => new Uint8Array(w.memory.buffer);

function encodeALP(values) {
  const n = values.length;
  w.resetScratch();
  const vp = w.allocScratch(n * 8);
  const oc = n * 20;
  const op = w.allocScratch(oc);
  mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), vp);
  const bw = w.encodeValuesALP(vp, n, op, oc);
  return new Uint8Array(w.memory.buffer.slice(op, op + bw));
}

function encodeTimestamps(ts) {
  const n = ts.length;
  w.resetScratch();
  const tp = w.allocScratch(n * 8);
  const oc = n * 20;
  const op = w.allocScratch(oc);
  mem().set(new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength), tp);
  const bw = w.encodeTimestamps(tp, n, op, oc);
  return new Uint8Array(w.memory.buffer.slice(op, op + bw));
}

// ── Parse ALP chunk header ───────────────────────────────────────────

function parseALPChunk(buf) {
  let pos = 0;

  // Header (14 bytes).
  const count = (buf[pos] << 8) | buf[pos + 1]; pos += 2;
  const exponent = buf[pos]; pos += 1;
  const bitWidth = buf[pos]; pos += 1;

  // min_int as i64 BE.
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const minInt = dv.getBigInt64(pos); pos += 8;

  const excCount = (buf[pos] << 8) | buf[pos + 1]; pos += 2;

  const headerBytes = 14;

  // FoR payload: ⌈count × bitWidth / 8⌉.
  const forPayloadBytes = Math.ceil(count * bitWidth / 8);
  pos += forPayloadBytes;

  // Exception positions.
  let excPosBytes = 0;
  if (excCount > 0 && excCount < count) {
    excPosBytes = excCount * 2;
    pos += excPosBytes;
  }

  // Exception FoR-u64 block.
  let excMinU64 = 0n;
  let excBitWidth = 0;
  let excForBytes = 0;
  if (excCount > 0) {
    excMinU64 = dv.getBigUint64(pos); pos += 8;
    excBitWidth = buf[pos]; pos += 1;
    const excPayload = Math.ceil(excCount * excBitWidth / 8);
    excForBytes = 8 + 1 + excPayload;
    pos += excPayload;
  }

  return {
    totalBytes: buf.length,
    count,
    exponent,
    bitWidth,
    minInt,
    excCount,
    headerBytes,
    forPayloadBytes,
    excPosBytes,
    excForBytes,
    excBitWidth,
    parsedBytes: pos,
    // Derived.
    excPct: (excCount / count * 100).toFixed(1),
    bPerPt: (buf.length / count).toFixed(3),
  };
}

// ── Data generators (inline, matching vectors.ts) ────────────────────
// NOTE: Generators below mirror packages/o11ytsdb/bench/vectors.ts.
// Keep in sync when modifying patterns.

class Rng {
  constructor(seed = 42) {
    this.s = new Uint32Array(4);
    this.s[0] = seed;
    this.s[1] = seed ^ 0x6c078965;
    this.s[2] = seed ^ 0xdeadbeef;
    this.s[3] = seed ^ 0x01234567;
    for (let i = 0; i < 16; i++) this.next();
  }
  next() {
    const s = this.s;
    const result = (Math.imul(this.rotl(Math.imul(s[0], 5), 7), 9) >>> 0);
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
    s[3] = this.rotl(s[3], 11);
    return result / 0x100000000;
  }
  rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
  int(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  gaussian(mean, std) {
    const u1 = this.next() || 1e-10;
    const u2 = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

function makeTimes(n, t0 = 1_700_000_000_000n) {
  const ts = new BigInt64Array(n);
  for (let i = 0; i < n; i++) ts[i] = t0 + BigInt(i) * 15_000n;
  return ts;
}

const N = 640;

const generators = {
  constant_gauge: () => {
    const v = new Float64Array(N);
    for (let i = 0; i < N; i++) v[i] = 42.0;
    return { ts: makeTimes(N), values: v };
  },
  counter_small: () => {
    const rng = new Rng(42);
    const v = new Float64Array(N);
    let c = Math.floor(rng.next() * 10000);
    for (let i = 0; i < N; i++) {
      if (rng.next() >= 0.4) c += Math.floor(rng.next() * 10) + 1;
      v[i] = c;
    }
    return { ts: makeTimes(N), values: v };
  },
  counter_large: () => {
    const rng = new Rng(42);
    const v = new Float64Array(N);
    let c = Math.floor(rng.next() * 1e10) + 1e10;
    for (let i = 0; i < N; i++) {
      if (rng.next() >= 0.3) c += Math.floor(rng.next() * 100000) + 1;
      v[i] = c;
    }
    return { ts: makeTimes(N), values: v };
  },
  gauge_2dp: () => {
    const rng = new Rng(42);
    const v = new Float64Array(N);
    let val = Math.round(rng.next() * 10000) / 100;
    for (let i = 0; i < N; i++) {
      val += rng.gaussian(0, 0.05); val = Math.max(0, val);
      v[i] = Math.round(val * 100) / 100;
    }
    return { ts: makeTimes(N), values: v };
  },
  gauge_3dp: () => {
    const rng = new Rng(42);
    const v = new Float64Array(N);
    let val = rng.next() * 500;
    for (let i = 0; i < N; i++) {
      val += rng.gaussian(0, 0.02); val = Math.max(0, val);
      v[i] = Math.round(val * 1000) / 1000;
    }
    return { ts: makeTimes(N), values: v };
  },
  gauge_11dp: () => {
    const rng = new Rng(42);
    const v = new Float64Array(N);
    let base = rng.next() * 0.5 + 0.05;
    for (let i = 0; i < N; i++) {
      base += rng.gaussian(0, 0.0001);
      base = Math.max(0, Math.min(1, base));
      v[i] = Math.round(base * 1e11) / 1e11;
    }
    return { ts: makeTimes(N), values: v };
  },
  gauge_12dp: () => {
    const rng = new Rng(42);
    const v = new Float64Array(N);
    let base = rng.next() * 0.4 + 0.1;
    for (let i = 0; i < N; i++) {
      base += rng.gaussian(0, 0.000001);
      base = Math.max(0, Math.min(1, base));
      v[i] = Math.round(base * 1e12) / 1e12;
    }
    return { ts: makeTimes(N), values: v };
  },
  hi_prec_ratio_a: () => {
    const rng = new Rng(42);
    const v = new Float64Array(N);
    let ticks = Math.floor(rng.next() * 1e6);
    let total = Math.floor(1e7 + rng.next() * 1e6);
    for (let i = 0; i < N; i++) {
      ticks += Math.floor(rng.next() * 200) + 1;
      total += 1000;
      v[i] = ticks / total;
    }
    return { ts: makeTimes(N), values: v };
  },
  hi_prec_ratio_b: () => {
    const rng = new Rng(99);
    const v = new Float64Array(N);
    let ticks = Math.floor(rng.next() * 1e6);
    let total = Math.floor(1e7 + rng.next() * 1e6);
    for (let i = 0; i < N; i++) {
      ticks += Math.floor(rng.next() * 200) + 1;
      total += 1000;
      v[i] = ticks / total;
    }
    return { ts: makeTimes(N), values: v };
  },
  high_var_gauge: () => {
    const rng = new Rng(42);
    const v = new Float64Array(N);
    let val = rng.next() * 100;
    for (let i = 0; i < N; i++) {
      val += rng.gaussian(0, 0.5); val = Math.max(0, val);
      v[i] = Math.round(val * 100) / 100;
    }
    return { ts: makeTimes(N), values: v };
  },
};

// ── Main ─────────────────────────────────────────────────────────────

const filter = process.argv[2];

console.log(`\n  ╔══════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`  ║  ALP Chunk Audit — ${N} samples/chunk, 15s intervals                                ║`);
console.log(`  ╚══════════════════════════════════════════════════════════════════════════════════════╝\n`);

// ── Per-pattern table ──

const hdr = [
  'Pattern'.padEnd(20),
  'Total'.padStart(7),
  'B/pt'.padStart(7),
  'Exp'.padStart(4),
  'BW'.padStart(4),
  'Hdr'.padStart(5),
  'FoR'.padStart(6),
  'Exc#'.padStart(6),
  'Exc%'.padStart(6),
  'ExcPos'.padStart(7),
  'ExcFoR'.padStart(7),
  'ExcBW'.padStart(6),
  'TsBytes'.padStart(8),
  'TsB/pt'.padStart(7),
  'All B/pt'.padStart(9),
].join('  ');
console.log(`  ${hdr}`);
console.log(`  ${'─'.repeat(hdr.length)}`);

let totalValBytes = 0;
let totalTsBytes = 0;
let totalSamples = 0;

for (const [name, gen] of Object.entries(generators)) {
  if (filter && !name.includes(filter)) continue;

  const { ts, values } = gen();
  const valBuf = encodeALP(values);
  const tsBuf = encodeTimestamps(ts);
  const parsed = parseALPChunk(valBuf);

  totalValBytes += valBuf.length;
  totalTsBytes += tsBuf.length;
  totalSamples += N;

  const allBpt = ((valBuf.length + tsBuf.length) / N).toFixed(3);

  const line = [
    name.padEnd(20),
    String(valBuf.length).padStart(7),
    parsed.bPerPt.padStart(7),
    String(parsed.exponent).padStart(4),
    String(parsed.bitWidth).padStart(4),
    String(parsed.headerBytes).padStart(5),
    String(parsed.forPayloadBytes).padStart(6),
    String(parsed.excCount).padStart(6),
    (parsed.excPct + '%').padStart(6),
    String(parsed.excPosBytes).padStart(7),
    String(parsed.excForBytes).padStart(7),
    String(parsed.excBitWidth).padStart(6),
    String(tsBuf.length).padStart(8),
    (tsBuf.length / N).toFixed(3).padStart(7),
    allBpt.padStart(9),
  ].join('  ');
  console.log(`  ${line}`);
}

console.log();
console.log(`  Total values: ${totalValBytes} bytes (${(totalValBytes / totalSamples).toFixed(3)} B/pt)`);
console.log(`  Total timestamps: ${totalTsBytes} bytes (${(totalTsBytes / totalSamples).toFixed(3)} B/pt)`);
console.log(`  Combined: ${totalValBytes + totalTsBytes} bytes (${((totalValBytes + totalTsBytes) / totalSamples).toFixed(3)} B/pt)`);

// ── Detailed per-pattern dump (when filter is set) ──

if (filter) {
  for (const [name, gen] of Object.entries(generators)) {
    if (!name.includes(filter)) continue;

    const { ts, values } = gen();
    const valBuf = encodeALP(values);
    const tsBuf = encodeTimestamps(ts);
    const p = parseALPChunk(valBuf);

    console.log(`\n  ── ${name} detailed ──\n`);
    console.log(`  Values chunk: ${valBuf.length} bytes (${p.bPerPt} B/pt)`);
    console.log(`    Header:          14 bytes`);
    console.log(`      count:         ${p.count}`);
    console.log(`      exponent:      ${p.exponent}  (×10^${p.exponent})`);
    console.log(`      bit_width:     ${p.bitWidth}  (FoR offsets from min_int)`);
    console.log(`      min_int:       ${p.minInt}`);
    console.log(`      exc_count:     ${p.excCount}  (${p.excPct}% of ${p.count})`);
    console.log(`    FoR payload:     ${p.forPayloadBytes} bytes  (${p.count} × ${p.bitWidth} bits)`);
    if (p.excCount > 0) {
      console.log(`    Exc positions:   ${p.excPosBytes} bytes  (${p.excCount} × 2 bytes)${p.excCount === p.count ? '  [omitted: all exceptions]' : ''}`);
      console.log(`    Exc FoR-u64:     ${p.excForBytes} bytes  (8B min + 1B bw + ⌈${p.excCount} × ${p.excBitWidth} / 8⌉)`);
      console.log(`      exc_bit_width: ${p.excBitWidth}`);
    }
    console.log(`    Parsed:          ${p.parsedBytes} bytes  ${p.parsedBytes === p.totalBytes ? '✓ matches total' : `✗ mismatch (total=${p.totalBytes})`}`);

    console.log(`\n  Timestamp chunk: ${tsBuf.length} bytes (${(tsBuf.length / N).toFixed(3)} B/pt)`);
    console.log(`    Encoding: delta-of-delta Gorilla`);

    // Sample values.
    console.log(`\n  First 5 values: ${Array.from(values.slice(0, 5)).map(v => v.toPrecision(15)).join(', ')}`);
    console.log(`  Last  5 values: ${Array.from(values.slice(-5)).map(v => v.toPrecision(15)).join(', ')}`);

    // Byte breakdown pie.
    const total = valBuf.length + tsBuf.length;
    const bar = (n, label) => {
      const pct = (n / total * 100).toFixed(1);
      const width = Math.round(n / total * 40);
      return `    ${'█'.repeat(width)}${'░'.repeat(40 - width)}  ${String(n).padStart(5)} B  ${pct.padStart(5)}%  ${label}`;
    };
    console.log(`\n  Byte breakdown (${total} total):`);
    console.log(bar(p.headerBytes, 'header'));
    console.log(bar(p.forPayloadBytes, 'FoR values'));
    if (p.excPosBytes > 0) console.log(bar(p.excPosBytes, 'exc positions'));
    if (p.excForBytes > 0) console.log(bar(p.excForBytes, 'exc FoR-u64'));
    console.log(bar(tsBuf.length, 'timestamps'));
  }
}

console.log();
