import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const pkgPath = (r) => join(pkgRoot, r);

const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } = await import(
  join(__dirname, "dist", "wasm-loader.js")
);
const wasm = await loadWasm(pkgPath("wasm/o11ytsdb-rust.wasm"));
const alpVals = makeALPValuesCodec(wasm);
const wasmTs = makeTimestampCodec(wasm);
const rangeCodec = makeALPRangeCodec(wasm);

const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
const { RowGroupStore } = await import(pkgPath("dist/row-group-store.js"));
const { FlatStore } = await import(pkgPath("dist/flat-store.js"));

const CHUNK_SIZE = 640;
const NUM_SERIES = 100;
const POINTS = 10000;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n;

class Rng {
  constructor(seed) {
    this.state = seed;
  }
  next() {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  gaussian(mean, std) {
    const u1 = this.next();
    const u2 = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  }
}

const rng = new Rng(42);

const allTs = [];
const allVs = [];
for (let s = 0; s < NUM_SERIES; s++) {
  const ts = new BigInt64Array(POINTS);
  const vs = new Float64Array(POINTS);
  const pattern = s % 10;
  if (pattern === 0) {
    // Constant
    const c = Math.round(rng.next() * 1000) / 10;
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      vs[i] = c;
    }
  } else if (pattern === 1) {
    // Counter, small integers
    let counter = Math.floor(rng.next() * 10000);
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      if (rng.next() >= 0.4) counter += Math.floor(rng.next() * 10) + 1;
      vs[i] = counter;
    }
  } else if (pattern === 2) {
    // Counter, large integers (~10^10)
    let counter = Math.floor(rng.next() * 1e10) + 1e10;
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      if (rng.next() >= 0.3) counter += Math.floor(rng.next() * 100000) + 1;
      vs[i] = counter;
    }
  } else if (pattern === 3) {
    // Gauge, 2dp
    let v = Math.round(rng.next() * 10000) / 100;
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      v += rng.gaussian(0, 0.05);
      v = Math.max(0, v);
      vs[i] = Math.round(v * 100) / 100;
    }
  } else if (pattern === 4) {
    // Gauge, 3dp
    let v = rng.next() * 500;
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      v += rng.gaussian(0, 0.02);
      v = Math.max(0, v);
      vs[i] = Math.round(v * 1000) / 1000;
    }
  } else if (pattern === 5) {
    // Gauge, 11dp (memory.utilization style)
    let base = rng.next() * 0.5 + 0.05;
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      base += rng.gaussian(0, 0.0001);
      base = Math.max(0, Math.min(1, base));
      vs[i] = Math.round(base * 1e11) / 1e11;
    }
  } else if (pattern === 6) {
    // Gauge, 12dp (filesystem.utilization style)
    let base = rng.next() * 0.4 + 0.1;
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      base += rng.gaussian(0, 0.000001);
      base = Math.max(0, Math.min(1, base));
      vs[i] = Math.round(base * 1e12) / 1e12;
    }
  } else if (pattern === 7 || pattern === 8) {
    // High-precision ratio (cpu.utilization style — NOT ALP-clean)
    let ticks = Math.floor(rng.next() * 1e6);
    let totalTicks = Math.floor(1e7 + rng.next() * 1e6);
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      ticks += Math.floor(rng.next() * 200) + 1;
      totalTicks += 1000;
      vs[i] = ticks / totalTicks;
    }
  } else {
    // High-variance gauge, 2dp
    let v = rng.next() * 100;
    for (let i = 0; i < POINTS; i++) {
      ts[i] = T0 + BigInt(i) * INTERVAL;
      v += rng.gaussian(0, 0.5);
      v = Math.max(0, v);
      vs[i] = Math.round(v * 100) / 100;
    }
  }
  allTs.push(ts);
  allVs.push(vs);
}

const codec = {
  name: "alp",
  encodeValues: alpVals.encodeValues,
  decodeValues: alpVals.decodeValues,
  encodeValuesWithStats: alpVals.encodeValuesWithStats,
  encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
  decodeBatchValues: alpVals.decodeBatchValues,
};
const tsCodec = {
  name: "ts",
  encodeTimestamps: wasmTs.encodeTimestamps,
  decodeTimestamps: wasmTs.decodeTimestamps,
};

const flat = new FlatStore();
const col = new ColumnStore(codec, CHUNK_SIZE, () => 0, undefined, tsCodec, rangeCodec);
const rg = new RowGroupStore(codec, CHUNK_SIZE, () => 0, undefined, tsCodec, rangeCodec);

const flatIds = [],
  colIds = [],
  rgIds = [];
