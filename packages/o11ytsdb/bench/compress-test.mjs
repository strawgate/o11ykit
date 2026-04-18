#!/usr/bin/env node
/**
 * Secondary compression experiment — measures what happens when we layer
 * deflate, zstd, or brotli on top of ALP/XOR codec output.
 *
 * Tests:
 *   1. ALP alone (baseline)
 *   2. ALP + deflate per-chunk (level 1, 6)
 *   3. ALP + zstd per-chunk (level 1, 3, 6)
 *   4. ALP + zstd multi-chunk (group 4, 8, 16 chunks → one blob)
 *   5. Raw float64 + zstd (no ALP, just zstd on raw bytes)
 *   6. Raw float64 + deflate
 *   7. XOR alone vs XOR + zstd
 *
 * Reports: B/pt, encode µs/chunk, decode µs/chunk, total encode/decode time.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  constants,
  deflateRawSync,
  inflateRawSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// ── Config ───────────────────────────────────────────────────────────

const CHUNK_SIZE = 512;
const NUM_CHUNKS = 200; // 200 chunks of 512 = 102,400 samples per pattern

// Data patterns — realistic infrastructure metrics.
// Counters use variable increments (like real HTTP req counts, bytes_sent).
// Gauges use realistic ranges and noise.
let _counterVal = 0;
let _gaugeVal = 50;
const PATTERNS = {
  constant: (_i) => 42.0,
  counter: (_i) => {
    _counterVal += 1 + Math.floor(Math.random() * 10);
    return _counterVal;
  },
  gauge_cpu: (_i) => {
    _gaugeVal += (Math.random() - 0.48) * 5;
    _gaugeVal = Math.max(0, Math.min(100, _gaugeVal));
    return Math.round(_gaugeVal * 100) / 100;
  },
  sine: (i) => Math.sin(i * 0.01) * 100,
  random: (_i) => Math.random() * 1000,
  step: (i) => Math.floor(i / 100) * 10.0,
  latency_ms: (_i) => Math.round(Math.random() * 500 * 100) / 100,
  req_rate: (i) => Math.max(0, 1000 + Math.sin(i * 0.001) * 200 + (Math.random() - 0.5) * 100), // ~1000 rps with daily wave + noise
};

// ── WASM loader ──────────────────────────────────────────────────────

async function loadWasm() {
  const wasmBytes = readFileSync(join(pkgDir, "wasm/o11ytsdb-rust.wasm"));
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
  const w = instance.exports;
  const mem = () => new Uint8Array(w.memory.buffer);

  return {
    encodeALP(values) {
      const n = values.length;
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytesWritten = w.encodeValuesALP(valPtr, n, outPtr, outCap);
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + bytesWritten));
    },
    decodeALP(buf) {
      w.resetScratch();
      const inPtr = w.allocScratch(buf.length);
      mem().set(buf, inPtr);
      const maxSamples = (buf[0] << 8) | buf[1];
      const valPtr = w.allocScratch(maxSamples * 8);
      const n = w.decodeValuesALP(inPtr, buf.length, valPtr, maxSamples);
      return new Float64Array(w.memory.buffer.slice(valPtr, valPtr + n * 8));
    },
    encodeXOR(values) {
      const n = values.length;
      w.resetScratch();
      const valPtr = w.allocScratch(n * 8);
      const outCap = n * 20;
      const outPtr = w.allocScratch(outCap);
      mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
      const bytesWritten = w.encodeValues(valPtr, n, outPtr, outCap);
      return new Uint8Array(w.memory.buffer.slice(outPtr, outPtr + bytesWritten));
    },
    decodeXOR(buf) {
      w.resetScratch();
      const inPtr = w.allocScratch(buf.length);
      mem().set(buf, inPtr);
      const maxSamples = (buf[0] << 8) | buf[1];
      const valPtr = w.allocScratch(maxSamples * 8);
      const n = w.decodeValues(inPtr, buf.length, valPtr, maxSamples);
      return new Float64Array(w.memory.buffer.slice(valPtr, valPtr + n * 8));
    },
  };
}

// ── Generate chunks ──────────────────────────────────────────────────

function generateAllPatternChunks(numChunks, chunkSize) {
  // Pre-generate all data once, keyed by pattern name.
  // Stateful patterns (counter, gauge_cpu) need deterministic reset.
  const result = {};
  for (const [pname, pfn] of Object.entries(PATTERNS)) {
    // Reset stateful accumulators.
    _counterVal = 0;
    _gaugeVal = 50;
    const chunks = [];
    for (let c = 0; c < numChunks; c++) {
      const values = new Float64Array(chunkSize);
      for (let i = 0; i < chunkSize; i++) {
        values[i] = pfn(c * chunkSize + i);
      }
      chunks.push(values);
    }
    result[pname] = chunks;
  }
  return result;
}

// ── Compression helpers ──────────────────────────────────────────────

function deflateCompress(buf, level) {
  return deflateRawSync(buf, { level });
}
function deflateDecompress(buf) {
  return inflateRawSync(buf);
}

function zstdCompress(buf, level) {
  return zstdCompressSync(buf, { params: { [constants.ZSTD_c_compressionLevel]: level } });
}
function zstdDecompress(buf) {
  return zstdDecompressSync(buf);
}

// ── Test configurations ──────────────────────────────────────────────

function makeConfigs(wasm) {
  return [
    // Baselines
    {
      name: "ALP only",
      encode: (vals) => wasm.encodeALP(vals),
      decode: (buf) => wasm.decodeALP(buf),
      group: 1,
    },
    {
      name: "XOR only",
      encode: (vals) => wasm.encodeXOR(vals),
      decode: (buf) => wasm.decodeXOR(buf),
      group: 1,
    },

    // ALP + per-chunk secondary
    {
      name: "ALP+deflate1",
      encode: (vals) => deflateCompress(wasm.encodeALP(vals), 1),
      decode: (buf) => wasm.decodeALP(deflateDecompress(buf)),
      group: 1,
    },
    {
      name: "ALP+deflate6",
      encode: (vals) => deflateCompress(wasm.encodeALP(vals), 6),
      decode: (buf) => wasm.decodeALP(deflateDecompress(buf)),
      group: 1,
    },
    {
      name: "ALP+zstd1",
      encode: (vals) => zstdCompress(wasm.encodeALP(vals), 1),
      decode: (buf) => wasm.decodeALP(zstdDecompress(buf)),
      group: 1,
    },
    {
      name: "ALP+zstd3",
      encode: (vals) => zstdCompress(wasm.encodeALP(vals), 3),
      decode: (buf) => wasm.decodeALP(zstdDecompress(buf)),
      group: 1,
    },
    {
      name: "ALP+zstd6",
      encode: (vals) => zstdCompress(wasm.encodeALP(vals), 6),
      decode: (buf) => wasm.decodeALP(zstdDecompress(buf)),
      group: 1,
    },

    // XOR + per-chunk zstd
    {
      name: "XOR+zstd1",
      encode: (vals) => zstdCompress(wasm.encodeXOR(vals), 1),
      decode: (buf) => wasm.decodeXOR(zstdDecompress(buf)),
      group: 1,
    },
    {
      name: "XOR+zstd3",
      encode: (vals) => zstdCompress(wasm.encodeXOR(vals), 3),
      decode: (buf) => wasm.decodeXOR(zstdDecompress(buf)),
      group: 1,
    },

    // Raw float64 + secondary (no codec)
    {
      name: "raw+deflate1",
      encode: (vals) =>
        deflateCompress(Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength), 1),
      decode: (buf) => new Float64Array(deflateDecompress(buf).buffer),
      group: 1,
    },
    {
      name: "raw+zstd1",
      encode: (vals) => zstdCompress(Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength), 1),
      decode: (buf) => new Float64Array(zstdDecompress(buf).buffer),
      group: 1,
    },
    {
      name: "raw+zstd3",
      encode: (vals) => zstdCompress(Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength), 3),
      decode: (buf) => new Float64Array(zstdDecompress(buf).buffer),
      group: 1,
    },

    // ALP + multi-chunk zstd (group N chunks → 1 blob)
    {
      name: "ALP+zstd1×4",
      encode: (vals) => wasm.encodeALP(vals), // encode individually, group at compress time
      decode: (buf) => wasm.decodeALP(buf),
      group: 4,
      groupCompress: (bufs) => zstdCompress(concatBufs(bufs), 1),
      groupDecompress: (blob, sizes) => splitBuf(zstdDecompress(blob), sizes),
    },
    {
      name: "ALP+zstd1×8",
      encode: (vals) => wasm.encodeALP(vals),
      decode: (buf) => wasm.decodeALP(buf),
      group: 8,
      groupCompress: (bufs) => zstdCompress(concatBufs(bufs), 1),
      groupDecompress: (blob, sizes) => splitBuf(zstdDecompress(blob), sizes),
    },
    {
      name: "ALP+zstd1×16",
      encode: (vals) => wasm.encodeALP(vals),
      decode: (buf) => wasm.decodeALP(buf),
      group: 16,
      groupCompress: (bufs) => zstdCompress(concatBufs(bufs), 1),
      groupDecompress: (blob, sizes) => splitBuf(zstdDecompress(blob), sizes),
    },
    {
      name: "ALP+zstd3×8",
      encode: (vals) => wasm.encodeALP(vals),
      decode: (buf) => wasm.decodeALP(buf),
      group: 8,
      groupCompress: (bufs) => zstdCompress(concatBufs(bufs), 3),
      groupDecompress: (blob, sizes) => splitBuf(zstdDecompress(blob), sizes),
    },
    {
      name: "ALP+zstd3×16",
      encode: (vals) => wasm.encodeALP(vals),
      decode: (buf) => wasm.decodeALP(buf),
      group: 16,
      groupCompress: (bufs) => zstdCompress(concatBufs(bufs), 3),
      groupDecompress: (blob, sizes) => splitBuf(zstdDecompress(blob), sizes),
    },

    // Raw float64 grouped + zstd
    {
      name: "raw+zstd1×8",
      encode: (vals) => Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength),
      decode: (buf) => new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8),
      group: 8,
      groupCompress: (bufs) => zstdCompress(concatBufs(bufs), 1),
      groupDecompress: (blob, sizes) => splitBuf(zstdDecompress(blob), sizes),
    },
    {
      name: "raw+zstd3×8",
      encode: (vals) => Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength),
      decode: (buf) => new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8),
      group: 8,
      groupCompress: (bufs) => zstdCompress(concatBufs(bufs), 3),
      groupDecompress: (blob, sizes) => splitBuf(zstdDecompress(blob), sizes),
    },
  ];
}

function concatBufs(bufs) {
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const out = Buffer.alloc(total);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function splitBuf(buf, sizes) {
  const parts = [];
  let off = 0;
  for (const s of sizes) {
    parts.push(buf.subarray(off, off + s));
    off += s;
  }
  return parts;
}

// ── Run one config on one pattern ────────────────────────────────────

function runConfig(config, rawChunks) {
  const numChunks = rawChunks.length;
  const samplesPerChunk = rawChunks[0].length;
  const totalSamples = numChunks * samplesPerChunk;

  // Encode all chunks.
  const t0 = performance.now();
  const encodedChunks = rawChunks.map((c) => config.encode(c));
  const encodeMs = performance.now() - t0;

  let totalCompressedBytes;
  let decodeMs;

  if (config.group === 1) {
    // Per-chunk: total size is sum of encoded chunks.
    totalCompressedBytes = encodedChunks.reduce((s, b) => s + b.length, 0);

    // Decode all chunks.
    const td0 = performance.now();
    for (const buf of encodedChunks) {
      config.decode(buf);
    }
    decodeMs = performance.now() - td0;
  } else {
    // Multi-chunk grouping.
    const groupSize = config.group;
    const groups = [];
    const groupSizes = []; // sizes of individual encoded chunks within each group

    const tg0 = performance.now();
    for (let i = 0; i < encodedChunks.length; i += groupSize) {
      const batch = encodedChunks.slice(i, i + groupSize);
      const sizes = batch.map((b) => b.length);
      const compressed = config.groupCompress(batch);
      groups.push(compressed);
      groupSizes.push(sizes);
    }
    const groupEncodeMs = performance.now() - tg0;

    totalCompressedBytes = groups.reduce((s, b) => s + b.length, 0);
    // Add 4 bytes per chunk for size index (needed to split after decompression).
    totalCompressedBytes += encodedChunks.length * 4;

    // Decode: decompress group → split → decode each chunk.
    const td0 = performance.now();
    for (let g = 0; g < groups.length; g++) {
      const parts = config.groupDecompress(groups[g], groupSizes[g]);
      for (const part of parts) {
        config.decode(part);
      }
    }
    decodeMs = performance.now() - td0;

    // Include group compression time in encode.
    // encodeMs already includes per-chunk encode; add group compress.
    // Actually we need total encode = per-chunk encode + group compress.
    // encodeMs already measured the per-chunk encode. groupEncodeMs measured groupCompress.
    // Return combined.
    return {
      bPerPt: totalCompressedBytes / totalSamples,
      encodeUs: ((encodeMs + groupEncodeMs) / numChunks) * 1000,
      decodeUs: (decodeMs / numChunks) * 1000,
      totalEncode: encodeMs + groupEncodeMs,
      totalDecode: decodeMs,
      totalBytes: totalCompressedBytes,
    };
  }

  return {
    bPerPt: totalCompressedBytes / totalSamples,
    encodeUs: (encodeMs / numChunks) * 1000,
    decodeUs: (decodeMs / numChunks) * 1000,
    totalEncode: encodeMs,
    totalDecode: decodeMs,
    totalBytes: totalCompressedBytes,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const wasm = await loadWasm();
  const configs = makeConfigs(wasm);
  const patternNames = Object.keys(PATTERNS);

  console.log(
    `\n  Secondary compression experiment: ${NUM_CHUNKS} chunks × ${CHUNK_SIZE} samples = ${(NUM_CHUNKS * CHUNK_SIZE).toLocaleString()} pts/pattern\n`
  );

  // Pre-generate all pattern data once for consistency across configs.
  const patternChunks = generateAllPatternChunks(NUM_CHUNKS, CHUNK_SIZE);

  const allResults = {}; // config.name → { pattern → result }

  for (const cfg of configs) {
    allResults[cfg.name] = {};
    for (const pname of patternNames) {
      allResults[cfg.name][pname] = runConfig(cfg, patternChunks[pname]);
    }
  }

  // ── Per-config summary (averaged across patterns) ──

  console.log("  ┌───────────────────┬────────┬──────────┬──────────┬────────────┬────────────┐");
  console.log("  │ Config            │ B/pt   │ Enc µs/c │ Dec µs/c │ Enc tot ms │ Dec tot ms │");
  console.log("  ├───────────────────┼────────┼──────────┼──────────┼────────────┼────────────┤");

  for (const cfg of configs) {
    const results = Object.values(allResults[cfg.name]);
    const avgBpt = results.reduce((s, r) => s + r.bPerPt, 0) / results.length;
    const avgEncUs = results.reduce((s, r) => s + r.encodeUs, 0) / results.length;
    const avgDecUs = results.reduce((s, r) => s + r.decodeUs, 0) / results.length;
    const avgEnc = results.reduce((s, r) => s + r.totalEncode, 0) / results.length;
    const avgDec = results.reduce((s, r) => s + r.totalDecode, 0) / results.length;

    const name = cfg.name.padEnd(17);
    const bpt = avgBpt.toFixed(2).padStart(6);
    const encUs = avgEncUs.toFixed(0).padStart(8);
    const decUs = avgDecUs.toFixed(0).padStart(8);
    const encMs = avgEnc.toFixed(1).padStart(10);
    const decMs = avgDec.toFixed(1).padStart(10);
    console.log(`  │ ${name} │ ${bpt} │ ${encUs} │ ${decUs} │ ${encMs} │ ${decMs} │`);
  }
  console.log("  └───────────────────┴────────┴──────────┴──────────┴────────────┴────────────┘");

  // ── Per-pattern B/pt breakdown for selected configs ──

  const showConfigs = [
    "ALP only",
    "ALP+zstd1",
    "ALP+zstd3",
    "ALP+zstd1×8",
    "ALP+zstd3×16",
    "XOR only",
    "XOR+zstd1",
    "raw+zstd3",
    "raw+zstd3×8",
  ];

  console.log(`\n  Per-pattern B/pt (selected configs):\n`);
  const hdr = `  ${"Pattern".padEnd(12)}${showConfigs.map((n) => n.padStart(14)).join("")}`;
  console.log(hdr);
  console.log(`  ${"─".repeat(12 + showConfigs.length * 14)}`);

  for (const pname of patternNames) {
    let line = `  ${pname.padEnd(12)}`;
    for (const cname of showConfigs) {
      const r = allResults[cname]?.[pname];
      line += r ? r.bPerPt.toFixed(2).padStart(14) : "N/A".padStart(14);
    }
    console.log(line);
  }

  // ── Best overall ──

  console.log();
  let bestBpt = Infinity,
    bestName = "";
  for (const cfg of configs) {
    const avg =
      Object.values(allResults[cfg.name]).reduce((s, r) => s + r.bPerPt, 0) / patternNames.length;
    if (avg < bestBpt) {
      bestBpt = avg;
      bestName = cfg.name;
    }
  }
  console.log(`  Best avg compression: ${bestName} → ${bestBpt.toFixed(2)} B/pt`);

  let bestDec = Infinity,
    bestDecName = "";
  for (const cfg of configs) {
    const avg =
      Object.values(allResults[cfg.name]).reduce((s, r) => s + r.decodeUs, 0) / patternNames.length;
    if (avg < bestDec) {
      bestDec = avg;
      bestDecName = cfg.name;
    }
  }
  console.log(`  Fastest decode:       ${bestDecName} → ${bestDec.toFixed(0)} µs/chunk`);

  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
