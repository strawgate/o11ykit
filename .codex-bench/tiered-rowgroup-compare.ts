import { readFileSync } from "node:fs";
import path from "node:path";

import { ScanEngine } from "../packages/o11ytsdb/src/query.ts";
import { RowGroupStore } from "../packages/o11ytsdb/src/row-group-store.ts";
import { TieredRowGroupStore } from "../packages/o11ytsdb/src/tiered-row-group-store.ts";
import type { Labels } from "../packages/o11ytsdb/src/types.ts";
import { initWasmCodecs } from "../packages/o11ytsdb/src/wasm-codecs.ts";

const NUM_SERIES = 32;
const POINTS_PER_SERIES = 31_250; // 1,000,000 total
const BATCH = 64;
const INTERVAL = 1_000n;

function makeLabels(seriesIndex: number): Labels {
  return new Map([
    ["__name__", "cpu_usage"],
    ["host", `host-${String(seriesIndex).padStart(2, "0")}`],
    ["region", seriesIndex % 2 === 0 ? "us" : "eu"],
  ]);
}

function buildDataset(): Array<{ timestamps: BigInt64Array; values: Float64Array }> {
  return Array.from({ length: NUM_SERIES }, (_, s) => {
    const timestamps = new BigInt64Array(POINTS_PER_SERIES);
    const values = new Float64Array(POINTS_PER_SERIES);
    const base = 100 + s * 10;
    for (let i = 0; i < POINTS_PER_SERIES; i++) {
      timestamps[i] = BigInt(i) * INTERVAL;
      values[i] = base + (i % 10_000);
    }
    return { timestamps, values };
  });
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

async function main() {
  const wasm = new WebAssembly.Module(
    readFileSync(path.resolve("packages/o11ytsdb/wasm/o11ytsdb-rust.wasm"))
  );
  const codecs = await initWasmCodecs(wasm);
  const dataset = buildDataset();
  const labels = Array.from({ length: NUM_SERIES }, (_, s) => makeLabels(s));
  const current = new RowGroupStore(codecs.valuesCodec, 640, () => 0, 8, undefined, codecs.tsCodec);
  const tiered = new TieredRowGroupStore(
    codecs.valuesCodec,
    80,
    640,
    () => 0,
    8,
    undefined,
    codecs.tsCodec
  );
  const currentIds = labels.map((label) => current.getOrCreateSeries(label));
  const tieredIds = labels.map((label) => tiered.getOrCreateSeries(label));

  const ingestCurrentMs = timeMs(() => {
    for (let off = 0; off < POINTS_PER_SERIES; off += BATCH) {
      const end = Math.min(off + BATCH, POINTS_PER_SERIES);
      for (let s = 0; s < NUM_SERIES; s++) {
        const series = dataset[s];
        current.appendBatch(
          currentIds[s],
          series.timestamps.subarray(off, end),
          series.values.subarray(off, end)
        );
      }
    }
  });

  const ingestTieredMs = timeMs(() => {
    for (let off = 0; off < POINTS_PER_SERIES; off += BATCH) {
      const end = Math.min(off + BATCH, POINTS_PER_SERIES);
      for (let s = 0; s < NUM_SERIES; s++) {
        const series = dataset[s];
        tiered.appendBatch(
          tieredIds[s],
          series.timestamps.subarray(off, end),
          series.values.subarray(off, end)
        );
      }
    }
  });

  const engine = new ScanEngine();
  const query = {
    metric: "cpu_usage",
    matchers: [{ label: "region", op: "=" as const, value: "us" }],
    start: 0n,
    end: BigInt(POINTS_PER_SERIES - 1) * INTERVAL,
    agg: "sum" as const,
    step: 300_000n,
  };

  const currentQueryMs = timeMs(() => {
    engine.query(current, query);
  });
  const tieredQueryMs = timeMs(() => {
    engine.query(tiered, query);
  });

  console.log(
    JSON.stringify(
      {
        current640: {
          sampleCount: current.sampleCount,
          memoryBytes: current.memoryBytes(),
          bytesPerSample: Number((current.memoryBytes() / current.sampleCount).toFixed(4)),
          ingestMs: Number(ingestCurrentMs.toFixed(3)),
          queryMs: Number(currentQueryMs.toFixed(3)),
        },
        tiered80to640: {
          sampleCount: tiered.sampleCount,
          memoryBytes: tiered.memoryBytes(),
          bytesPerSample: Number((tiered.memoryBytes() / tiered.sampleCount).toFixed(4)),
          ingestMs: Number(ingestTieredMs.toFixed(3)),
          queryMs: Number(tieredQueryMs.toFixed(3)),
        },
      },
      null,
      2
    )
  );
}

void main();
