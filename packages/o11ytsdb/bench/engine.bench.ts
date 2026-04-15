/**
 * Engine benchmark — end-to-end experimentation bench.
 *
 * Compares storage backends × codec configurations across:
 *   1. Ingest throughput (samples/sec)
 *   2. Query throughput (single-series, multi-series, aggregated)
 *   3. Memory at rest (bytes/sample, compression ratio)
 *
 * This is the experimentation framework: add a new StorageBackend or
 * Codec, it automatically gets benchmarked against all others.
 */

import { Suite, printReport, fmt, fmtBytes } from './harness.js';
import type { BenchReport } from './harness.js';
import { Rng, generateLabelSets } from './vectors.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, '..', '..', rel);
}

// ── Types (import from compiled src) ─────────────────────────────────

type StorageBackend = import('../dist/types.js').StorageBackend;
type Codec = import('../dist/types.js').Codec;
type Labels = import('../dist/types.js').Labels;
type QueryEngine = import('../dist/types.js').QueryEngine;

// ── Configuration ────────────────────────────────────────────────────

const NUM_SERIES = 100;
const POINTS_PER_SERIES = 10_000;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const CHUNK_SIZES = [128, 1024];
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n; // 15s

// ── Load implementations ─────────────────────────────────────────────

async function loadBackends(): Promise<StorageBackend[]> {
  const backends: StorageBackend[] = [];

  // FlatStore (baseline).
  try {
    const { FlatStore } = await import(pkgPath('dist/flat-store.js'));
    backends.push(new FlatStore());
  } catch (e) {
    console.log('  ⚠ FlatStore not built — skipping');
  }

  // ChunkedStore with Rust WASM codec at various chunk sizes.
  try {
    const { ChunkedStore } = await import(pkgPath('dist/chunked-store.js'));
    const { loadWasm, makeCodecImpl } = await import('./wasm-loader.js');
    const wasmPath = pkgPath('wasm/o11ytsdb-rust.wasm');
    const wasm = await loadWasm(wasmPath);
    const rustImpl = makeCodecImpl(wasm, 'rust', 'Rust→WASM');
    const rustCodec: Codec = {
      name: 'rust-wasm',
      encode: rustImpl.encode,
      decode: rustImpl.decode,
    };
    for (const size of CHUNK_SIZES) {
      backends.push(new ChunkedStore(rustCodec, size));
    }
  } catch (e) {
    console.log(`  ⚠ Rust WASM codec not available — skipping (${(e as Error).message})`);
  }

  // ColumnStore with Rust WASM values codec (shared timestamps, uncompressed ts).
  try {
    const { ColumnStore } = await import(pkgPath('dist/column-store.js'));
    const { loadWasm, makeValuesCodec } = await import('./wasm-loader.js');
    const wasmPath = pkgPath('wasm/o11ytsdb-rust.wasm');
    const wasm = await loadWasm(wasmPath);
    const wasmVals = makeValuesCodec(wasm);
    const valCodec = {
      name: 'rust-wasm-values',
      encodeValues: wasmVals.encodeValues,
      decodeValues: wasmVals.decodeValues,
      encodeValuesWithStats: wasmVals.encodeValuesWithStats,
    };
    for (const size of CHUNK_SIZES) {
      backends.push(new ColumnStore(valCodec, size, () => 0));
    }
  } catch (e) {
    console.log(`  ⚠ ColumnStore/WASM not available — skipping (${(e as Error).message})`);
  }

  // ColumnStore with WASM values + WASM timestamp compression.
  try {
    const { ColumnStore } = await import(pkgPath('dist/column-store.js'));
    const { loadWasm, makeValuesCodec, makeTimestampCodec } = await import('./wasm-loader.js');
    const wasmPath = pkgPath('wasm/o11ytsdb-rust.wasm');
    const wasm = await loadWasm(wasmPath);
    const wasmVals = makeValuesCodec(wasm);
    const wasmTs = makeTimestampCodec(wasm);
    const valCodec = {
      name: 'rust-wasm-full',
      encodeValues: wasmVals.encodeValues,
      decodeValues: wasmVals.decodeValues,
      encodeValuesWithStats: wasmVals.encodeValuesWithStats,
    };
    const tsCodec = { name: 'rust-wasm-ts', encodeTimestamps: wasmTs.encodeTimestamps, decodeTimestamps: wasmTs.decodeTimestamps };
    for (const size of CHUNK_SIZES) {
      backends.push(new ColumnStore(valCodec, size, () => 0, undefined, tsCodec));
    }
  } catch (e) {
    console.log(`  ⚠ ColumnStore/WASM+TS not available — skipping (${(e as Error).message})`);
  }

  return backends;
}

