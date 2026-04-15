/**
 * R1: Gorilla Compression in TypeScript — Quantified
 * 
 * Implements delta-of-delta timestamp encoding and XOR float compression
 * from Facebook's Gorilla paper, then benchmarks throughput and compression
 * ratio on realistic OTLP-like data.
 * 
 * Run: node research/gorilla-bench.mjs
 */

// === Bit Writer / Reader ===

class BitWriter {
  constructor(capacity = 65536) {
    this.buf = new Uint8Array(capacity);
    this.bytePos = 0;
    this.bitPos = 0;
  }
  writeBit(bit) {
    if (this.bytePos >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    if (bit) this.buf[this.bytePos] |= (0x80 >>> this.bitPos);
    this.bitPos++;
    if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
  }
  writeBits(value, count) {
    for (let i = count - 1; i >= 0; i--) this.writeBit((value >>> i) & 1);
  }
  writeBits64(hi, lo, count) {
    if (count <= 32) { this.writeBits(lo, count); }
    else { this.writeBits(hi, count - 32); this.writeBits(lo, 32); }
  }
  totalBits() { return this.bytePos * 8 + this.bitPos; }
  bytes() { return this.buf.slice(0, this.bytePos + (this.bitPos > 0 ? 1 : 0)); }
}

class BitReader {
  constructor(buf) { this.buf = buf; this.bytePos = 0; this.bitPos = 0; }
  readBit() {
    const bit = (this.buf[this.bytePos] >>> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
    return bit;
  }
  readBits(count) {
    let v = 0;
    for (let i = 0; i < count; i++) v = (v << 1) | this.readBit();
    return v;
  }
}

// Float64 <-> two Uint32 via shared buffer
const f64Buf = new Float64Array(1);
const u32Buf = new Uint32Array(f64Buf.buffer);

function floatToU64(v) { f64Buf[0] = v; return [u32Buf[1], u32Buf[0]]; }
function u64ToFloat(hi, lo) { u32Buf[1] = hi; u32Buf[0] = lo; return f64Buf[0]; }
function xor64(aH, aL, bH, bL) { return [(aH ^ bH) >>> 0, (aL ^ bL) >>> 0]; }
function clz64(hi, lo) { return hi ? Math.clz32(hi) : lo ? 32 + Math.clz32(lo) : 64; }
function sigBits64(hi, lo) { return hi ? 64 - Math.clz32(hi) : lo ? 32 - Math.clz32(lo) : 0; }

function shr64(hi, lo, s) {
  if (s === 0) return [hi, lo];
  if (s >= 32) return [0, (hi >>> (s - 32)) >>> 0];
  return [(hi >>> s) >>> 0, (((lo >>> s) | (hi << (32 - s))) >>> 0)];
}
function shl64(hi, lo, s) {
  if (s === 0) return [hi, lo];
  if (s >= 32) return [((lo << (s - 32)) >>> 0), 0];
  return [(((hi << s) | (lo >>> (32 - s))) >>> 0), ((lo << s) >>> 0)];
}

// === Gorilla Encoder ===

function gorillaEncode(timestamps, values) {
  const n = timestamps.length;
  if (n === 0) throw new Error("empty");
  const w = new BitWriter(n * 2);

  // First point: raw 64-bit timestamp + 64-bit value
  const t0 = timestamps[0];
  w.writeBits((t0 / 0x100000000) >>> 0, 32);
  w.writeBits(t0 >>> 0, 32);
  const [v0Hi, v0Lo] = floatToU64(values[0]);
  w.writeBits(v0Hi, 32);
  w.writeBits(v0Lo, 32);

  let prevT = t0, prevDelta = 0;
  let prevVHi = v0Hi, prevVLo = v0Lo;
  let prevLeading = 64, prevTrailing = 0;

  for (let i = 1; i < n; i++) {
    const t = timestamps[i];
    const delta = t - prevT;
    const dod = delta - prevDelta;

    // Timestamp: delta-of-delta encoding
    if (dod === 0) {
      w.writeBit(0);
    } else if (dod >= -63 && dod <= 64) {
      w.writeBits(0b10, 2); w.writeBits((dod + 63) & 0x7F, 7);
    } else if (dod >= -255 && dod <= 256) {
      w.writeBits(0b110, 3); w.writeBits((dod + 255) & 0x1FF, 9);
    } else if (dod >= -2047 && dod <= 2048) {
      w.writeBits(0b1110, 4); w.writeBits((dod + 2047) & 0xFFF, 12);
    } else {
      w.writeBits(0b1111, 4); w.writeBits(dod >>> 0, 32);
    }
    prevDelta = delta; prevT = t;

    // Value: XOR encoding
    const [vHi, vLo] = floatToU64(values[i]);
    const [xHi, xLo] = xor64(vHi, vLo, prevVHi, prevVLo);

    if (xHi === 0 && xLo === 0) {
      w.writeBit(0);
    } else {
      w.writeBit(1);
      const leading = clz64(xHi, xLo);
      const sig = sigBits64(xHi, xLo);
      const trailing = 64 - leading - sig;

      if (leading >= prevLeading && trailing >= prevTrailing) {
        w.writeBit(0);
        const bits = 64 - prevLeading - prevTrailing;
        const shifted = shr64(xHi, xLo, prevTrailing);
        w.writeBits64(shifted[0], shifted[1], bits);
      } else {
        w.writeBit(1);
        w.writeBits(leading, 6);
        w.writeBits(sig - 1, 6);
        const shifted = shr64(xHi, xLo, trailing);
        w.writeBits64(shifted[0], shifted[1], sig);
      }
      prevLeading = leading; prevTrailing = trailing;
    }
    prevVHi = vHi; prevVLo = vLo;
  }

  return { data: w.bytes(), count: n, tFirst: t0, tLast: timestamps[n - 1], totalBits: w.totalBits() };
}

// === Gorilla Decoder ===

function gorillaDecode(chunk, outT, outV) {
  const r = new BitReader(chunk.data);
  const n = chunk.count;

  outT[0] = r.readBits(32) * 0x100000000 + r.readBits(32);
  const v0Hi = r.readBits(32), v0Lo = r.readBits(32);
  outV[0] = u64ToFloat(v0Hi, v0Lo);

  let prevT = outT[0], prevDelta = 0;
  let prevVHi = v0Hi, prevVLo = v0Lo;
  let prevLeading = 0, prevMeaningful = 64;

  for (let i = 1; i < n; i++) {
    let dod;
    if (r.readBit() === 0) { dod = 0; }
    else if (r.readBit() === 0) { dod = r.readBits(7) - 63; }
    else if (r.readBit() === 0) { dod = r.readBits(9) - 255; }
    else if (r.readBit() === 0) { dod = r.readBits(12) - 2047; }
    else { dod = r.readBits(32); if (dod >= 0x80000000) dod -= 0x100000000; }

    prevDelta += dod; prevT += prevDelta; outT[i] = prevT;

    if (r.readBit() === 0) {
      outV[i] = outV[i - 1];
    } else {
      let xHi, xLo;
      if (r.readBit() === 0) {
        const bits = prevMeaningful;
        let hi = 0, lo = 0;
        if (bits <= 32) { lo = r.readBits(bits); } else { hi = r.readBits(bits - 32); lo = r.readBits(32); }
        [xHi, xLo] = shl64(hi, lo, 64 - prevLeading - prevMeaningful);
      } else {
        const leading = r.readBits(6);
        const meaningful = r.readBits(6) + 1;
        let hi = 0, lo = 0;
        if (meaningful <= 32) { lo = r.readBits(meaningful); } else { hi = r.readBits(meaningful - 32); lo = r.readBits(32); }
        [xHi, xLo] = shl64(hi, lo, 64 - leading - meaningful);
        prevLeading = leading; prevMeaningful = meaningful;
      }
      prevVHi = (prevVHi ^ xHi) >>> 0;
      prevVLo = (prevVLo ^ xLo) >>> 0;
      outV[i] = u64ToFloat(prevVHi, prevVLo);
    }
  }
}

// === Data Generators ===

function genConstant(n, t0, dt) {
  const t = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) { t[i] = t0 + i * dt; v[i] = 42.0; }
  return [t, v];
}

function genSlowGauge(n, t0, dt) {
  const t = new Float64Array(n), v = new Float64Array(n);
  let val = 50.0;
  for (let i = 0; i < n; i++) { t[i] = t0 + i * dt; val += (Math.random() - 0.5) * 0.1; v[i] = val; }
  return [t, v];
}

function genCounter(n, t0, dt) {
  const t = new Float64Array(n), v = new Float64Array(n);
  let val = 0;
  for (let i = 0; i < n; i++) { t[i] = t0 + i * dt; val += Math.floor(Math.random() * 100) + 1; v[i] = val; }
  return [t, v];
}

function genIntCounter(n, t0, dt) {
  const t = new Float64Array(n), v = new Float64Array(n);
  let val = 0;
  for (let i = 0; i < n; i++) { t[i] = t0 + i * dt; val += Math.floor(Math.random() * 10) + 1; v[i] = val; }
  return [t, v];
}

function genSpiky(n, t0, dt) {
  const t = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = t0 + i * dt;
    v[i] = Math.random() < 0.95 ? 5 + Math.random() * 10 : 500 + Math.random() * 1500;
  }
  return [t, v];
}

