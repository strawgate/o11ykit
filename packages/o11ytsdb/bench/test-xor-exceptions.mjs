#!/usr/bin/env node
/**
 * Test XOR-delta exception encoding on high-precision float data
 * that produces 100% ALP exceptions (like cpu.utilization).
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');

const { loadWasm, makeALPValuesCodec } = await import(join(__dirname, 'dist', 'wasm-loader.js'));
const wasm = await loadWasm(join(pkgDir, 'wasm/o11ytsdb-rust.wasm'));
const alp = makeALPValuesCodec(wasm);

const N = 640;

// Pattern 1: cpu.utilization — full IEEE 754 precision, all exceptions.
// Simulates values in [0, 1] with ~15 significant digits.
function cpuUtilization(n) {
  const vals = new Float64Array(n);
  let v = 0.02;
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.48) * 0.01; // slight upward drift
    v = Math.max(0, Math.min(1, v));
    vals[i] = v; // full precision, no rounding
  }
  return vals;
}

// Pattern 2: memory.utilization — similar, but in [0.1, 0.9]
function memUtilization(n) {
  const vals = new Float64Array(n);
  let v = 0.35;
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.5) * 0.005;
    v = Math.max(0.05, Math.min(0.95, v));
    vals[i] = v;
  }
  return vals;
}

// Pattern 3: filesystem.utilization — very stable, tiny changes
function fsUtilization(n) {
  const vals = new Float64Array(n);
  let v = 0.356793610702;
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.5) * 0.000001;
    vals[i] = v;
  }
  return vals;
}

// Pattern 4: random floats (worst case — no correlation)
function random(n) {
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    vals[i] = Math.random() * 1000;
  }
  return vals;
}

const patterns = [
  { name: 'cpu.utilization', gen: cpuUtilization },
  { name: 'memory.utilization', gen: memUtilization },
  { name: 'fs.utilization', gen: fsUtilization },
  { name: 'random (worst case)', gen: random },
];

console.log(`ALP XOR-delta exception compression (${N} samples):\n`);
console.log(`  ${'Pattern'.padEnd(28)} ${'Size'.padStart(8)} ${'B/pt'.padStart(8)} ${'Exceptions'.padStart(12)} ${'Old B/pt'.padStart(10)}  ${'Improvement'.padStart(12)}`);
console.log(`  ${'─'.repeat(88)}`);

for (const { name, gen } of patterns) {
  const vals = gen(N);
  
  // Encode
  const { compressed, stats } = alp.encodeValuesWithStats(vals);
  
  // Decode and verify round-trip
  const decoded = alp.decodeValues(compressed);
  let mismatches = 0;
  for (let i = 0; i < N; i++) {
    if (vals[i] !== decoded[i]) {
      console.log(`  MISMATCH at ${i}: ${vals[i]} !== ${decoded[i]}`);
      mismatches++;
      if (mismatches > 5) break;
    }
  }
  
  // Parse header to count exceptions
  const excCount = (compressed[12] << 8) | compressed[13];
  const oldSize = 14 + 0 + excCount * 10; // old format: header + 0 bitpacked + exc_count * (2+8)
  const oldBpt = oldSize / N;
  const improvement = oldBpt / (compressed.byteLength / N);
  
  console.log(`  ${name.padEnd(28)} ${(compressed.byteLength + ' B').padStart(8)} ${(compressed.byteLength / N).toFixed(3).padStart(8)} ${(excCount + '/' + N).padStart(12)} ${oldBpt.toFixed(3).padStart(10)}  ${improvement.toFixed(1).padStart(11)}×`);
  
  if (mismatches > 0) {
    console.log(`  ⚠ ${mismatches} MISMATCHES!`);
  }
}

console.log();

// Also test with real OTel data if available
try {
  const { loadOtelData } = await import(join(__dirname, 'load-otel.mjs'));
  const series = await loadOtelData(join(__dirname, 'data/cpu.jsonl'));
  
  // Find cpu.utilization series
  const utilSeries = series.filter(s => s.labels.get('__name__') === 'system.cpu.utilization');
  if (utilSeries.length > 0) {
    console.log(`Real OTel cpu.utilization (${utilSeries.length} series):\n`);
    
    let totalOld = 0, totalNew = 0, totalPts = 0;
    for (const s of utilSeries.slice(0, 4)) { // first 4 series
      const chunk = s.values.subarray(0, Math.min(640, s.values.length));
      const { compressed } = alp.encodeValuesWithStats(chunk);
      const decoded = alp.decodeValues(compressed);
      
      let ok = true;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== decoded[i]) { ok = false; break; }
      }
      
      const excCount = (compressed[12] << 8) | compressed[13];
      const oldSize = 14 + excCount * 10;
      
      totalOld += oldSize;
      totalNew += compressed.byteLength;
      totalPts += chunk.length;
      
      const state = s.labels.get('state') || '?';
      const cpu = s.labels.get('cpu') || '?';
      console.log(`  cpu=${cpu} state=${state}: ${chunk.length} pts, ${compressed.byteLength} B (${(compressed.byteLength / chunk.length).toFixed(2)} B/pt), exc=${excCount}, roundtrip=${ok ? '✓' : '✗'}`);
    }
    
    console.log(`\n  Totals: ${totalPts} pts`);
    console.log(`    Old format: ${totalOld} B (${(totalOld / totalPts).toFixed(2)} B/pt)`);
    console.log(`    New format: ${totalNew} B (${(totalNew / totalPts).toFixed(2)} B/pt)`);
    console.log(`    Improvement: ${(totalOld / totalNew).toFixed(1)}×`);
  }
} catch (e) {
  console.log(`  (skipping real OTel test: ${e.message})`);
}