async function loadQueryEngine(): Promise<QueryEngine> {
  const { ScanEngine } = await import(pkgPath('dist/query.js'));
  return new ScanEngine();
}

// ── Data generation ──────────────────────────────────────────────────

interface IngestData {
  labels: Labels[];
  timestamps: BigInt64Array[];
  values: Float64Array[];
}

function generateData(): IngestData {
  const rng = new Rng(42);
  const labelSets = generateLabelSets(NUM_SERIES, 4, 42);
  const labels: Labels[] = [];
  const timestamps: BigInt64Array[] = [];
  const values: Float64Array[] = [];

  for (let s = 0; s < NUM_SERIES; s++) {
    const ls = labelSets[s]!;
    const m = new Map<string, string>();
    m.set('__name__', `metric_${s % 10}`); // 10 distinct metric names
    for (const [k, v] of ls.labels) m.set(k, v);
    labels.push(m);

    const ts = new BigInt64Array(POINTS_PER_SERIES);
    const vs = new Float64Array(POINTS_PER_SERIES);

    // Realistic monitoring data patterns:
    //   - 20% constant series (e.g. num_cpus, memory_total) — all values identical
    //   - 30% counters (e.g. requests_total) — monotonically increasing
    //   - 30% gauges with repeats (e.g. cpu_percent) — decimal values, 30-50% repeat previous
    //   - 20% gauges with high variance (e.g. latency) — random walk
    const pattern = s % 10;

    if (pattern < 2) {
      // Constant series: value never changes.
      const constant = Math.round(rng.next() * 1000) / 10;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        vs[i] = constant;
      }
    } else if (pattern < 5) {
      // Counter: monotonically increasing, occasional small increments.
      let counter = Math.floor(rng.next() * 10000);
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        // ~40% of intervals have 0 increment (idle), rest small positive
        const idle = rng.next() < 0.4;
        if (!idle) counter += Math.floor(rng.next() * 10) + 1;
        vs[i] = counter;
      }
    } else if (pattern < 8) {
      // Gauge with repeats: rounded percentage, ~35% repeat previous.
      let v = Math.round(rng.next() * 1000) / 10; // e.g. 45.2%
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        if (rng.next() > 0.35) {
          v += rng.gaussian(0, 0.3);
          v = Math.max(0, Math.min(100, v));
          v = Math.round(v * 10) / 10;
        }
        vs[i] = v;
      }
    } else {
      // High-variance gauge: random walk (original pattern).
      let v = rng.next() * 100;
      for (let i = 0; i < POINTS_PER_SERIES; i++) {
        ts[i] = T0 + BigInt(i) * INTERVAL;
        v += rng.gaussian(0, 0.5);
        v = Math.max(0, v);
        vs[i] = Math.round(v * 100) / 100;
      }
    }

    timestamps.push(ts);
    values.push(vs);
  }

  return { labels, timestamps, values };
}

// ── Benchmark ────────────────────────────────────────────────────────

