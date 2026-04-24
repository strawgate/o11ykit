import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  ChunkStats,
  Labels,
  TimestampCodec,
  ValuesCodec,
} from "../dist/index.js";
import { computeStats, initWasmCodecs, RowGroupStore } from "../dist/index.js";

const HOT_SIZE = 80;
const COLD_SIZE = 640;
const HOTS_PER_COLD = COLD_SIZE / HOT_SIZE;
const PACKED_STATS_STRIDE = 5;
const NUM_SERIES = 32;
const POINTS_PER_SERIES = 31_250; // 1,000,000 total
const INTERVAL = 1_000n;
const INGEST_BATCH = 64;
const MILESTONES = [50_000, 100_000, 250_000, 500_000, 750_000, 1_000_000];

type SealedHotBlock = {
  valueBuffer: Uint8Array;
  offsets: Uint32Array;
  sizes: Uint32Array;
  packedStats: Float64Array;
  compressedTimestamps?: Uint8Array;
  timestamps?: BigInt64Array;
};

function makeLabels(seriesIndex: number): Labels {
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

function encodeWithStats(
  codec: ValuesCodec,
  values: Float64Array
): {
  compressed: Uint8Array;
  stats: ChunkStats;
} {
  if (codec.encodeValuesWithStats) {
    return codec.encodeValuesWithStats(values);
  }
  return {
    compressed: codec.encodeValues(values),
    stats: computeStats(values),
  };
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new RangeError(message);
  }
  return value;
}

class TieredRowGroupPrototype {
  private readonly coldStore: RowGroupStore;
  private readonly seriesIds: number[] = [];
  private readonly activeTimestamps = new BigInt64Array(HOT_SIZE);
  private readonly activeValues: Float64Array[];
  private activeCount = 0;
  private readonly sealedHot: SealedHotBlock[] = [];
  private _sampleCount = 0;

  constructor(
    private readonly valuesCodec: ValuesCodec,
    private readonly tsCodec: TimestampCodec | undefined,
    labels: Labels[]
  ) {
    this.coldStore = new RowGroupStore(valuesCodec, COLD_SIZE, () => 0, 8, undefined, tsCodec);
    this.activeValues = labels.map(() => new Float64Array(HOT_SIZE));
    for (const labelSet of labels) {
      this.seriesIds.push(this.coldStore.getOrCreateSeries(labelSet));
    }
  }