function genHighEntropy(n, t0, dt) {
  const t = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) { t[i] = t0 + i * dt; v[i] = Math.random() * 1e15; }
  return [t, v];
}

// === VictoriaMetrics Float→Int Detection ===

function analyzeIntConversion(values) {
  let intCount = 0, convertCount = 0;
  const scaleDist = new Array(7).fill(0);
  for (let i = 0; i < values.length; i++) {
    for (let s = 0; s <= 6; s++) {
      const scaled = values[i] * Math.pow(10, s);
      if (Number.isInteger(scaled) && Math.abs(scaled) < Number.MAX_SAFE_INTEGER) {
        convertCount++; scaleDist[s]++;
        if (s === 0) intCount++;
        break;
      }
    }
  }
  return { pctInt: (intCount / values.length * 100), pctConv: (convertCount / values.length * 100), scaleDist };
}

// === String Interning Benchmark ===

function benchStringIntern(seriesCount, labelsPerSeries) {
  // Simulate realistic OTLP label sets
  const labelNames = [
    "service.name", "service.namespace", "host.name", "http.method",
    "http.route", "http.status_code", "rpc.method", "rpc.service",
    "db.system", "container.id"
  ].slice(0, labelsPerSeries);

  const labelValues = labelNames.map((_, idx) => {
    const cardinality = [5, 3, 20, 4, 50, 6, 30, 10, 4, 100][idx] || 10;
    return Array.from({ length: cardinality }, (_, i) => `value_${idx}_${i}`);
  });

  // Generate label sets
  const labelSets = [];
  for (let i = 0; i < seriesCount; i++) {
    const labels = {};
    for (let j = 0; j < labelsPerSeries; j++) {
      labels[labelNames[j]] = labelValues[j][i % labelValues[j].length];
    }
    labelSets.push(labels);
  }

  // Method 1: Raw objects (baseline)
  const rawStart = performance.now();
  const rawStore = [];
  for (const ls of labelSets) {
    rawStore.push({ ...ls }); // shallow copy simulating storage
  }
  const rawMs = performance.now() - rawStart;
  const rawSize = estimateRawSize(rawStore);

  // Method 2: String interning with Uint32Array
  const internStart = performance.now();
  const interner = new Map();
  let nextId = 0;
  const intern = (s) => {
    let id = interner.get(s);
    if (id === undefined) { id = nextId++; interner.set(s, id); }
    return id;
  };

  const internedStore = [];
  for (const ls of labelSets) {
    const pairs = [];
    for (const [k, v] of Object.entries(ls)) {
      pairs.push(intern(k), intern(v));
    }
    internedStore.push(new Uint32Array(pairs));
  }
  const internMs = performance.now() - internStart;
  const internedSize = estimateInternedSize(internedStore, interner);

  return { seriesCount, labelsPerSeries, rawMs, internMs, rawSize, internedSize, ratio: rawSize / internedSize, internerEntries: interner.size };
}