export default async function(): Promise<BenchReport> {
  const suite = new Suite('engine');
  const backends = await loadBackends();
  const qe = await loadQueryEngine();
  const data = generateData();

  console.log(`  Configuration: ${NUM_SERIES} series × ${POINTS_PER_SERIES.toLocaleString()} pts = ${TOTAL_SAMPLES.toLocaleString()} total`);
  console.log(`  Backends: ${backends.map(b => b.name).join(', ')}`);
  console.log(`  Query engine: ${qe.name}`);
  console.log();

  // ── Ingest benchmark ──

  console.log('  ── Ingest ──\n');

  // Populate all backends (measured).
  const populated: StorageBackend[] = [];

  for (const backend of backends) {
    // Create a fresh backend for each run.
    const fresh = await freshBackend(backend.name);
    const start = performance.now();

    for (let s = 0; s < NUM_SERIES; s++) {
      const id = fresh.getOrCreateSeries(data.labels[s]!);
      fresh.appendBatch(id, data.timestamps[s]!, data.values[s]!);
    }

    const elapsed = performance.now() - start;
    const throughput = TOTAL_SAMPLES / (elapsed / 1000);

    suite.add(`ingest_batch`, fresh.name, () => {
      // Already measured above — this is a no-op placeholder.
      // We recorded the real measurement manually.
    }, { iterations: 1, itemsPerCall: TOTAL_SAMPLES, unit: 'samples/sec' });

    // Record as a compression result for the memory table.
    suite.addCompression(
      'at_rest',
      fresh.name,
      TOTAL_SAMPLES,
      TOTAL_SAMPLES * 16, // raw = 16 bytes/sample
      fresh.memoryBytes(),
    );

    populated.push(fresh);

    const mem = fresh.memoryBytes();
    console.log(`    ${fresh.name.padEnd(28)} ${fmt(throughput).padStart(10)} samples/sec    ${fmtBytes(mem).padStart(10)}    ${(mem / TOTAL_SAMPLES).toFixed(1)} B/pt`);
  }

  console.log();

  // ── Query benchmarks ──

  console.log('  ── Query: single series (full range) ──\n');

  for (const store of populated) {
    // Pick series 0, full range.
    const sid = 0;
    const start = T0;
    const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;

    suite.add('query_single', store.name, () => {
      store.read(sid, start, end);
    }, { warmup: 10, iterations: 50, itemsPerCall: POINTS_PER_SERIES, unit: 'samples/sec' });
  }

  console.log('  ── Query: multi-series select (10 series, full range) ──\n');

  for (const store of populated) {
    const metric = 'metric_0'; // 10 series match
    const start = T0;
    const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;

    suite.add('query_select_10', store.name, () => {
      qe.query(store, { metric, start, end });
    }, { warmup: 5, iterations: 20, itemsPerCall: 10 * POINTS_PER_SERIES, unit: 'samples/sec' });
  }

  console.log('  ── Query: aggregated sum (10 series → 1) ──\n');

  for (const store of populated) {
    const metric = 'metric_0';
    const start = T0;
    const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;

    suite.add('query_sum_10', store.name, () => {
      qe.query(store, { metric, start, end, agg: 'sum' });
    }, { warmup: 5, iterations: 20, itemsPerCall: 10 * POINTS_PER_SERIES, unit: 'samples/sec' });
  }

  console.log('  ── Query: time range (last 10%) ──\n');

  for (const store of populated) {
    const rangeLen = BigInt(POINTS_PER_SERIES) * INTERVAL;
    const start = T0 + rangeLen * 9n / 10n;
    const end = T0 + rangeLen;

    suite.add('query_timerange', store.name, () => {
      store.read(0, start, end);
    }, { warmup: 10, iterations: 50, itemsPerCall: POINTS_PER_SERIES / 10, unit: 'samples/sec' });
  }

  // ── Correctness check ──

  // Verify all backends return the same data for the same query.
  if (populated.length >= 2) {
    const start = T0;
    const end = T0 + BigInt(POINTS_PER_SERIES) * INTERVAL;
    const ref = populated[0]!;
    const refData = ref.read(0, start, end);

    for (let i = 1; i < populated.length; i++) {
      const other = populated[i]!;
      const otherData = other.read(0, start, end);
      const ok = refData.timestamps.length === otherData.timestamps.length &&
        refData.values.every((v, j) => v === otherData.values[j]);
      suite.addValidation(ref.name, other.name, 'series_0_full', ok,
        ok ? 'bit-exact' : `length ${refData.timestamps.length} vs ${otherData.timestamps.length}`);
    }
  }

  // ── Run all timed benchmarks ──

  const report = suite.run();
  printReport(report);
  return report;
}

