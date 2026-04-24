import { performance } from "node:perf_hooks";

import type { WasmCodecs } from "../dist/index.js";
import { loadBenchWasmCodecs, summarizeTimings } from "./common.js";

const NUM_SERIES = 32;
const CHUNK_SIZE = 256;
const NUM_CHUNKS = 1024;
const INTERVAL = 1_000;
const STEP = (CHUNK_SIZE * INTERVAL) / 2;
const ITERATIONS = 8;

type EncodedSeries = {
  blobs: Uint8Array[];
  chunkMinTs: number[];
  chunkMaxTs: number[];
};

type BenchResult = {
  mode: "copy" | "view";
  batchSize: number;
  medianMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];
  checksum: number;
};

function makeChunkValues(seriesIndex: number, chunkIndex: number): Float64Array {
  const values = new Float64Array(CHUNK_SIZE);
  const base = 100 + seriesIndex * 10 + chunkIndex * CHUNK_SIZE;
  for (let i = 0; i < CHUNK_SIZE; i++) {
    values[i] = base + (i % 10_000);
  }
  return values;
}

function encodeDataset(codecs: WasmCodecs): EncodedSeries[] {
  const out: EncodedSeries[] = [];
  for (let seriesIndex = 0; seriesIndex < NUM_SERIES; seriesIndex++) {
    const blobs: Uint8Array[] = [];
    const chunkMinTs: number[] = [];
    const chunkMaxTs: number[] = [];
    for (let chunkIndex = 0; chunkIndex < NUM_CHUNKS; chunkIndex++) {
      const values = makeChunkValues(seriesIndex, chunkIndex);
      blobs.push(codecs.valuesCodec.encodeValues(values));
      const chunkMinT = chunkIndex * CHUNK_SIZE * INTERVAL;
      chunkMinTs.push(chunkMinT);
      chunkMaxTs.push(chunkMinT + (CHUNK_SIZE - 1) * INTERVAL);
    }
    out.push({ blobs, chunkMinTs, chunkMaxTs });
  }
  return out;
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

function forEachRegularBucketSegment(
  len: number,
  chunkMinTN: number,
  interval: number,
  minTN: number,
  stepN: number,
  visit: (bucket: number, start: number, end: number) => void
): void {
  let start = 0;
  while (start < len) {
    const sampleTN = chunkMinTN + start * interval;
    const bucket = ((sampleTN - minTN) / stepN) | 0;
    const bucketEndTN = minTN + (bucket + 1) * stepN;
    const nextStart = Math.min(
      len,
      Math.max(start + 1, ceilDiv(bucketEndTN - chunkMinTN, interval))
    );
    visit(bucket, start, nextStart);
    start = nextStart;
  }
}

function sumRange(values: Float64Array, start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i++) {
    total += values[i] ?? 0;
  }
  return total;
}

function runBatchFold(
  dataset: EncodedSeries[],
  codecs: WasmCodecs,
  batchSize: number,
  mode: "copy" | "view"
): { checksum: number; bucketCount: number } {
  const totalPoints = CHUNK_SIZE * NUM_CHUNKS;
  const endT = (totalPoints - 1) * INTERVAL;
  const bucketCount = Math.floor(endT / STEP) + 1;
  const values = new Float64Array(bucketCount);
  const counts = new Float64Array(bucketCount);

  for (const series of dataset) {
    for (let chunkIndex = 0; chunkIndex < series.blobs.length; chunkIndex += batchSize) {
      const end = Math.min(series.blobs.length, chunkIndex + batchSize);
      const blobs = series.blobs.slice(chunkIndex, end);
      const decoded =
        batchSize === 1
          ? [
              mode === "view" && codecs.valuesCodec.decodeValuesView
                ? codecs.valuesCodec.decodeValuesView(blobs[0] ?? new Uint8Array(0))
                : codecs.valuesCodec.decodeValues(blobs[0] ?? new Uint8Array(0)),
            ]
          : mode === "view"
            ? (() => {
                if (!codecs.valuesCodec.decodeBatchValuesView) {
                  throw new Error(
                    `decodeBatchValuesView is required for batchSize=${batchSize} mode=${mode}`
                  );
                }
                return codecs.valuesCodec.decodeBatchValuesView(blobs, CHUNK_SIZE);
              })()
            : (() => {
                if (!codecs.valuesCodec.decodeBatchValues) {
                  throw new Error(
                    `decodeBatchValues is required for batchSize=${batchSize} mode=${mode}`
                  );
                }
                return codecs.valuesCodec.decodeBatchValues(blobs, CHUNK_SIZE);
              })();
      for (let i = 0; i < decoded.length; i++) {
        const vs = decoded[i] ?? new Float64Array(0);
        const idx = chunkIndex + i;
        const chunkMinT = series.chunkMinTs[idx] ?? 0;
        const chunkMaxT = series.chunkMaxTs[idx] ?? chunkMinT;
        const interval = (chunkMaxT - chunkMinT) / (vs.length - 1);
        forEachRegularBucketSegment(
          vs.length,
          chunkMinT,
          interval,
          0,
          STEP,
          (bucket, start, segEnd) => {
            values[bucket] = (values[bucket] ?? 0) + sumRange(vs, start, segEnd);
            counts[bucket] = (counts[bucket] ?? 0) + (segEnd - start);
          }
        );
      }
    }
  }

  let checksum = bucketCount;
  for (let i = 0; i < bucketCount; i++) {
    checksum =
      (checksum * 1315423911 + Math.round((values[i] ?? 0) * 1000) + (counts[i] ?? 0)) >>> 0;
  }
  return { checksum, bucketCount };
}

async function main() {
  const batchSizes = [1, 4, 8, 16, 32, 64, 128];
  const modes: Array<"copy" | "view"> = ["copy", "view"];
  const codecs = await loadBenchWasmCodecs();
  const dataset = encodeDataset(codecs);
  const baseline = runBatchFold(dataset, codecs, 1, "copy");
  const results: BenchResult[] = [];

  for (const mode of modes) {
    for (const batchSize of batchSizes) {
      if (mode === "view" && batchSize > 1 && !codecs.valuesCodec.decodeBatchValuesView) continue;
      if (mode === "view" && batchSize === 1 && !codecs.valuesCodec.decodeValuesView) continue;
      runBatchFold(dataset, codecs, batchSize, mode);
      const samples: number[] = [];
      let checksum = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        const result = runBatchFold(dataset, codecs, batchSize, mode);
        samples.push(performance.now() - t0);
        checksum = result.checksum;
        if (result.checksum !== baseline.checksum) {
          throw new Error(`checksum mismatch for mode=${mode} batchSize=${batchSize}`);
        }
      }
      const timing = summarizeTimings(samples);
      results.push({
        mode,
        batchSize,
        ...timing,
        checksum,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        dataset: {
          series: NUM_SERIES,
          chunkSize: CHUNK_SIZE,
          chunksPerSeries: NUM_CHUNKS,
          totalSamples: NUM_SERIES * CHUNK_SIZE * NUM_CHUNKS,
        },
        query: {
          agg: "sum",
          step: STEP,
          workload: "regular-half-chunk-step over all chunks",
        },
        results,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
