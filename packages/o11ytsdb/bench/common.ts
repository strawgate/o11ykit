import { readFileSync } from "node:fs";
import path from "node:path";

import { initWasmCodecs, type WasmCodecs } from "../dist/index.js";

export type TimingSummary = {
  minMs: number;
  medianMs: number;
  avgMs: number;
  maxMs: number;
  samples: number[];
};

export function loadBenchWasmModule(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(path.resolve("wasm/o11ytsdb-rust.wasm")));
}

export async function loadBenchWasmCodecs(): Promise<WasmCodecs> {
  return initWasmCodecs(loadBenchWasmModule());
}

export function meanMs(samples: number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

export function medianMs(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

export function summarizeTimings(samples: number[]): TimingSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianValue =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
        ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
        : (sorted[mid] ?? 0);
  return {
    minMs: sorted[0] ?? 0,
    medianMs: medianValue,
    avgMs: meanMs(samples),
    maxMs: sorted[sorted.length - 1] ?? 0,
    samples,
  };
}

export function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

export function collectTimingSamples(iterations: number, fn: () => void): number[] {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    samples.push(timeMs(fn));
  }
  return samples;
}
