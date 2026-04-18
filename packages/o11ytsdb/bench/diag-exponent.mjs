#!/usr/bin/env node
/**
 * Exponent selection diagnostic — tries every ALP exponent on real OTel
 * data and reports actual encoded sizes to validate the cost model.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');

const { loadWasm, makeALPValuesCodec } = await import(join(__dirname, 'dist', 'wasm-loader.js'));
const wasm = await loadWasm(join(pkgDir, 'wasm/o11ytsdb-rust.wasm'));
const alp = makeALPValuesCodec(wasm);

const { loadOtelData } = await import(join(__dirname, 'load-otel.mjs'));

// Load real data
const cpuSeries = await loadOtelData(join(__dirname, 'data/cpu.jsonl'));
const infraSeries = await loadOtelData(join(__dirname, 'data/infra.jsonl'));

// Pick representative series from different metric types
const targets = [
  ...cpuSeries.filter(s => s.labels.get('__name__') === 'system.cpu.utilization').slice(0, 2),
  ...cpuSeries.filter(s => s.labels.get('__name__') === 'system.cpu.time').slice(0, 2),
  ...cpuSeries.filter(s => s.labels.get('__name__') === 'system.cpu.load_average.1m'),
  ...infraSeries.filter(s => s.labels.get('__name__') === 'system.memory.utilization').slice(0, 2),
  ...infraSeries.filter(s => s.labels.get('__name__') === 'system.filesystem.utilization').slice(0, 1),
  ...infraSeries.filter(s => s.labels.get('__name__') === 'system.network.io').slice(0, 2),
  ...infraSeries.filter(s => s.labels.get('__name__') === 'system.disk.io_time').slice(0, 1),
];

console.log(`Exponent selection diagnostic (${targets.length} series)\n`);

for (const s of targets) {
  const name = s.labels.get('__name__');
  const extra = s.labels.get('state') || s.labels.get('direction') || s.labels.get('device') || '';
  const chunk = s.values.subarray(0, Math.min(640, s.values.length));
  const n = chunk.length;

  // Current codec result (uses cost-model exponent selection)
  const { compressed } = alp.encodeValuesWithStats(chunk);
  
  // Parse what exponent was chosen
  const chosenExp = compressed[2];
  const chosenExc = (compressed[12] << 8) | compressed[13];
  const chosenBw = compressed[3];

  // Verify round-trip
  const decoded = alp.decodeValues(compressed);
  let ok = true;
  for (let i = 0; i < n; i++) {
    if (chunk[i] !== decoded[i]) { ok = false; break; }
  }

  console.log(`  ${name} [${extra}] — ${n} pts, chosen e=${chosenExp} bw=${chosenBw} exc=${chosenExc}/${n} → ${compressed.byteLength} B (${(compressed.byteLength/n).toFixed(2)} B/pt) roundtrip=${ok ? '✓' : '✗'}`);
}

// Now do a deep dive on cpu.utilization: what would each exponent cost?
console.log(`\n\nDeep dive: system.cpu.utilization (first non-constant series)\n`);
const utilSeries = cpuSeries.filter(s => {
  if (s.labels.get('__name__') !== 'system.cpu.utilization') return false;
  // Skip constant series (all zeros)
  for (let i = 1; i < Math.min(10, s.values.length); i++) {
    if (s.values[i] !== s.values[0]) return true;
  }
  return false;
});

if (utilSeries.length > 0) {
  const s = utilSeries[0];
  const chunk = s.values.subarray(0, Math.min(640, s.values.length));
  const n = chunk.length;
  
  console.log(`  Sample values: ${Array.from(chunk.subarray(0, 5)).map(v => v.toPrecision(6)).join(', ')}`);
  console.log(`  ${n} samples\n`);

  // For each exponent, manually count matches and estimate what the cost model sees
  console.log(`  ${'Exp'.padStart(4)} ${'Matches'.padStart(8)} ${'Exceptions'.padStart(11)} ${'Est bw'.padStart(7)} ${'Est cost'.padStart(9)}  ${'Actual'.padStart(8)} ${'Actual B/pt'.padStart(12)}`);
  console.log(`  ${'─'.repeat(70)}`);

  // We can't easily try each exponent through WASM since the codec picks its own.
  // But we can simulate the cost model in JS.
  const POW10 = Array.from({length: 19}, (_, i) => 10 ** i);
  
  function alpTry(val, e) {
    if (!isFinite(val)) return null;
    const scaled = val * POW10[e];
    if (Math.abs(scaled) > 9.2e18) return null;
    const intVal = Math.round(scaled);
    const reconstructed = intVal / POW10[e];
    return reconstructed === val ? intVal : null;
  }

  for (let e = 0; e <= 18; e++) {
    let matchCount = 0, minInt = Infinity, maxInt = -Infinity;
    for (let i = 0; i < n; i++) {
      const iv = alpTry(chunk[i], e);
      if (iv !== null) {
        matchCount++;
        if (iv < minInt) minInt = iv;
        if (iv > maxInt) maxInt = iv;
      }
    }
    const excCount = n - matchCount;
    const range = matchCount >= 2 ? maxInt - minInt : 0;
    const bw = range > 0 ? Math.ceil(Math.log2(range + 1)) : 0;
    
    const matchBytes = Math.ceil(n * bw / 8);
    const excBytes4 = excCount * 4;
    const excBytes6 = excCount * 6;
    const excBytes8 = excCount * 8;
    const cost4 = 14 + matchBytes + excBytes4;
    const cost6 = 14 + matchBytes + excBytes6;
    const cost8 = 14 + matchBytes + excBytes8;

    console.log(`  ${String(e).padStart(4)} ${String(matchCount).padStart(8)} ${String(excCount).padStart(11)} ${String(bw).padStart(7)} ${String(cost6).padStart(9)}  (c=4: ${cost4}, c=8: ${cost8})`);
  }

  // Also show what pure Gorilla XOR on all values would cost
  // (The codec result at e=0 with all exceptions IS effectively Gorilla on all values)
  const { compressed } = alp.encodeValuesWithStats(chunk);
  console.log(`\n  Actual encoded: ${compressed.byteLength} B (${(compressed.byteLength/n).toFixed(2)} B/pt), e=${compressed[2]}, bw=${compressed[3]}, exc=${(compressed[12]<<8)|compressed[13]}`);
}
