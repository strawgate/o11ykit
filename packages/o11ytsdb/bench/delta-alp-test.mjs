#!/usr/bin/env node
/**
 * Delta-ALP codec test — verify round-trip and measure compression
 * improvement for monotonic counter patterns.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

const b = readFileSync(join(pkgDir, "wasm/o11ytsdb-rust.wasm"));
const { instance } = await WebAssembly.instantiate(b, { env: {} });
const w = instance.exports;
const mem = () => new Uint8Array(w.memory.buffer);

const CHUNK = 640;

// ── Helpers ──

function alpEncodeWithStats(vals) {
  const n = vals.length;
  w.resetScratch();
  const vp = w.allocScratch(n * 8);
  mem().set(new Uint8Array(vals.buffer, vals.byteOffset, vals.byteLength), vp);
  const op = w.allocScratch(n * 20);
  const sp = w.allocScratch(8 * 8); // 8 stats
  const bw = w.encodeValuesALPWithStats(vp, n, op, n * 20, sp);
  const compressed = new Uint8Array(w.memory.buffer.slice(op, op + bw));
  const stats = new Float64Array(w.memory.buffer.slice(sp, sp + 64));
  return { compressed, stats };
}

function alpEncodePlain(vals) {
  const n = vals.length;
  w.resetScratch();
  const vp = w.allocScratch(n * 8);
  mem().set(new Uint8Array(vals.buffer, vals.byteOffset, vals.byteLength), vp);
  const op = w.allocScratch(n * 20);
  const bw = w.encodeValuesALP(vp, n, op, n * 20);
  return new Uint8Array(w.memory.buffer.slice(op, op + bw));
}

function alpDecode(buf) {
  w.resetScratch();
  const ip = w.allocScratch(buf.length);
  mem().set(buf, ip);
  const vp = w.allocScratch(CHUNK * 8);
  const n = w.decodeValuesALP(ip, buf.length, vp, CHUNK);
  return new Float64Array(w.memory.buffer.slice(vp, vp + n * 8));
}

function verify(original, decoded) {
  if (original.length !== decoded.length) {
    console.log(`  length mismatch: ${original.length} vs ${decoded.length}`);
    return false;
  }
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== decoded[i]) {
      console.log(`  mismatch at [${i}]: ${original[i]} vs ${decoded[i]}`);
      return false;
    }
  }
  return true;
}

// ── Seeded RNG (same as vectors.ts) ──

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
    const result = Math.imul(this.rotl(Math.imul(s[0], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = this.rotl(s[3], 11);
    return result / 0x100000000;
  }
  rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
  int(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
}

// ── Test patterns ──

const rng = new Rng(42);

const patterns = [
  // Monotonic counter (should trigger delta-ALP)
  (() => {
    const vals = new Float64Array(CHUNK);
    let v = 1_000_000;
    for (let i = 0; i < CHUNK; i++) { v += rng.int(10, 200); vals[i] = v; }
    return { name: "monotonicCounter", vals };
  })(),
  // Counter with 40% idle (same as engine.bench pattern)
  (() => {
    const r2 = new Rng(123);
    const vals = new Float64Array(CHUNK);
    let counter = 5000;
    for (let i = 0; i < CHUNK; i++) {
      const idle = r2.next() < 0.4;
      if (!idle) counter += Math.floor(r2.next() * 10) + 1;
      vals[i] = counter;
    }
    return { name: "counterWith40%Idle", vals };
  })(),
  // Constant (should NOT trigger delta-ALP)
  (() => {
    const vals = new Float64Array(CHUNK);
    for (let i = 0; i < CHUNK; i++) vals[i] = 42.0;
    return { name: "constant", vals };
  })(),
  // Slow gauge (has resets, should NOT trigger delta-ALP)
  (() => {
    const r2 = new Rng(99);
    const vals = new Float64Array(CHUNK);
    let v = 45.0;
    for (let i = 0; i < CHUNK; i++) {
      v += (r2.next() - 0.5) * 2;
      v = Math.max(0, Math.min(100, v));
      vals[i] = Math.round(v * 100) / 100;
    }
    return { name: "slowGauge", vals };
  })(),
  // High entropy (should NOT trigger delta-ALP)
  (() => {
    const r2 = new Rng(77);
    const vals = new Float64Array(CHUNK);
    for (let i = 0; i < CHUNK; i++) vals[i] = r2.next() * 1e6;
    return { name: "highEntropy", vals };
  })(),
];

// ── Run tests ──

console.log(`\n  Delta-ALP codec test (chunk=${CHUNK})\n`);
console.log(
  "  Pattern              plainALP  deltaALP  ratio  tag  roundTrip"
);
console.log("  " + "─".repeat(70));

let allOk = true;
for (const { name, vals } of patterns) {
  // Plain ALP (no stats, no delta detection)
  const plainBuf = alpEncodePlain(vals);

  // ALP with stats (triggers delta-ALP detection)
  const { compressed: statsBuf, stats } = alpEncodeWithStats(vals);

  // Check if delta-ALP was used: first byte == 0xDA
  const isDelta = statsBuf[0] === 0xDA;

  // Decode the stats-encoded blob
  const decoded = alpDecode(statsBuf);
  const ok = verify(vals, decoded);
  allOk = allOk && ok;

  // Also verify plain ALP still decodes
  const decodedPlain = alpDecode(plainBuf);
  const okPlain = verify(vals, decodedPlain);
  allOk = allOk && okPlain;

  const ratio = plainBuf.length / statsBuf.length;

  console.log(
    `  ${name.padEnd(22)}` +
    `${String(plainBuf.length).padStart(6)} B  ` +
    `${String(statsBuf.length).padStart(6)} B  ` +
    `${ratio.toFixed(2).padStart(5)}x  ` +
    `${isDelta ? "δALP" : " ALP"}  ` +
    `${ok && okPlain ? "✓" : "✗ FAIL"}`
  );
}

console.log("");
if (allOk) {
  console.log("  All patterns round-trip correctly ✓\n");
} else {
  console.log("  ROUND-TRIP FAILURES ✗\n");
  process.exit(1);
}
