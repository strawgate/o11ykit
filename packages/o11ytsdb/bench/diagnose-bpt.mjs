#!/usr/bin/env node
import { loadOtelData } from './load-otel.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const series = await loadOtelData(join(__dirname, 'data/host-metrics.jsonl'));
const totalPts = series.reduce((s, x) => s + x.timestamps.length, 0);

console.log('Total series:', series.length);
console.log('Total points:', totalPts);
console.log('Avg pts/series:', (totalPts / series.length).toFixed(0));
console.log();

// Bucket series by length
const buckets = new Map();
for (const s of series) {
  const n = s.timestamps.length;
  const bucket = n < 50 ? '<50' : n < 200 ? '50-200' : n < 1000 ? '200-1K' : n < 10000 ? '1K-10K' : '10K+';
  const b = buckets.get(bucket) || { count: 0, pts: 0 };
  b.count++;
  b.pts += n;
  buckets.set(bucket, b);
}
const order = ['<50', '50-200', '200-1K', '1K-10K', '10K+'];
for (const key of order) {
  const b = buckets.get(key);
  if (b) console.log(`  ${key.padEnd(10)} ${String(b.count).padStart(4)} series  ${String(b.pts).padStart(8)} pts  ${((b.pts / totalPts) * 100).toFixed(1)}%`);
}
console.log();

const shortSeries = series.filter(s => s.timestamps.length < 128);
console.log(`Series with <128 pts (never freeze a full chunk): ${shortSeries.length} / ${series.length}`);
console.log(`Points in those short series: ${shortSeries.reduce((s, x) => s + x.timestamps.length, 0)}`);
console.log();

// Raw cost: 16 B/pt (8 ts + 8 val). With shared-ts column, ts is amortized.
// Estimate overhead: per-series fixed cost
// - hot buffers: chunkSize * 8 per value column, shared ts column
// - FrozenChunk metadata objects
// - Map entries, label strings
const estHotBufPerSeries = 128 * 8; // Float64Array hot values
const estLabelBytes = series.reduce((s, x) => {
  let lb = 0;
  for (const [k, v] of x.labels) lb += k.length + v.length + 40; // Map entry overhead
  return s + lb;
}, 0);
console.log(`Estimated label storage: ${(estLabelBytes / 1024).toFixed(0)} KB`);
console.log(`Estimated hot value buffers: ${(series.length * estHotBufPerSeries / 1024).toFixed(0)} KB`);

// Count groups and their sizes
const groups = new Map();
for (const s of series) {
  const name = s.labels.get('__name__');
  const g = groups.get(name) || { count: 0, pts: 0 };
  g.count++;
  g.pts += s.timestamps.length;
  groups.set(name, g);
}
console.log(`\nGroups (metric names): ${groups.size}`);
// Each group has its own hot timestamp buffer
console.log(`Estimated hot ts buffers (per group): ${(groups.size * 128 * 8 / 1024).toFixed(0)} KB`);
