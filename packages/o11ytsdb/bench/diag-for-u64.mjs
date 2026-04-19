import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

const { loadWasm, makeALPValuesCodec } = await import(join(__dirname, "dist", "wasm-loader.js"));
const wasm = await loadWasm(join(pkgDir, "wasm/o11ytsdb-rust.wasm"));
const alp = makeALPValuesCodec(wasm);

const { loadOtelData } = await import(join(__dirname, "load-otel.mjs"));
const series = await loadOtelData(join(__dirname, "data/cpu.jsonl"));

const utils = series
  .filter((s) => s.labels.get("__name__") === "system.cpu.utilization")
  .slice(0, 8);
for (const s of utils) {
  const st = s.labels.get("state") || "";
  const cpu = s.labels.get("cpu") || "";
  const chunk = s.values.subarray(0, Math.min(525, s.values.length));
  const n = chunk.length;
  const { compressed } = alp.encodeValuesWithStats(chunk);
  const hdrN = (compressed[0] << 8) | compressed[1];
  const e = compressed[2];
  const bw = compressed[3];
  const excCount = (compressed[12] << 8) | compressed[13];

  // Parse FoR-u64 exc_bw from the payload.
  const bitPackedBytes = Math.ceil((hdrN * bw) / 8);
  const posBytes = excCount > 0 && excCount < hdrN ? excCount * 2 : 0;
  const excPayloadStart = 14 + bitPackedBytes + posBytes;
  let excBw = 0;
  if (excCount > 0 && excPayloadStart + 9 <= compressed.byteLength) {
    excBw = compressed[excPayloadStart + 8];
  }

  // Compute sortable-u64 range in JS for validation.
  function f64ToSortableU64(f) {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = f;
    const bits = new BigUint64Array(buf)[0];
    if (bits & (1n << 63n)) return ~bits;
    return bits ^ (1n << 63n);
  }

  let minSU = 0xffffffffffffffffn,
    maxSU = 0n;
  for (let i = 0; i < n; i++) {
    const su = f64ToSortableU64(chunk[i]);
    if (su < minSU) minSU = su;
    if (su > maxSU) maxSU = su;
  }
  const range = maxSU - minSU;
  const _jsBw = range > 0n ? BigInt(64) - BigInt(Math.clz32(Number(range >> 32n))) + 32n : 0n;
  // More precise:
  let rBw = 0;
  let r = range;
  while (r > 0n) {
    rBw++;
    r >>= 1n;
  }

  console.log(
    `${cpu}/${st}: e=${e} bw=${bw} exc=${excCount}/${hdrN} exc_bw=${excBw} size=${compressed.byteLength} (${(compressed.byteLength / n).toFixed(2)} B/pt)  JS-range-bits=${rBw}`
  );
  console.log(
    `  val range: [${Math.min(...chunk).toPrecision(4)}, ${Math.max(...chunk).toPrecision(4)}]`
  );
}