function estimateRawSize(store) {
  let size = 0;
  for (const obj of store) {
    for (const [k, v] of Object.entries(obj)) {
      size += k.length * 2 + v.length * 2 + 64; // string overhead + object slot
    }
  }
  return size;
}

function estimateInternedSize(store, interner) {
  let size = 0;
  for (const arr of store) size += arr.byteLength + 16; // Uint32Array + overhead
  // Intern table
  for (const [k] of interner) size += k.length * 2 + 8; // string + id
  return size;
}

// === Inverted Index Benchmark ===

function benchInvertedIndex(seriesCount, queryLabels) {
  // Build posting lists (sorted Uint32Arrays)
  const postings = new Map(); // "key=value" -> Uint32Array of series IDs

  // Simulate: 10 label names, varying cardinality
  const labels = ["service", "method", "status", "host", "path"];
  const cardinalities = [5, 20, 6, 50, 100];

  for (let i = 0; i < seriesCount; i++) {
    for (let j = 0; j < labels.length; j++) {
      const key = `${labels[j]}=${i % cardinalities[j]}`;
      let list = postings.get(key);
      if (!list) { list = []; postings.set(key, list); }
      list.push(i);
    }
  }

  // Convert to sorted Uint32Arrays
  for (const [key, list] of postings) {
    postings.set(key, new Uint32Array(list));
  }

  // Galloping intersection
  function gallop(arr, target, start) {
    let lo = start, hi = 1;
    while (lo + hi < arr.length && arr[lo + hi] < target) hi *= 2;
    hi = Math.min(lo + hi, arr.length);
    lo = lo + (hi >>> 1);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function intersect(a, b) {
    const result = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { result.push(a[i]); i++; j++; }
      else if (a[i] < b[j]) { i = gallop(a, b[j], i); }
      else { j = gallop(b, a[i], j); }
    }
    return new Uint32Array(result);
  }

  // Benchmark: intersect N posting lists
  const queryKeys = [];
  for (let q = 0; q < queryLabels; q++) {
    const j = q % labels.length;
    queryKeys.push(`${labels[j]}=${q % cardinalities[j]}`);
  }

  const iters = 1000;
  const start = performance.now();
  for (let it = 0; it < iters; it++) {
    let result = postings.get(queryKeys[0]) || new Uint32Array(0);
    for (let q = 1; q < queryKeys.length; q++) {
      const next = postings.get(queryKeys[q]) || new Uint32Array(0);
      result = intersect(result, next);
    }
  }
  const elapsed = performance.now() - start;

  // Also benchmark: Set intersection
  const sets = queryKeys.map(k => new Set(postings.get(k) || []));
  const setStart = performance.now();
  for (let it = 0; it < iters; it++) {
    let result = sets[0];
    for (let q = 1; q < sets.length; q++) {
      const next = new Set();
      for (const id of result) { if (sets[q].has(id)) next.add(id); }
      result = next;
    }
  }
  const setElapsed = performance.now() - setStart;

  return {
    seriesCount, queryLabels,
    gallopUsPerQuery: (elapsed / iters) * 1000,
    setUsPerQuery: (setElapsed / iters) * 1000,
    speedup: setElapsed / elapsed,
    postingListCount: postings.size,
  };
}