for (let s = 0; s < NUM_SERIES; s++) {
  const m = new Map();
  m.set("__name__", `m_${s % 10}`);
  m.set("idx", `${s}`);
  flatIds.push(flat.getOrCreateSeries(m));
  colIds.push(col.getOrCreateSeries(new Map(m)));
  rgIds.push(rg.getOrCreateSeries(new Map(m)));
}

for (let off = 0; off < POINTS; off += CHUNK_SIZE) {
  const end = Math.min(off + CHUNK_SIZE, POINTS);
  for (let s = 0; s < NUM_SERIES; s++) {
    flat.appendBatch(flatIds[s], allTs[s].subarray(off, end), allVs[s].subarray(off, end));
    col.appendBatch(colIds[s], allTs[s].subarray(off, end), allVs[s].subarray(off, end));
    rg.appendBatch(rgIds[s], allTs[s].subarray(off, end), allVs[s].subarray(off, end));
  }
}

const start = T0;
const queryEnd = T0 + BigInt(POINTS) * INTERVAL;
let mismatches = 0;
for (let s = 0; s < NUM_SERIES; s++) {
  const fData = flat.read(flatIds[s], start, queryEnd);
  const cData = col.read(colIds[s], start, queryEnd);
  const rData = rg.read(rgIds[s], start, queryEnd);

  if (fData.values.length !== cData.values.length || fData.values.length !== rData.values.length) {
    console.log(
      `Series ${s}: LENGTH mismatch flat=${fData.values.length} col=${cData.values.length} rg=${rData.values.length}`
    );
    mismatches++;
    continue;
  }
  if (
    fData.timestamps.length !== cData.timestamps.length ||
    fData.timestamps.length !== rData.timestamps.length
  ) {
    console.log(
      `Series ${s}: TS LENGTH mismatch flat=${fData.timestamps.length} col=${cData.timestamps.length} rg=${rData.timestamps.length}`
    );
    mismatches++;
    continue;
  }
  if (fData.values.length !== POINTS) {
    console.log(`Series ${s}: expected ${POINTS} got ${fData.values.length}`);
    mismatches++;
    continue;
  }

  for (let i = 0; i < fData.values.length; i++) {
    if (fData.timestamps[i] !== cData.timestamps[i]) {
      console.log(
        `Series ${s} sample ${i}: ts flat=${fData.timestamps[i]} col=${cData.timestamps[i]}`
      );
      mismatches++;
      break;
    }
    if (fData.timestamps[i] !== rData.timestamps[i]) {
      console.log(
        `Series ${s} sample ${i}: ts flat=${fData.timestamps[i]} rg=${rData.timestamps[i]}`
      );
      mismatches++;
      break;
    }
    if (fData.values[i] !== cData.values[i]) {
      console.log(`Series ${s} sample ${i}: flat=${fData.values[i]} col=${cData.values[i]}`);
      mismatches++;
      break;
    }
    if (fData.values[i] !== rData.values[i]) {
      console.log(`Series ${s} sample ${i}: flat=${fData.values[i]} rg=${rData.values[i]}`);
      mismatches++;
      break;
    }
  }
}

console.log(`\nVerified ${NUM_SERIES} series x ${POINTS} pts = ${NUM_SERIES * POINTS} samples`);
console.log(`Mismatches: ${mismatches}`);
console.log(`\nMemory:`);
console.log(
  `  flat:       ${flat.memoryBytes()} B  (${(flat.memoryBytes() / (NUM_SERIES * POINTS)).toFixed(2)} B/pt)`
);
console.log(
  `  column-alp: ${col.memoryBytes()} B  (${(col.memoryBytes() / (NUM_SERIES * POINTS)).toFixed(2)} B/pt)`
);
console.log(
  `  rowgroup:   ${rg.memoryBytes()} B  (${(rg.memoryBytes() / (NUM_SERIES * POINTS)).toFixed(2)} B/pt)`
);

console.log(`\nPer-pattern ALP chunk sizes (640 samples):`);
const patternNames = [
  "constant",
  "counter-sm",
  "counter-lg",
  "gauge-2dp",
  "gauge-3dp",
  "gauge-11dp",
  "gauge-12dp",
  "hi-prec",
  "hi-prec",
  "high-var",
];
for (let p = 0; p < 10; p++) {
  const chunk = allVs[p].subarray(0, 640);
  const { compressed, stats } = alpVals.encodeValuesWithStats(chunk);
  console.log(
    `  pattern ${p} (${patternNames[p]}): ${compressed.byteLength} B  (${(compressed.byteLength / 640).toFixed(3)} B/pt)  reset=${stats.resetCount}`
  );
}
