/**
 * Row-group layout experiment.
 *
 * Compares wide-query layouts under different ingest coordination patterns:
 *   1. Interleaved aligned ingest (scrape-like)
 *   2. Series-major aligned ingest
 *   3. Series-major ingest with laggards
 *
 * The goal is to surface when shared-group freezing works well and when
 * hot buffers expand because freeze progress is coupled to the slowest member.
 *
 * Usage:
 *   node --expose-gc bench/dist/rowgroup-layout.bench.js
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, fmtBytes } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

type StorageBackend = import("./types.js").StorageBackend;
type Labels = import("./types.js").Labels;
type QueryEngine = import("./types.js").QueryEngine;

const SERIES_COUNT = 10_000;
const MAX_POINTS = 1_024;
const CHUNK_SIZE = 640;
const T0 = 1_700_000_000_000n;
const INTERVAL = 15_000n;
const STEP = 60_000n;

interface LayoutSpec {
  name: string;
  kind: "column" | "rowgroup" | "lane-rowgroup";
  groupSize: number | "all";
  laneSize?: number;
}

interface ScenarioSpec {
  name: string;
  ingestMode: "interleaved" | "series-major";
  pointsForSeries: (seriesIndex: number) => number;
}

interface LayoutStats {
  totalGroups: number;
  maxMembersPerGroup: number;
  totalFrozenTimestampChunks: number;
  totalRowGroups: number;
  maxHotCount: number;
  maxHotCapacity: number;
  totalHotSamples: number;
  maxSeriesHotCapacity: number;
  maxSeriesHotCount: number;
  groupsOverChunkCapacity: number;
  seriesOverChunkCapacity: number;
  hotTimestampBytes: number;
  frozenTimestampBytes: number;
  hotValueBytes: number;
  frozenValueBytes: number;
  statsMetadataBytes: number;
}

interface ExperimentResult {
  scenario: string;
  layout: string;
  totalSamples: number;
  ingestMs: number;
  ingestSamplesPerSec: number;
  memBytes: number;
  rss: number;
  rawMs: number;
  selectMs: number;
  stepAggMs: number;
  stats: LayoutStats;
}

const LAYOUTS: LayoutSpec[] = [
  { name: "column-all", kind: "column", groupSize: "all" },
  { name: "rowgroup-all", kind: "rowgroup", groupSize: "all" },
  { name: "lane-rowgroup-32", kind: "lane-rowgroup", groupSize: "all", laneSize: 32 },
  { name: "rowgroup-32", kind: "rowgroup", groupSize: 32 },
  { name: "rowgroup-5", kind: "rowgroup", groupSize: 5 },
];

const SCENARIOS: ScenarioSpec[] = [
  {
    name: "aligned-interleaved",
    ingestMode: "interleaved",
    pointsForSeries: () => MAX_POINTS,
  },
  {
    name: "aligned-series-major",
    ingestMode: "series-major",
    pointsForSeries: () => MAX_POINTS,
  },
  {
    name: "laggards-series-major",
    ingestMode: "series-major",
    pointsForSeries: (seriesIndex) => (seriesIndex % 5 === 0 ? 256 : MAX_POINTS),
  },
  {
    name: "laggards-interleaved",
    ingestMode: "interleaved",
    pointsForSeries: (seriesIndex) => (seriesIndex % 5 === 0 ? 256 : MAX_POINTS),
  },
  {
    name: "short-lived-series-major",
    ingestMode: "series-major",
    pointsForSeries: (seriesIndex) => (seriesIndex % 4 === 0 ? 128 : MAX_POINTS),
  },
];

function forceGC(): void {
  if (global.gc) {
    global.gc();
    global.gc();
  }
}

function hasLength(value: unknown): value is { length: number } {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "length") === "number";
}

function isIndexableArrayLike(value: unknown): value is { length: number; [index: number]: unknown } {
  return hasLength(value);
}

function typedArrayByteLength(value: unknown): number {
  if (typeof value === "object" && value !== null) {
    const byteLength = Reflect.get(value, "byteLength");
    if (typeof byteLength === "number") return byteLength;
  }
  throw new Error("expected typed array with byteLength");
}

function collectPhysicalGroups(group: unknown): object[] {
  if (typeof group !== "object" || group === null) {
    throw new Error("invalid group object in layout diagnostics");
  }
  const lanes = Reflect.get(group, "lanes");
  if (Array.isArray(lanes)) return lanes.filter((lane): lane is object => typeof lane === "object" && lane !== null);
  return [group];
}

function collectLayoutStats(store: StorageBackend): LayoutStats {
  const groupsValue = Reflect.get(store, "groups");
  const seriesValue = Reflect.get(store, "allSeries");
  if (!Array.isArray(groupsValue) || !Array.isArray(seriesValue)) {
    throw new Error("store internals are unavailable for layout diagnostics");
  }

  let maxMembersPerGroup = 0;
  let totalFrozenTimestampChunks = 0;
  let totalRowGroups = 0;
  let maxHotCount = 0;
  let maxHotCapacity = 0;
  let totalPhysicalGroups = 0;
  let groupsOverChunkCapacity = 0;
  let hotTimestampBytes = 0;
  let frozenTimestampBytes = 0;
  let hotValueBytes = 0;
  let frozenValueBytes = 0;
  let statsMetadataBytes = 0;

  for (const group of groupsValue) {
    for (const physicalGroup of collectPhysicalGroups(group)) {
      totalPhysicalGroups++;
      const members = Reflect.get(physicalGroup, "members");
      const frozenTimestamps = Reflect.get(physicalGroup, "frozenTimestamps");
      const rowGroups = Reflect.get(physicalGroup, "rowGroups");
      const hotCount = Reflect.get(physicalGroup, "hotCount");
      const hotTimestamps = Reflect.get(physicalGroup, "hotTimestamps");
      if (
        !hasLength(members) ||
        !isIndexableArrayLike(frozenTimestamps) ||
        typeof hotCount !== "number" ||
        !hasLength(hotTimestamps)
      ) {
        throw new Error("group shape mismatch in layout diagnostics");
      }
      maxMembersPerGroup = Math.max(maxMembersPerGroup, members.length);
      totalFrozenTimestampChunks += frozenTimestamps.length;
      totalRowGroups += hasLength(rowGroups) ? rowGroups.length : 0;
      maxHotCount = Math.max(maxHotCount, hotCount);
      maxHotCapacity = Math.max(maxHotCapacity, hotTimestamps.length);
      if (hotTimestamps.length > CHUNK_SIZE) groupsOverChunkCapacity++;
      hotTimestampBytes += hotCount * 8;
      for (let i = 0; i < frozenTimestamps.length; i++) {
        const chunk = frozenTimestamps[i];
        if (typeof chunk !== "object" || chunk === null) {
          throw new Error("invalid frozen timestamp chunk");
        }
        const compressed = Reflect.get(chunk, "compressed");
        const timestamps = Reflect.get(chunk, "timestamps");
        if (compressed) {
          frozenTimestampBytes += typedArrayByteLength(compressed);
        } else if (timestamps) {
          frozenTimestampBytes += typedArrayByteLength(timestamps);
        }
      }
      if (isIndexableArrayLike(rowGroups)) {
        for (let i = 0; i < rowGroups.length; i++) {
          const rowGroup = rowGroups[i];
          if (typeof rowGroup !== "object" || rowGroup === null) {
            throw new Error("invalid row group");
          }
          frozenValueBytes += typedArrayByteLength(Reflect.get(rowGroup, "valueBuffer"));
          statsMetadataBytes += typedArrayByteLength(Reflect.get(rowGroup, "offsets"));
          statsMetadataBytes += typedArrayByteLength(Reflect.get(rowGroup, "sizes"));
          statsMetadataBytes += typedArrayByteLength(Reflect.get(rowGroup, "packedStats"));
        }
      }
    }
  }

  let totalHotSamples = 0;
  let maxSeriesHotCapacity = 0;
  let maxSeriesHotCount = 0;
  let seriesOverChunkCapacity = 0;
  for (const series of seriesValue) {
    if (typeof series !== "object" || series === null) {
      throw new Error("invalid series object in layout diagnostics");
    }
    const segments = Reflect.get(series, "segments");
    if (Array.isArray(segments)) {
      for (const segment of segments) {
        if (typeof segment !== "object" || segment === null) {
          throw new Error("invalid lane segment");
        }
        const hot = Reflect.get(segment, "hot");
        if (typeof hot !== "object" || hot === null) {
          throw new Error("missing hot values in lane segment");
        }
        const count = Reflect.get(hot, "count");
        const values = Reflect.get(hot, "values");
        if (typeof count !== "number" || !hasLength(values)) {
          throw new Error("lane hot values shape mismatch");
        }
        totalHotSamples += count;
        maxSeriesHotCapacity = Math.max(maxSeriesHotCapacity, values.length);
        maxSeriesHotCount = Math.max(maxSeriesHotCount, count);
        if (values.length > CHUNK_SIZE) seriesOverChunkCapacity++;
        hotValueBytes += count * 8;
      }
      continue;
    }

    const hot = Reflect.get(series, "hot");
    if (typeof hot !== "object" || hot === null) {
      throw new Error("missing hot values in layout diagnostics");
    }
    const count = Reflect.get(hot, "count");
    const values = Reflect.get(hot, "values");
    if (typeof count !== "number" || !hasLength(values)) {
      throw new Error("hot values shape mismatch in layout diagnostics");
    }
    totalHotSamples += count;
    maxSeriesHotCapacity = Math.max(maxSeriesHotCapacity, values.length);
    maxSeriesHotCount = Math.max(maxSeriesHotCount, count);
    if (values.length > CHUNK_SIZE) seriesOverChunkCapacity++;
    hotValueBytes += count * 8;

    const frozen = Reflect.get(series, "frozen");
    if (typeof frozen === "object" && frozen !== null) {
      const blobs = Reflect.get(frozen, "blobs");
      const stats = Reflect.get(frozen, "stats");
      const tsIndices = Reflect.get(frozen, "tsIndices");
      const countValue = Reflect.get(frozen, "count");
      if (Array.isArray(blobs) && typeof countValue === "number") {
        for (let i = 0; i < countValue; i++) {
          const blob = blobs[i];
          if (!blob) throw new Error("missing frozen value blob");
          frozenValueBytes += typedArrayByteLength(blob);
        }
      }
      if (stats) statsMetadataBytes += typedArrayByteLength(stats);
      if (tsIndices) statsMetadataBytes += typedArrayByteLength(tsIndices);
    }
  }

  return {
    totalGroups: totalPhysicalGroups,
    maxMembersPerGroup,
    totalFrozenTimestampChunks,
    totalRowGroups,
    maxHotCount,
    maxHotCapacity,
    totalHotSamples,
    maxSeriesHotCapacity,
    maxSeriesHotCount,
    groupsOverChunkCapacity,
    seriesOverChunkCapacity,
    hotTimestampBytes,
    frozenTimestampBytes,
    hotValueBytes,
    frozenValueBytes,
    statsMetadataBytes,
  };
}

function makeLabels(seriesIndex: number): Labels {
  return new Map<string, string>([
    ["__name__", "cpu_usage"],
    ["host", `host-${seriesIndex}`],
    ["region", `region-${seriesIndex % 8}`],
    ["env", seriesIndex % 2 === 0 ? "prod" : "staging"],
  ]);
}

function makeResolver(groupSize: number | "all"): (labels: Labels) => number {
  if (groupSize === "all") return () => 0;
  return (labels) => {
    const host = labels.get("host");
    if (!host) throw new Error("missing host label");
    const seriesIndex = Number(host.slice("host-".length));
    if (!Number.isInteger(seriesIndex) || seriesIndex < 0) {
      throw new Error(`invalid host label ${host}`);
    }
    return Math.floor(seriesIndex / groupSize);
  };
}

function buildBatch(
  seriesIndex: number,
  startPoint: number,
  length: number
): { timestamps: BigInt64Array; values: Float64Array } {
  const timestamps = new BigInt64Array(length);
  const values = new Float64Array(length);
  const base = 40 + (seriesIndex % 17);
  for (let i = 0; i < length; i++) {
    const pointIndex = startPoint + i;
    timestamps[i] = T0 + BigInt(pointIndex) * INTERVAL;
    const drift = ((seriesIndex * 13 + pointIndex * 7) % 11) - 5;
    values[i] = base + drift * 0.03 + (pointIndex % 97) * 0.001;
  }
  return { timestamps, values };
}

async function loadQueryEngine(): Promise<QueryEngine> {
  const { ScanEngine } = await import(pkgPath("dist/query.js"));
  return new ScanEngine();
}

async function createStore(layout: LayoutSpec): Promise<StorageBackend> {
  const { loadWasm, makeALPValuesCodec, makeTimestampCodec, makeALPRangeCodec } =
    await import("./wasm-loader.js");
  const wasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
  const wasm = await loadWasm(wasmPath);
  const alpVals = makeALPValuesCodec(wasm);
  const wasmTs = makeTimestampCodec(wasm);
  const rangeCodec = makeALPRangeCodec(wasm);
  const valuesCodec = {
    name: layout.kind === "column" ? "alp-range" : "rg-alp-range",
    encodeValues: alpVals.encodeValues,
    decodeValues: alpVals.decodeValues,
    encodeValuesWithStats: alpVals.encodeValuesWithStats,
    encodeBatchValuesWithStats: alpVals.encodeBatchValuesWithStats,
    decodeBatchValues: alpVals.decodeBatchValues,
  };
  const tsCodec = {
    name: "rust-wasm-ts",
    encodeTimestamps: wasmTs.encodeTimestamps,
    decodeTimestamps: wasmTs.decodeTimestamps,
  };
  const resolver = makeResolver(layout.groupSize);

  if (layout.kind === "column") {
    const { ColumnStore } = await import(pkgPath("dist/column-store.js"));
    return new ColumnStore(valuesCodec, CHUNK_SIZE, resolver, layout.name, tsCodec, rangeCodec);
  }

  if (layout.kind === "lane-rowgroup") {
    const { LaneRowGroupStore } = await import(pkgPath("dist/lane-row-group-store.js"));
    return new LaneRowGroupStore(
      valuesCodec,
      CHUNK_SIZE,
      resolver,
      layout.laneSize ?? 32,
      layout.name,
      tsCodec,
      rangeCodec
    );
  }

  const { RowGroupStore } = await import(pkgPath("dist/row-group-store.js"));
  return new RowGroupStore(valuesCodec, CHUNK_SIZE, resolver, layout.name, tsCodec, rangeCodec);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function timeQuery(fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    forceGC();
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

async function ingestScenario(store: StorageBackend, scenario: ScenarioSpec): Promise<number> {
  const ids: number[] = [];
  const pointsBySeries = new Uint32Array(SERIES_COUNT);

  for (let seriesIndex = 0; seriesIndex < SERIES_COUNT; seriesIndex++) {
    ids.push(store.getOrCreateSeries(makeLabels(seriesIndex)));
    pointsBySeries[seriesIndex] = scenario.pointsForSeries(seriesIndex);
  }

  let totalSamples = 0;
  if (scenario.ingestMode === "interleaved") {
    for (let startPoint = 0; startPoint < MAX_POINTS; startPoint += CHUNK_SIZE) {
      for (let seriesIndex = 0; seriesIndex < SERIES_COUNT; seriesIndex++) {
        const points = pointsBySeries[seriesIndex]!;
        if (startPoint >= points) continue;
        const batchSize = Math.min(CHUNK_SIZE, points - startPoint);
        const { timestamps, values } = buildBatch(seriesIndex, startPoint, batchSize);
        store.appendBatch(ids[seriesIndex]!, timestamps, values);
        totalSamples += batchSize;
      }
    }
    return totalSamples;
  }

  for (let seriesIndex = 0; seriesIndex < SERIES_COUNT; seriesIndex++) {
    const points = pointsBySeries[seriesIndex]!;
    const { timestamps, values } = buildBatch(seriesIndex, 0, points);
    store.appendBatch(ids[seriesIndex]!, timestamps, values);
    totalSamples += points;
  }
  return totalSamples;
}

async function runExperiment(layout: LayoutSpec, scenario: ScenarioSpec): Promise<ExperimentResult> {
  forceGC();
  const store = await createStore(layout);
  const engine = await loadQueryEngine();

  const ingestStart = performance.now();
  const totalSamples = await ingestScenario(store, scenario);
  const ingestMs = performance.now() - ingestStart;

  forceGC();
  const rss = process.memoryUsage().rss;
  const end = T0 + BigInt(MAX_POINTS) * INTERVAL;

  const rawMs = timeQuery(() => {
    engine.query(store, { metric: "cpu_usage", start: T0, end });
  });
  const selectMs = timeQuery(() => {
    engine.query(store, {
      metric: "cpu_usage",
      start: T0,
      end,
      matchers: [{ label: "env", op: "=", value: "prod" }],
    });
  });
  const stepAggMs = timeQuery(() => {
    engine.query(store, {
      metric: "cpu_usage",
      start: T0,
      end,
      agg: "min",
      step: STEP,
      groupBy: ["region"],
    });
  });

  const stats = collectLayoutStats(store);
  return {
    scenario: scenario.name,
    layout: layout.name,
    totalSamples,
    ingestMs,
    ingestSamplesPerSec: totalSamples / (ingestMs / 1000),
    memBytes: store.memoryBytes(),
    rss,
    rawMs,
    selectMs,
    stepAggMs,
    stats,
  };
}

function printScenarioResults(scenario: ScenarioSpec, results: ExperimentResult[]): void {
  console.log(`\n  ── ${scenario.name} ──\n`);
  console.log(
    "| layout | samples | ingest | mem | raw | select | stepAgg | hot % | ts bytes | value bytes | meta bytes | grown groups | grown series |"
  );
  console.log(
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const result of results) {
    const hotPercent = (result.stats.totalHotSamples / result.totalSamples) * 100;
    const timestampBytes = result.stats.hotTimestampBytes + result.stats.frozenTimestampBytes;
    const valueBytes = result.stats.hotValueBytes + result.stats.frozenValueBytes;
    console.log(
      `| ${result.layout} | ${result.totalSamples.toLocaleString()} | ${fmt(result.ingestSamplesPerSec)} /s | ${fmtBytes(result.memBytes)} | ${result.rawMs.toFixed(1)} ms | ${result.selectMs.toFixed(1)} ms | ${result.stepAggMs.toFixed(1)} ms | ${hotPercent.toFixed(1)}% | ${fmtBytes(timestampBytes)} | ${fmtBytes(valueBytes)} | ${fmtBytes(result.stats.statsMetadataBytes)} | ${result.stats.groupsOverChunkCapacity} | ${result.stats.seriesOverChunkCapacity} |`
    );
  }

  console.log();
  console.log(
    "  detail: groups/maxMembers/maxHotCap/maxSeriesHotCap =",
    results
      .map(
        (result) =>
          `${result.layout}:${result.stats.totalGroups}/${result.stats.maxMembersPerGroup}/${result.stats.maxHotCapacity}/${result.stats.maxSeriesHotCapacity}`
      )
      .join("  ")
  );
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  o11ytsdb — Row-group Layout Experiment                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Series: ${SERIES_COUNT.toLocaleString()}`);
  console.log(`  Max points/series: ${MAX_POINTS.toLocaleString()}`);
  console.log(`  Chunk size: ${CHUNK_SIZE}`);

  const results: ExperimentResult[] = [];
  for (const scenario of SCENARIOS) {
    for (const layout of LAYOUTS) {
      console.log(`\n  Running ${scenario.name} × ${layout.name}...`);
      results.push(await runExperiment(layout, scenario));
      forceGC();
    }
  }

  for (const scenario of SCENARIOS) {
    printScenarioResults(
      scenario,
      results.filter((result) => result.scenario === scenario.name)
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