// === Streaming vs Materializing Query ===

function benchStreamingQuery(seriesCount, pointsPerSeries) {
  // Generate compressed chunks for N series
  const t0 = 1700000000000;
  const dt = 15000;
  const chunks = [];

  for (let s = 0; s < seriesCount; s++) {
    const t = new Float64Array(pointsPerSeries);
    const v = new Float64Array(pointsPerSeries);
    let val = Math.random() * 100;
    for (let i = 0; i < pointsPerSeries; i++) {
      t[i] = t0 + i * dt;
      val += (Math.random() - 0.5) * 2;
      v[i] = val;
    }
    chunks.push(gorillaEncode(t, v));
  }

  // Method 1: Materializing — decompress all, then aggregate
  const matStart = performance.now();
  let matSum = 0, matCount = 0;
  const allValues = new Float64Array(seriesCount * pointsPerSeries);
  const allTimes = new Float64Array(seriesCount * pointsPerSeries);
  for (let s = 0; s < seriesCount; s++) {
    const offset = s * pointsPerSeries;
    gorillaDecode(chunks[s], allTimes.subarray(offset), allValues.subarray(offset));
  }
  // Sum across all series
  for (let i = 0; i < allValues.length; i++) { matSum += allValues[i]; matCount++; }
  const matMs = performance.now() - matStart;

  // Method 2: Streaming — decompress + aggregate chunk by chunk
  const streamStart = performance.now();
  let streamSum = 0, streamCount = 0;
  const scratchT = new Float64Array(pointsPerSeries);
  const scratchV = new Float64Array(pointsPerSeries);
  for (let s = 0; s < seriesCount; s++) {
    gorillaDecode(chunks[s], scratchT, scratchV);
    for (let i = 0; i < pointsPerSeries; i++) { streamSum += scratchV[i]; streamCount++; }
  }
  const streamMs = performance.now() - streamStart;

  return {
    seriesCount, pointsPerSeries,
    matMs, streamMs,
    matPeakBytes: seriesCount * pointsPerSeries * 16,
    streamPeakBytes: pointsPerSeries * 16,
    memoryRatio: seriesCount, // streaming uses 1/seriesCount the memory
    speedup: matMs / streamMs,
    verify: Math.abs(matSum - streamSum) < 0.001,
  };
}

