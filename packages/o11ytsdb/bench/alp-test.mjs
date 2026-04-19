#!/usr/bin/env node
/**
 * Quick codec comparison — XOR, ALP, XOR+deflate, ALP+deflate.
 * Tests round-trip correctness and compression ratio across data patterns.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

const b = readFileSync(join(pkgDir, "wasm/o11ytsdb-rust.wasm"));
const { instance } = await WebAssembly.instantiate(b, { env: {} });
const w = instance.exports;
const mem = () => new Uint8Array(w.memory.buffer);

const CHUNK = 128;
const patterns = [
  ["constant", (_i) => 42.0],
  ["counter", (i) => i * 1.0],
  ["sine", (i) => Math.sin(i * 0.01) * 100],
  ["random", (_i) => Math.random() * 1000],
  ["step", (i) => Math.floor(i / 100) * 10.0],
  ["pct", (i) => 45.2 + Math.sin(i * 0.1) * 5],
  ["latency_ms", (i) => 12.5 + i * 0.001],
  ["integer", (i) => Math.floor(i * 3.7)],
];

function xorEncode(vals) {
  const n = vals.length;
  w.resetScratch();
  const vp = w.allocScratch(n * 8);
  mem().set(new Uint8Array(vals.buffer, vals.byteOffset, vals.byteLength), vp);
  const op = w.allocScratch(n * 20);
  const bw = w.encodeValues(vp, n, op, n * 20);
  return new Uint8Array(w.memory.buffer.slice(op, op + bw));
}

function xorDecode(buf) {
  w.resetScratch();
  const ip = w.allocScratch(buf.length);
  mem().set(buf, ip);
  const ms = (buf[0] << 8) | buf[1];
  const vp = w.allocScratch(ms * 8);
  const n = w.decodeValues(ip, buf.length, vp, ms);
  return new Float64Array(w.memory.buffer.slice(vp, vp + n * 8));
}

function alpEncode(vals) {
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
  const ms = (buf[0] << 8) | buf[1];
  const vp = w.allocScratch(ms * 8);
  const n = w.decodeValuesALP(ip, buf.length, vp, ms);
  return new Float64Array(w.memory.buffer.slice(vp, vp + n * 8));
}

function deflateWrap(buf) {
  return deflateRawSync(buf, { level: 1 }); // fast compression
}

function inflateWrap(buf) {
  return inflateRawSync(buf);
}

function verify(original, decoded) {
  if (original.length !== decoded.length) return false;
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== decoded[i]) return false;
  }
  return true;
}

console.log("\n  Codec comparison (chunk=128, deflate level=1)\n");
console.log("  Pattern       raw(B/pt) XOR    ALP    XOR+df ALP+df  Best");
console.log(`  ${"─".repeat(65)}`);

let allOk = true;
for (const [name, fn] of patterns) {
  const vals = new Float64Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) vals[i] = fn(i);
  const rawBytes = CHUNK * 8;

  // 4 codec variants
  const xorBuf = xorEncode(vals);
  const alpBuf = alpEncode(vals);
  const xorDefBuf = deflateWrap(xorBuf);
  const alpDefBuf = deflateWrap(alpBuf);

  // Verify all 4 round-trip
  const ok1 = verify(vals, xorDecode(xorBuf));
  const ok2 = verify(vals, alpDecode(alpBuf));
  const ok3 = verify(vals, xorDecode(inflateWrap(xorDefBuf)));
  const ok4 = verify(vals, alpDecode(inflateWrap(alpDefBuf)));
  const ok = ok1 && ok2 && ok3 && ok4;
  allOk = allOk && ok;

  const sizes = [xorBuf.length, alpBuf.length, xorDefBuf.length, alpDefBuf.length];
  const best = Math.min(...sizes);
  const bestName = ["XOR", "ALP", "XOR+df", "ALP+df"][sizes.indexOf(best)];

  console.log(
    `  ${name.padEnd(13)} ${(rawBytes / CHUNK).toFixed(1).padStart(8)}  ` +
      `${(xorBuf.length / CHUNK).toFixed(2).padStart(5)}  ` +
      `${(alpBuf.length / CHUNK).toFixed(2).padStart(5)}  ` +
      `${(xorDefBuf.length / CHUNK).toFixed(2).padStart(5)}  ` +
      `${(alpDefBuf.length / CHUNK).toFixed(2).padStart(5)}  ` +
      `${ok ? "" : "✗ "}${bestName}`
  );
}

console.log("");
if (allOk) {
  console.log("  All 4 codecs round-trip correctly ✓\n");
} else {
  console.log("  ROUND-TRIP FAILURES ✗\n");
  process.exit(1);
}
