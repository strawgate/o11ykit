/**
 * End-to-end benchmark: WASM ALP vs WASM XOR vs plain JS codecs
 * across the full ingest → compress → query pipeline.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ColumnStore } from "../src/column-store.js";
import { ScanEngine } from "../src/query.js";
import type { ValuesCodec, TimestampCodec, RangeDecodeCodec } from "../src/types.js";
import { initWasmCodecs } from "../src/wasm-codecs.js";

// ── Constants ─────────────────────────────────────────────────────────

const NUM_SERIES = 256;
const CHUNK_SIZE = 640;
const SAMPLES_PER_SERIES = CHUNK_SIZE; // exactly 1 full chunk
const INGEST_ITERS = 10;
const QUERY_ITERS = 50;
const RAW_BYTES = NUM_SERIES * SAMPLES_PER_SERIES * 8; // 1.31 MB

// Seeded PRNG for reproducible benchmarks (xoshiro128**)
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Data generation ───────────────────────────────────────────────────

interface SeriesData {
  name: string;
  kind: string;
  timestamps: BigInt64Array;
  values: Float64Array;
}

function generateData(): SeriesData[] {
  const series: SeriesData[] = [];
  const baseT = 1_700_000_000_000_000_000n; // ~2023 in nanoseconds
  const stepNs = 15_000_000_000n; // 15s scrape interval
  const rng = mulberry32(42);
  const kinds = ["constant", "counter", "gauge", "high-precision"];

  for (let s = 0; s < NUM_SERIES; s++) {
    const ts = new BigInt64Array(SAMPLES_PER_SERIES);
    const vals = new Float64Array(SAMPLES_PER_SERIES);
    const quarter = Math.floor(s / (NUM_SERIES / 4));

    for (let i = 0; i < SAMPLES_PER_SERIES; i++) {
      ts[i] = baseT + BigInt(i) * stepNs;

      switch (quarter) {
        case 0: // constant (25%)
          vals[i] = 0.0;
          break;
        case 1: // monotonic counter (25%)
          vals[i] = i * 42;
          break;
        case 2: // gauge with 2 decimal places (25%)
          vals[i] = Math.round((Math.sin(i * 0.05) * 100 + 200) * 100) / 100;
          break;
        case 3: // high-precision cpu_util ratio (25%) — 15+ decimal digits
          vals[i] = rng() * 0.01 + 0.5;
          break;
      }
    }
    series.push({ name: `series_${s}`, kind: kinds[quarter]!, timestamps: ts, values: vals });
  }
  return series;
}

// ── Plain JS codec (f64-plain, no compression — baseline) ────────────

function createPlainJsCodec(): ValuesCodec {
  return {
    name: "f64-plain",
    encodeValues(values: Float64Array): Uint8Array {
      const out = new Uint8Array(4 + values.byteLength);
      new DataView(out.buffer).setUint32(0, values.length, true);
      out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
      return out;
    },
    decodeValues(buf: Uint8Array): Float64Array {
      if (buf.byteLength < 4) return new Float64Array(0);
      const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      const raw = buf.subarray(4);
      const bytes = raw.byteLength - (raw.byteLength % 8);
      const copy = raw.slice(0, bytes);
      return new Float64Array(copy.buffer, copy.byteOffset, Math.min(n, Math.floor(bytes / 8)));
    },
  };
}

// ── Codec config ──────────────────────────────────────────────────────

interface CodecConfig {
  label: string;
  valuesCodec: ValuesCodec;
  tsCodec?: TimestampCodec;
  rangeCodec?: RangeDecodeCodec;
}

// ── Benchmark helpers ─────────────────────────────────────────────────

function createStore(cfg: CodecConfig): ColumnStore {
  return new ColumnStore(
    cfg.valuesCodec,
    CHUNK_SIZE,
    () => 0,
    cfg.label,
    cfg.tsCodec,
    cfg.rangeCodec,
  );
}

function ingestAll(store: ColumnStore, data: SeriesData[]): void {
  for (const s of data) {
    const labels = new Map([["__name__", s.name]]);
    const id = store.getOrCreateSeries(labels);
    store.appendBatch(id, s.timestamps, s.values);
  }
}

function benchIngest(cfg: CodecConfig, data: SeriesData[]): { elapsedMs: number; store: ColumnStore } {
  // Warmup
  const warmup = createStore(cfg);
  ingestAll(warmup, data);

  // Timed iterations — each iteration starts a fresh store
  const start = performance.now();
  let store!: ColumnStore;
  for (let i = 0; i < INGEST_ITERS; i++) {
    store = createStore(cfg);
    ingestAll(store, data);
  }
  const elapsedMs = performance.now() - start;
  return { elapsedMs, store };
}

function measureCompression(store: ColumnStore): number {
  return store.memoryBytes();
}

function benchQuery(
  store: ColumnStore,
  engine: ScanEngine,
  data: SeriesData[],
  fullRange: boolean,
): { elapsedMs: number; totalSamples: number } {
  const startT = data[0]!.timestamps[0]!;
  const endT = data[0]!.timestamps[SAMPLES_PER_SERIES - 1]!;

  const queryStart = fullRange ? startT : endT - (endT - startT) / 10n; // last 10%
  const queryEnd = endT;

  // Warmup
  for (const s of data) {
    engine.query(store, { metric: s.name, start: queryStart, end: queryEnd });
  }

  let totalSamples = 0;
  const start = performance.now();
  for (let iter = 0; iter < QUERY_ITERS; iter++) {
    for (const s of data) {
      const result = engine.query(store, { metric: s.name, start: queryStart, end: queryEnd });
      totalSamples += result.scannedSamples;
    }
  }
  const elapsedMs = performance.now() - start;
  return { elapsedMs, totalSamples };
}

// ── Main benchmark ────────────────────────────────────────────────────

describe("E2E Benchmark: codec comparison", { timeout: 120_000 }, () => {
  it("compares JS plain vs WASM XOR vs WASM ALP across ingest→compress→query", async () => {
    // Load WASM
    const wasmPath = resolve(__dirname, "../wasm/o11ytsdb-rust.wasm");
    const wasmBuf = readFileSync(wasmPath);
    const wasmModule = new WebAssembly.Module(wasmBuf);
    const wasm = await initWasmCodecs(wasmModule);

    const configs: CodecConfig[] = [
      { label: "JS Plain (f64)", valuesCodec: createPlainJsCodec() },
      { label: "WASM XOR (Gorilla)", valuesCodec: wasm.xorValuesCodec, tsCodec: wasm.tsCodec },
      { label: "WASM ALP", valuesCodec: wasm.valuesCodec, tsCodec: wasm.tsCodec, rangeCodec: wasm.rangeCodec },
    ];

    const data = generateData();
    const engine = new ScanEngine();

    interface Result {
      label: string;
      ingestMs: number;
      ingestSamplesPerSec: number;
      compressedBytes: number;
      compressionRatio: number;
      fullQueryMs: number;
      fullQuerySamplesPerSec: number;
      rangeQueryMs: number;
      rangeQuerySamplesPerSec: number;
    }

    const results: Result[] = [];

    for (const cfg of configs) {
      // ── Ingest benchmark ──
      const { elapsedMs: ingestMs, store } = benchIngest(cfg, data);
      const totalIngestSamples = INGEST_ITERS * NUM_SERIES * SAMPLES_PER_SERIES;
      const ingestSamplesPerSec = (totalIngestSamples / ingestMs) * 1000;

      // Verify data integrity
      expect(store.seriesCount).toBe(NUM_SERIES);
      expect(store.sampleCount).toBe(NUM_SERIES * SAMPLES_PER_SERIES);

      // ── Compression ratio ──
      const compressedBytes = measureCompression(store);
      const compressionRatio = RAW_BYTES / compressedBytes;

      // ── Full query benchmark ──
      const fullQ = benchQuery(store, engine, data, true);

      // ── Range query benchmark (last 10%) ──
      const rangeQ = benchQuery(store, engine, data, false);

      results.push({
        label: cfg.label,
        ingestMs,
        ingestSamplesPerSec,
        compressedBytes,
        compressionRatio,
        fullQueryMs: fullQ.elapsedMs,
        fullQuerySamplesPerSec: (fullQ.totalSamples / fullQ.elapsedMs) * 1000,
        rangeQueryMs: rangeQ.elapsedMs,
        rangeQuerySamplesPerSec: (rangeQ.totalSamples / rangeQ.elapsedMs) * 1000,
      });
    }

    // ── Codec-level compression breakdown (values only, no overhead) ──
    const codecConfigs: Array<{ label: string; codec: ValuesCodec }> = [
      { label: "JS Plain (f64)", codec: createPlainJsCodec() },
      { label: "WASM XOR (Gorilla)", codec: wasm.xorValuesCodec },
      { label: "WASM ALP", codec: wasm.valuesCodec },
    ];

    interface CompressionBreakdown {
      label: string;
      byKind: Map<string, { rawBytes: number; compressedBytes: number }>;
      totalRaw: number;
      totalCompressed: number;
    }

    const compressionDetails: CompressionBreakdown[] = [];
    for (const cc of codecConfigs) {
      const byKind = new Map<string, { rawBytes: number; compressedBytes: number }>();
      let totalRaw = 0;
      let totalCompressed = 0;
      for (const s of data) {
        const raw = s.values.byteLength;
        const compressed = cc.codec.encodeValues(s.values).byteLength;
        totalRaw += raw;
        totalCompressed += compressed;
        const prev = byKind.get(s.kind) ?? { rawBytes: 0, compressedBytes: 0 };
        prev.rawBytes += raw;
        prev.compressedBytes += compressed;
        byKind.set(s.kind, prev);
      }
      compressionDetails.push({ label: cc.label, byKind, totalRaw, totalCompressed });
    }

    // ── Print results table ──
    const sep = "─".repeat(108);
    const lines: string[] = [
      "",
      sep,
      "  E2E BENCHMARK: 256 series × 640 samples × 10 ingest iterations",
      `  Raw data size (values only): ${(RAW_BYTES / 1024).toFixed(0)} KB`,
      sep,
      "",
      "  ▸ Pipeline performance (ingest + compress + query)",
      "",
      padRow("Codec", "Ingest (M samp/s)", "Memory (KB)", "Full Query (M s/s)", "Range 10% (M s/s)"),
      padRow("─────", "─────────────────", "───────────", "──────────────────", "─────────────────"),
    ];

    for (const r of results) {
      lines.push(
        padRow(
          r.label,
          (r.ingestSamplesPerSec / 1e6).toFixed(2),
          (r.compressedBytes / 1024).toFixed(1),
          (r.fullQuerySamplesPerSec / 1e6).toFixed(2),
          (r.rangeQuerySamplesPerSec / 1e6).toFixed(2),
        ),
      );
    }

    lines.push("");

    // Relative speedups
    const jsResult = results[0]!;
    for (let i = 1; i < results.length; i++) {
      const r = results[i]!;
      lines.push(
        `  ${r.label} vs ${jsResult.label}:` +
        `  ingest ${(r.ingestSamplesPerSec / jsResult.ingestSamplesPerSec).toFixed(2)}x` +
        `  | full-query ${(r.fullQuerySamplesPerSec / jsResult.fullQuerySamplesPerSec).toFixed(2)}x` +
        `  | range-query ${(r.rangeQuerySamplesPerSec / jsResult.rangeQuerySamplesPerSec).toFixed(2)}x`,
      );
    }

    lines.push("");
    lines.push("  ▸ Values-only compression ratio by data type");
    lines.push("");

    const kindNames = ["constant", "counter", "gauge", "high-precision"];
    const hdr = ["Codec", ...kindNames, "Overall"];
    lines.push(padRowN(hdr));
    lines.push(padRowN(hdr.map((h) => "─".repeat(h.length))));

    for (const cd of compressionDetails) {
      const cols = [cd.label];
      for (const k of kindNames) {
        const d = cd.byKind.get(k)!;
        cols.push((d.rawBytes / d.compressedBytes).toFixed(2) + "x");
      }
      cols.push((cd.totalRaw / cd.totalCompressed).toFixed(2) + "x");
      lines.push(padRowN(cols));
    }

    lines.push("");
    lines.push(sep);
    lines.push("");

    // biome-ignore lint/suspicious/noConsole: benchmark output
    console.log(lines.join("\n"));

    // Sanity checks
    for (const r of results) {
      expect(r.ingestSamplesPerSec).toBeGreaterThan(0);
      expect(r.compressedBytes).toBeGreaterThan(0);
    }
  });
});

function padRow(...cols: string[]): string {
  const widths = [22, 18, 14, 20, 20];
  return "  " + cols.map((c, i) => c.padEnd(widths[i] ?? 16)).join("  ");
}

function padRowN(cols: string[]): string {
  const widths = [22, 12, 12, 12, 16, 10];
  return "  " + cols.map((c, i) => c.padEnd(widths[i] ?? 12)).join("  ");
}
