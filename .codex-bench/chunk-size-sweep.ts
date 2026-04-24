import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ScanEngine } from "../packages/o11ytsdb/src/query.ts";
import { RowGroupStore } from "../packages/o11ytsdb/src/row-group-store.ts";
import { initWasmCodecs } from "../packages/o11ytsdb/src/wasm-codecs.ts";

const NUM_SERIES = 32;
const POINTS_PER_SERIES = 262_144;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;
const INTERVAL = 1_000n;

function makeLabels(seriesIndex: number) {
  return new Map([
    ["__name__", "cpu_usage"],
    ["host", `host-${String(seriesIndex).padStart(2, "0")}`],
    ["region", seriesIndex % 2 === 0 ? "us" : "eu"],
  ]);
}

function makeSeriesData(seriesIndex: number): {
  timestamps: BigInt64Array;
  values: Float64Array;
} {
  const timestamps = new BigInt64Array(POINTS_PER_SERIES);
  const values = new Float64Array(POINTS_PER_SERIES);
  const base = 100 + seriesIndex * 10;
  for (let i = 0; i < POINTS_PER_SERIES; i++) {
    timestamps[i] = BigInt(i) * INTERVAL;
    values[i] = base + (i % 10_000);
  }
  return { timestamps, values };
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main() {
  const wasm = new WebAssembly.Module(
    readFileSync(path.resolve("packages/o11ytsdb/wasm/o11ytsdb-rust.wasm"))
  );
  const codecs = await initWasmCodecs(wasm);
  const engine = new ScanEngine();
  const iterations = Number.parseInt(process.argv[2] ?? "6", 10);
  const chunkSizes =
    process.argv.length > 3
      ? process.argv
          .slice(3)
          .map((arg) => Number.parseInt(arg, 10))
          .filter((value) => Number.isFinite(value) && value > 0)
      : [64, 128, 192, 256, 320, 512, 640];
  const stepSamplesList = [300, 900];

  for (const chunkSize of chunkSizes) {
    const store = new RowGroupStore(
      codecs.valuesCodec,
      chunkSize,
      () => 0,
      8,
      undefined,
      codecs.tsCodec
    );
    for (let s = 0; s < NUM_SERIES; s++) {
      const id = store.getOrCreateSeries(makeLabels(s));
      const { timestamps, values } = makeSeriesData(s);
      store.appendBatch(id, timestamps, values);
    }

    const row: Record<string, number> = {
      chunkSize,
      memPerSample: Number((store.memoryBytes() / TOTAL_SAMPLES).toFixed(4)),
    };

    for (const stepSamples of stepSamplesList) {
      const opts = {
        metric: "cpu_usage",
        start: 0n,
        end: BigInt(POINTS_PER_SERIES - 1) * INTERVAL,
        agg: "sum" as const,
        step: BigInt(stepSamples) * INTERVAL,
      };
      engine.query(store, opts);
      const timings: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        engine.query(store, opts);
        timings.push(performance.now() - t0);
      }
      row[`step${stepSamples}`] = Number(median(timings).toFixed(3));
    }

    console.log(JSON.stringify(row));
  }
}

void main();
