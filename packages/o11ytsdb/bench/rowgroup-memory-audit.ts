import { readFileSync } from "node:fs";
import path from "node:path";

import { RowGroupStore } from "../src/row-group-store.ts";
import { initWasmCodecs } from "../src/wasm-codecs.ts";

const NUM_SERIES = 32;
const POINTS_PER_SERIES = 262_144;
const INTERVAL = 1_000n;
const TOTAL_SAMPLES = NUM_SERIES * POINTS_PER_SERIES;

type AuditTimestampChunk = {
  timestamps?: BigInt64Array;
  compressed?: Uint8Array;
};

type AuditRowGroup = {
  valueBuffer: Uint8Array;
  offsets: Uint32Array;
  sizes: Uint32Array;
  packedStats: Float64Array;
};

type AuditHot = {
  values: Float64Array;
  count: number;
};

type AuditLane = {
  hotTimestamps: BigInt64Array;
  frozenTimestamps: AuditTimestampChunk[];
  rowGroups: AuditRowGroup[];
};

type AuditGroup = {
  lanes: AuditLane[];
};

type AuditSegment = {
  hot: AuditHot;
};

type AuditSeries = {
  segments: AuditSegment[];
};

type AuditLabelIndex = {
  memoryBytes(): number;
};

type AuditStore = RowGroupStore & {
  groups: AuditGroup[];
  allSeries: AuditSeries[];
  labelIndex: AuditLabelIndex;
};

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

async function main() {
  const chunkSize = Number.parseInt(process.argv[2] ?? "256", 10);
  const wasm = new WebAssembly.Module(
    readFileSync(path.resolve("packages/o11ytsdb/wasm/o11ytsdb-rust.wasm"))
  );
  const codecs = await initWasmCodecs(wasm);
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

  const anyStore = store as unknown as AuditStore;
  let hotTimestamps = 0;
  let frozenTimestampsCompressed = 0;
  let frozenTimestampsDecoded = 0;
  let rowGroupValueBuffer = 0;
  let rowGroupOffsets = 0;
  let rowGroupSizes = 0;
  let rowGroupPackedStats = 0;
  let hotValues = 0;

  for (const group of anyStore.groups) {
    for (const lane of group.lanes) {
      hotTimestamps += lane.hotTimestamps.byteLength;
      for (const tc of lane.frozenTimestamps) {
        if (tc.compressed) frozenTimestampsCompressed += tc.compressed.byteLength;
        if (tc.timestamps) frozenTimestampsDecoded += tc.timestamps.byteLength;
      }
      for (const rg of lane.rowGroups) {
        rowGroupValueBuffer += rg.valueBuffer.byteLength;
        rowGroupOffsets += rg.offsets.byteLength;
        rowGroupSizes += rg.sizes.byteLength;
        rowGroupPackedStats += rg.packedStats.byteLength;
      }
    }
  }

  for (const series of anyStore.allSeries) {
    for (const segment of series.segments) {
      hotValues += segment.hot.values.byteLength;
    }
  }

  const labelIndexBytes = anyStore.labelIndex.memoryBytes();
  const total = store.memoryBytes();

  console.log(
    JSON.stringify(
      {
        chunkSize,
        totalBytes: total,
        bytesPerSample: Number((total / TOTAL_SAMPLES).toFixed(4)),
        breakdown: {
          rowGroupValueBuffer,
          rowGroupPackedStats,
          rowGroupOffsets,
          rowGroupSizes,
          frozenTimestampsCompressed,
          frozenTimestampsDecoded,
          hotTimestamps,
          hotValues,
          labelIndexBytes,
        },
        percentages: {
          rowGroupValueBuffer: Number(((rowGroupValueBuffer / total) * 100).toFixed(2)),
          rowGroupPackedStats: Number(((rowGroupPackedStats / total) * 100).toFixed(2)),
          rowGroupOffsets: Number(((rowGroupOffsets / total) * 100).toFixed(2)),
          rowGroupSizes: Number(((rowGroupSizes / total) * 100).toFixed(2)),
          frozenTimestampsCompressed: Number(
            ((frozenTimestampsCompressed / total) * 100).toFixed(2)
          ),
          frozenTimestampsDecoded: Number(((frozenTimestampsDecoded / total) * 100).toFixed(2)),
          hotTimestamps: Number(((hotTimestamps / total) * 100).toFixed(2)),
          hotValues: Number(((hotValues / total) * 100).toFixed(2)),
          labelIndexBytes: Number(((labelIndexBytes / total) * 100).toFixed(2)),
        },
      },
      null,
      2
    )
  );
}

void main();