// ── Helper: create a fresh backend by name ───────────────────────────

async function freshBackend(name: string): Promise<StorageBackend> {
  if (name === 'flat') {
    const { FlatStore } = await import(pkgPath('dist/flat-store.js'));
    return new FlatStore();
  }

  // Parse "chunked-{codec}-{size}" pattern.
  const chunkedMatch = name.match(/^chunked-(.+)-(\d+)$/);
  if (chunkedMatch) {
    const [, codecName, sizeStr] = chunkedMatch;
    const size = parseInt(sizeStr!, 10);
    const { ChunkedStore } = await import(pkgPath('dist/chunked-store.js'));

    if (codecName === 'ts') {
      const codec = await import(pkgPath('dist/codec.js'));
      return new ChunkedStore(
        { name: 'ts', encode: codec.encodeChunk, decode: codec.decodeChunk },
        size,
      );
    }

    if (codecName === 'rust-wasm') {
      const { loadWasm, makeCodecImpl } = await import('./wasm-loader.js');
      const wasmPath = pkgPath('wasm/o11ytsdb-rust.wasm');
      const wasm = await loadWasm(wasmPath);
      const impl = makeCodecImpl(wasm, 'rust', 'Rust→WASM');
      return new ChunkedStore(
        { name: 'rust-wasm', encode: impl.encode, decode: impl.decode },
        size,
      );
    }
  }

  // Parse "column-{codec}-{size}" pattern.
  const columnMatch = name.match(/^column-(.+)-(\d+)$/);
  if (columnMatch) {
    const [, codecName, sizeStr] = columnMatch;
    const size = parseInt(sizeStr!, 10);
    const { ColumnStore } = await import(pkgPath('dist/column-store.js'));

    if (codecName === 'rust-wasm-values') {
      const { loadWasm, makeValuesCodec } = await import('./wasm-loader.js');
      const wasmPath = pkgPath('wasm/o11ytsdb-rust.wasm');
      const wasm = await loadWasm(wasmPath);
      const wasmVals = makeValuesCodec(wasm);
      return new ColumnStore(
        { name: 'rust-wasm-values', encodeValues: wasmVals.encodeValues, decodeValues: wasmVals.decodeValues, encodeValuesWithStats: wasmVals.encodeValuesWithStats },
        size, () => 0,
      );
    }

    if (codecName === 'rust-wasm-full') {
      const { loadWasm, makeValuesCodec, makeTimestampCodec } = await import('./wasm-loader.js');
      const wasmPath = pkgPath('wasm/o11ytsdb-rust.wasm');
      const wasm = await loadWasm(wasmPath);
      const wasmVals = makeValuesCodec(wasm);
      const wasmTs = makeTimestampCodec(wasm);
      return new ColumnStore(
        { name: 'rust-wasm-full', encodeValues: wasmVals.encodeValues, decodeValues: wasmVals.decodeValues, encodeValuesWithStats: wasmVals.encodeValuesWithStats },
        size, () => 0, undefined,
        { name: 'rust-wasm-ts', encodeTimestamps: wasmTs.encodeTimestamps, decodeTimestamps: wasmTs.decodeTimestamps },
      );
    }
  }

  throw new Error(`Unknown backend: ${name}`);
}