// ==================== RUN BENCHMARKS ====================

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║  OTLP Metrics Engine — Research Benchmarks                  ║");
console.log("║  Node " + process.version.padEnd(53) + "║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

// R1: Gorilla Compression
console.log("═══ R1: Gorilla Compression in TypeScript ═══\n");

const generators = [
  ["Constant gauge (v=42)", genConstant],
  ["Slow-changing gauge (CPU%)", genSlowGauge],
  ["Monotonic counter (HTTP)", genCounter],
  ["Integer counter (small Δ)", genIntCounter],
  ["Spiky latency (5-2000ms)", genSpiky],
  ["High entropy random", genHighEntropy],
];

console.log("  Data Type                           bits/pt  bytes/pt  ratio   enc µs/pt  dec µs/pt  ok?");
console.log("  " + "─".repeat(95));

const results = [];
for (const [name, gen] of generators) {
  const n = 1024;
  const [t, v] = gen(n, 1700000000000, 15000);

  // Warm
  for (let w = 0; w < 5; w++) gorillaEncode(t, v);

  // Encode
  const encIters = 200;
  const eS = performance.now();
  let chunk;
  for (let i = 0; i < encIters; i++) chunk = gorillaEncode(t, v);
  const eMs = (performance.now() - eS) / encIters;

  // Decode
  const outT = new Float64Array(n), outV = new Float64Array(n);
  const dS = performance.now();
  for (let i = 0; i < encIters; i++) gorillaDecode(chunk, outT, outV);
  const dMs = (performance.now() - dS) / encIters;

  // Verify
  gorillaDecode(chunk, outT, outV);
  let ok = true;
  for (let i = 0; i < n; i++) { if (outT[i] !== t[i] || outV[i] !== v[i]) { ok = false; break; } }

  const bpp = chunk.totalBits / n;
  const ia = analyzeIntConversion(v);
  results.push({ name, bpp, encUs: eMs * 1000 / n, decUs: dMs * 1000 / n, ok, ia });

  console.log(
    "  " + name.padEnd(36) +
    bpp.toFixed(1).padStart(7) +
    (bpp / 8).toFixed(2).padStart(9) +
    ((128 / bpp).toFixed(1) + "x").padStart(7) +
    (eMs * 1000 / n).toFixed(2).padStart(11) +
    (dMs * 1000 / n).toFixed(2).padStart(11) +
    (ok ? "  ✓" : "  ✗").padStart(5)
  );
}

// Chunk size impact
console.log("\n  Chunk Size Impact (slow gauge):");
console.log("  " + "─".repeat(70));
for (const size of [120, 256, 512, 1024, 2048, 4096]) {
  const [t, v] = genSlowGauge(size, 1700000000000, 15000);
  for (let w = 0; w < 5; w++) gorillaEncode(t, v);
  const iters = 200;
  const eS = performance.now();
  let chunk;
  for (let i = 0; i < iters; i++) chunk = gorillaEncode(t, v);
  const eMs = (performance.now() - eS) / iters;
  const outT = new Float64Array(size), outV = new Float64Array(size);
  const dS = performance.now();
  for (let i = 0; i < iters; i++) gorillaDecode(chunk, outT, outV);
  const dMs = (performance.now() - dS) / iters;
  const bpp = chunk.totalBits / size;
  console.log(
    "  chunk=" + String(size).padStart(5) +
    "  bits/pt=" + bpp.toFixed(1).padStart(6) +
    "  bytes/pt=" + (bpp / 8).toFixed(2).padStart(5) +
    "  ratio=" + (128 / bpp).toFixed(1).padStart(5) + "x" +
    "  enc=" + (eMs * 1000 / size).toFixed(2).padStart(6) + " µs/pt" +
    "  dec=" + (dMs * 1000 / size).toFixed(2).padStart(6) + " µs/pt"
  );
}

// Throughput
const slowR = results[1];
console.log("\n  Throughput (slow gauge, 1024-point chunks):");
console.log("    Encode: " + (1 / (slowR.encUs / 1e6)).toFixed(2) + " M samples/sec");
console.log("    Decode: " + (1 / (slowR.decUs / 1e6)).toFixed(2) + " M samples/sec");

// R2: Float→Int
console.log("\n\n═══ R2: VictoriaMetrics Float→Int Conversion ═══\n");
console.log("  Data Type                           % pure int  % convertible  scale distribution (0-6)");
console.log("  " + "─".repeat(95));

for (const r of results) {
  const ia = r.ia;
  console.log(
    "  " + r.name.padEnd(36) +
    (ia.pctInt.toFixed(0) + "%").padStart(10) +
    (ia.pctConv.toFixed(0) + "%").padStart(14) +
    "  [" + ia.scaleDist.join(", ") + "]"
  );
}

// R4: Inverted Index
console.log("\n\n═══ R4: Inverted Index Performance ═══\n");
console.log("  Series     Labels  Gallop µs/q   Set µs/q   Speedup");
console.log("  " + "─".repeat(60));

for (const series of [1000, 10000, 100000]) {
  for (const labels of [1, 2, 3]) {
    const r = benchInvertedIndex(series, labels);
    console.log(
      "  " + String(series).padStart(7) +
      String(labels).padStart(8) +
      r.gallopUsPerQuery.toFixed(1).padStart(13) +
      r.setUsPerQuery.toFixed(1).padStart(11) +
      (r.speedup.toFixed(1) + "x").padStart(10)
    );
  }
}

// R5: Streaming vs Materializing
console.log("\n\n═══ R5: Streaming vs Materializing Query ═══\n");
console.log("  Series × Points     Mat ms    Stream ms  Speedup  Mat peak     Stream peak   Mem ratio");
console.log("  " + "─".repeat(90));

for (const [sc, pp] of [[100, 1024], [1000, 1024], [1000, 120], [5000, 1024]]) {
  const r = benchStreamingQuery(sc, pp);
  const fmt = (b) => b < 1024 * 1024 ? (b / 1024).toFixed(0) + " KB" : (b / 1024 / 1024).toFixed(1) + " MB";
  console.log(
    "  " + (sc + "×" + pp).padStart(12) +
    r.matMs.toFixed(1).padStart(11) +
    r.streamMs.toFixed(1).padStart(11) +
    (r.speedup.toFixed(2) + "x").padStart(9) +
    fmt(r.matPeakBytes).padStart(12) +
    fmt(r.streamPeakBytes).padStart(14) +
    (r.memoryRatio + "x").padStart(11) +
    (r.verify ? "" : " ✗ MISMATCH")
  );
}

// String Interning
console.log("\n\n═══ String Interning ═══\n");
console.log("  Series   Labels  Raw KB  Interned KB  Ratio   Raw ms  Intern ms  Entries");
console.log("  " + "─".repeat(80));

for (const [sc, lps] of [[1000, 5], [10000, 5], [10000, 10], [100000, 5]]) {
  const r = benchStringIntern(sc, lps);
  console.log(
    "  " + String(sc).padStart(7) +
    String(lps).padStart(8) +
    (r.rawSize / 1024).toFixed(0).padStart(8) +
    (r.internedSize / 1024).toFixed(0).padStart(12) +
    (r.ratio.toFixed(1) + "x").padStart(7) +
    r.rawMs.toFixed(1).padStart(8) +
    r.internMs.toFixed(1).padStart(10) +
    String(r.internerEntries).padStart(9)
  );
}

// Memory Projections
console.log("\n\n═══ Memory Projections ═══\n");
const avgBpp = results.reduce((s, r) => s + r.bpp, 0) / results.length;
console.log("  Average bits/point across types: " + avgBpp.toFixed(1) + " (" + (avgBpp / 8).toFixed(2) + " bytes)");
console.log("");
console.log("  Scenario                         Raw         Compressed    Ratio");
console.log("  " + "─".repeat(65));

const fmt = (b) => {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
};

for (const [sc, pp, label] of [
  [1000, 120, "1K series × 120 pts (Prometheus)"],
  [1000, 1024, "1K series × 1024 pts"],
  [10000, 1024, "10K series × 1024 pts"],
  [100000, 120, "100K series × 120 pts (Prometheus)"],
  [100000, 1024, "100K series × 1024 pts"],
]) {
  const raw = sc * pp * 16;
  const comp = sc * pp * (avgBpp / 8) + sc * 200;
  console.log(
    "  " + label.padEnd(35) +
    fmt(raw).padStart(10) +
    fmt(comp).padStart(14) +
    ((raw / comp).toFixed(1) + "x").padStart(9)
  );
}

console.log("\n═══ Done ═══\n");
