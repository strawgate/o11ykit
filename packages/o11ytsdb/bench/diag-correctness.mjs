#!/usr/bin/env node
/**
 * Diagnostic: test correctness of column-store read for OTel process data.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

const { loadOtelData } = await import(join(__dirname, "load-otel.mjs"));
const data = await loadOtelData(join(__dirname, "data/process.jsonl"), { repeat: 1 });

const { ColumnStore } = await import(join(pkgDir, "dist/column-store.js"));

const wasmBytes = readFileSync(join(pkgDir, "wasm/o11ytsdb-rust.wasm"));
const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
const w = instance.exports;
const mem = () => new Uint8Array(w.memory.buffer);

const alpValuesCodec = {
  name: "rust-wasm-alp",
  encodeValues(values) {
    const n = values.length;
    w.resetScratch();
    const vp = w.allocScratch(n * 8);
    const oc = n * 20;
    const op = w.allocScratch(oc);
    mem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), vp);
    const bw = w.encodeValuesALP(vp, n, op, oc);
    return new Uint8Array(w.memory.buffer.slice(op, op + bw));
  },
  decodeValues(buf) {
    w.resetScratch();
    const ip = w.allocScratch(buf.length);
    mem().set(buf, ip);
    const ms = (buf[0] << 8) | buf[1];
    const vp = w.allocScratch(ms * 8);
    const n = w.decodeValuesALP(ip, buf.length, vp, ms);
    return new Float64Array(w.memory.buffer.slice(vp, vp + n * 8));
  },
};

const tsCodec = {
  name: "rust-wasm-ts",
  encodeTimestamps(ts) {
    const n = ts.length;
    w.resetScratch();
    const tp = w.allocScratch(n * 8);
    const oc = n * 20;
    const op = w.allocScratch(oc);
    mem().set(new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength), tp);
    const bw = w.encodeTimestamps(tp, n, op, oc);
    return new Uint8Array(w.memory.buffer.slice(op, op + bw));
  },
  decodeTimestamps(buf) {
    w.resetScratch();
    const ip = w.allocScratch(buf.length);
    mem().set(buf, ip);
    const ms = (buf[0] << 8) | buf[1];
    const tp = w.allocScratch(ms * 8);
    const n = w.decodeTimestamps(ip, buf.length, tp, ms);
    return new BigInt64Array(w.memory.buffer.slice(tp, tp + n * 8));
  },
};

const CHUNK = 512;

// Pre-compute group IDs based on metric name + series length.
const seriesGroupIds = [];
{
  const keyToGroup = new Map();
  let nextGid = 0;
  for (const d of data) {
    const name = d.labels.get("__name__") ?? "";
    const key = `${name}\0${d.timestamps.length}`;
    if (!keyToGroup.has(key)) keyToGroup.set(key, nextGid++);
    seriesGroupIds.push(keyToGroup.get(key));
  }
}
let gIdx = 0;
const grouper = (_labels) => seriesGroupIds[gIdx++];
const store = new ColumnStore(alpValuesCodec, CHUNK, grouper, undefined, tsCodec);

// Ingest ALL series (like the sweep does).
const ids = [];
for (const { labels } of data) ids.push(store.getOrCreateSeries(labels));
for (let s = 0; s < data.length; s++) {
  store.appendBatch(ids[s], data[s].timestamps, data[s].values);
}

// Compute query range same as sweep.
let minT = data[0].timestamps[0];
let maxT = data[0].timestamps[data[0].timestamps.length - 1];
for (const d of data) {
  if (d.timestamps[0] < minT) minT = d.timestamps[0];
  if (d.timestamps[d.timestamps.length - 1] > maxT) maxT = d.timestamps[d.timestamps.length - 1];
}

console.log("Query range:", minT.toString(), "->", maxT.toString());
console.log("Series 0:", data[0].timestamps.length, "pts");
console.log("  range:", data[0].timestamps[0].toString(), "->", data[0].timestamps[data[0].timestamps.length - 1].toString());

const r = store.read(ids[0], minT, maxT);
console.log("Read returned:", r.timestamps.length, "pts");

if (r.timestamps.length !== data[0].timestamps.length) {
  console.log("LENGTH MISMATCH:", data[0].timestamps.length, "expected,", r.timestamps.length, "got");
  console.log("  delta:", r.timestamps.length - data[0].timestamps.length);

  if (r.timestamps.length > 0) {
    console.log("  result first:", r.timestamps[0].toString(), "last:", r.timestamps[r.timestamps.length - 1].toString());
  }

  // Find first divergence
  const n = Math.min(r.timestamps.length, data[0].timestamps.length);
  for (let i = 0; i < n; i++) {
    if (r.timestamps[i] !== data[0].timestamps[i]) {
      console.log("  First ts diff at i=" + i + ":", r.timestamps[i].toString(), "vs", data[0].timestamps[i].toString());
      // Show context
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
        const match = r.timestamps[j] === data[0].timestamps[j] ? "=" : "≠";
        console.log("    [" + j + "] read=" + r.timestamps[j]?.toString() + " " + match + " expected=" + data[0].timestamps[j].toString());
      }
      break;
    }
    if (Math.abs(r.values[i] - data[0].values[i]) > 1e-10) {
      console.log("  First val diff at i=" + i + ":", r.values[i], "vs", data[0].values[i]);
      break;
    }
  }
} else {
  let mismatches = 0;
  for (let i = 0; i < data[0].timestamps.length; i++) {
    if (r.timestamps[i] !== data[0].timestamps[i] || Math.abs(r.values[i] - data[0].values[i]) > 1e-10) {
      if (mismatches === 0) {
        console.log("  First mismatch at i=" + i + ": ts", r.timestamps[i]?.toString(), "vs", data[0].timestamps[i].toString(), "val", r.values[i], "vs", data[0].values[i]);
      }
      mismatches++;
    }
  }
  if (mismatches === 0) {
    console.log("ALL CORRECT ✓");
  } else {
    console.log("Total mismatches:", mismatches);
  }
}