  appendAlignedBatch(timestamps: BigInt64Array, valuesBySeries: Float64Array[]): void {
    let offset = 0;
    while (offset < timestamps.length) {
      const available = HOT_SIZE - this.activeCount;
      const batch = Math.min(available, timestamps.length - offset);
      this.activeTimestamps.set(timestamps.subarray(offset, offset + batch), this.activeCount);
      for (let s = 0; s < this.activeValues.length; s++) {
        const target = requireDefined(
          this.activeValues[s],
          `missing active values for series ${s}`
        );
        const source = requireDefined(valuesBySeries[s], `missing batch values for series ${s}`);
        target.set(source.subarray(offset, offset + batch), this.activeCount);
      }
      this.activeCount += batch;
      this._sampleCount += batch * this.activeValues.length;
      offset += batch;
      if (this.activeCount === HOT_SIZE) {
        this.sealActive();
      }
    }
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  memoryBytes(): number {
    let hotBytes = this.activeTimestamps.byteLength;
    for (const values of this.activeValues) hotBytes += values.byteLength;
    for (const block of this.sealedHot) {
      hotBytes += block.valueBuffer.byteLength;
      hotBytes += block.offsets.byteLength;
      hotBytes += block.sizes.byteLength;
      hotBytes += block.packedStats.byteLength;
      if (block.compressedTimestamps) hotBytes += block.compressedTimestamps.byteLength;
      if (block.timestamps) hotBytes += block.timestamps.byteLength;
    }
    return this.coldStore.memoryBytes() + hotBytes;
  }

  memoryBreakdown(): {
    totalBytes: number;
    coldBytes: number;
    hotBytes: number;
    bytesPerSample: number;
  } {
    const totalBytes = this.memoryBytes();
    const coldBytes = this.coldStore.memoryBytes();
    const hotBytes = totalBytes - coldBytes;
    return {
      totalBytes,
      coldBytes,
      hotBytes,
      bytesPerSample: this.sampleCount === 0 ? 0 : totalBytes / this.sampleCount,
    };
  }

  private sealActive(): void {
    let totalValueBytes = 0;
    const compressedValues: Uint8Array[] = [];
    const stats: ChunkStats[] = [];
    for (const values of this.activeValues) {
      const encoded = encodeWithStats(this.valuesCodec, values);
      compressedValues.push(encoded.compressed);
      stats.push(encoded.stats);
      totalValueBytes += encoded.compressed.byteLength;
    }

    const valueBuffer = new Uint8Array(totalValueBytes);
    const offsets = new Uint32Array(this.activeValues.length);
    const sizes = new Uint32Array(this.activeValues.length);
    const packedStats = new Float64Array(this.activeValues.length * PACKED_STATS_STRIDE);

    let pos = 0;
    for (let s = 0; s < compressedValues.length; s++) {
      const blob = requireDefined(compressedValues[s], `missing compressed values for series ${s}`);
      valueBuffer.set(blob, pos);
      offsets[s] = pos;
      sizes[s] = blob.byteLength;
      pos += blob.byteLength;

      const stat = requireDefined(stats[s], `missing chunk stats for series ${s}`);
      const si = s * PACKED_STATS_STRIDE;
      packedStats[si] = stat.minV;
      packedStats[si + 1] = stat.maxV;
      packedStats[si + 2] = stat.sum;
      packedStats[si + 3] = stat.count;
      packedStats[si + 4] = stat.lastV;
    }

    this.sealedHot.push({
      valueBuffer,
      offsets,
      sizes,
      packedStats,
      compressedTimestamps: this.tsCodec
        ? this.tsCodec.encodeTimestamps(this.activeTimestamps)
        : undefined,
      timestamps: this.tsCodec ? undefined : this.activeTimestamps.slice(0),
    });

    this.activeCount = 0;
    if (this.sealedHot.length >= HOTS_PER_COLD) {
      this.compactHotToCold();
    }
  }

  private compactHotToCold(): void {
    const blocks = this.sealedHot.splice(0, HOTS_PER_COLD);
    const coldTimestamps = new BigInt64Array(COLD_SIZE);

    let tsOffset = 0;
    for (const block of blocks) {
      const ts =
        block.timestamps ??
        this.tsCodec?.decodeTimestamps(
          requireDefined(block.compressedTimestamps, "missing compressed hot timestamps")
        );
      if (!ts) {
        throw new RangeError("missing hot block timestamps");
      }
      coldTimestamps.set(ts, tsOffset);
      tsOffset += ts.length;
    }

    for (let s = 0; s < this.seriesIds.length; s++) {
      const coldValues = new Float64Array(COLD_SIZE);
      let valueOffset = 0;
      for (const block of blocks) {
        const start = requireDefined(block.offsets[s], `missing hot offset for series ${s}`);
        const size = requireDefined(block.sizes[s], `missing hot size for series ${s}`);
        const blob = block.valueBuffer.subarray(start, start + size);
        const decoded = this.valuesCodec.decodeValues(blob);
        coldValues.set(decoded, valueOffset);
        valueOffset += decoded.length;
      }
      this.coldStore.appendBatch(
        requireDefined(this.seriesIds[s], `missing cold series id ${s}`),
        coldTimestamps,
        coldValues
      );
    }
  }
}

async function main() {
  const wasm = new WebAssembly.Module(readFileSync(path.resolve("wasm/o11ytsdb-rust.wasm")));
  const codecs = await initWasmCodecs(wasm);
  const labels = Array.from({ length: NUM_SERIES }, (_, s) => makeLabels(s));
  const data = Array.from({ length: NUM_SERIES }, (_, s) => makeSeriesData(s));
  const store = new TieredRowGroupPrototype(codecs.valuesCodec, codecs.tsCodec, labels);

  let nextMilestoneIndex = 0;
  for (let offset = 0; offset < POINTS_PER_SERIES; offset += INGEST_BATCH) {
    const end = Math.min(offset + INGEST_BATCH, POINTS_PER_SERIES);
    store.appendAlignedBatch(
      requireDefined(data[0], "missing lead series data").timestamps.subarray(offset, end),
      data.map((series) => series.values.subarray(offset, end))
    );
    while (
      nextMilestoneIndex < MILESTONES.length &&
      store.sampleCount >= requireDefined(MILESTONES[nextMilestoneIndex], "missing milestone")
    ) {
      const breakdown = store.memoryBreakdown();
      console.log(
        JSON.stringify({
          hotSize: HOT_SIZE,
          coldSize: COLD_SIZE,
          samples: store.sampleCount,
          totalBytes: breakdown.totalBytes,
          bytesPerSample: Number(breakdown.bytesPerSample.toFixed(4)),
          coldBytes: breakdown.coldBytes,
          hotBytes: breakdown.hotBytes,
          hotPct: Number(((breakdown.hotBytes / breakdown.totalBytes) * 100).toFixed(2)),
        })
      );
      nextMilestoneIndex++;
    }
  }
}

void main();
