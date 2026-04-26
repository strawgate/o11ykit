/**
 * sustained-ingest — feed 100K records into a single LogStore and
 * watch what happens.
 *
 * Existing benches all measure single-shot encode of a 2K-record
 * corpus. None answer "what does the engine do under sustained
 * load?" — the M5 ingest gate question. This bench fills that gap.
 *
 * Per (corpus, policy):
 *   - Cycle the corpus's lines until we've appended N records
 *     (default 100K). Record timestamps monotonically increasing.
 *   - Snapshot memory every K records (default 5K) so we see
 *     allocation shape over time, not just delta.
 *   - PerformanceObserver listens for V8 GC events; we report count
 *     + total pause duration.
 *   - At end of run: throughput records/sec, peak rss, peak
 *     arrayBuffers, Drain template count, total chunks, total chunk
 *     bytes.
 *
 * Run with `--expose-gc` so GC events are reliably observable; the
 * GC observer works without `--expose-gc` but the manual settle in
 * profile-harness uses `global.gc`.
 *
 * The output is JSON (per usual) plus a stderr-printed time series
 * of (records, heapMB, arrayBufMB) pairs for quick inspection.
 */

import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  ColumnarDrainPolicy,
  defaultRegistry,
  GzipCodec,
  type InstrumentationScope,
  type LogRecord,
  LogStore,
  type Resource,
  TypedColumnarDrainPolicy,
  ZstdCodec,
} from "../dist/index.js";
import { type Corpus, loadAllAvailable } from "./corpora.js";

interface MemorySnapshot {
  records: number;
  ms: number;
  heapUsedBytes: number;
  arrayBuffersBytes: number;
  rssBytes: number;
}

interface GcSummary {
  count: number;
  totalDurationMs: number;
  /** Per-kind breakdown (V8 GC kinds: 1=Scavenge, 2=Minor, 4=Major, etc.). */
  byKind: Record<number, { count: number; totalDurationMs: number }>;
}

interface SustainedRunResult {
  corpus: string;
  policy: string;
  bodyCodec: string;
  totalRecords: number;
  totalChunks: number;
  totalChunkBytes: number;
  bytesPerLog: number;
  durationMs: number;
  /** Records/sec sustained over the whole run. */
  throughput: number;
  drainTemplateCount: number;
  peakRssBytes: number;
  peakArrayBuffersBytes: number;
  peakHeapBytes: number;
  gc: GcSummary;
  snapshots: MemorySnapshot[];
}

interface SustainedReport {
  module: string;
  timestamp: string;
  commit: string | null;
  node: string;
  results: SustainedRunResult[];
}

const SCOPE: InstrumentationScope = { name: "o11ylogsdb-bench", version: "0.0.0" };

function buildResource(corpusName: string): Resource {
  return {
    attributes: [
      { key: "service.name", value: corpusName.toLowerCase() },
      { key: "service.instance.id", value: `${corpusName.toLowerCase()}-0` },
    ],
  };
}

interface PolicyVariant {
  name: string;
  bodyCodec: string;
  build: () => TypedColumnarDrainPolicy | ColumnarDrainPolicy;
}

const VARIANTS: PolicyVariant[] = [
  {
    name: "typed_columnar_zstd-3",
    bodyCodec: "zstd-3",
    build: () => new TypedColumnarDrainPolicy({ bodyCodec: "zstd-3" }),
  },
  {
    name: "typed_columnar_zstd-19",
    bodyCodec: "zstd-19",
    build: () => new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
  },
];

const TARGET_RECORDS = 500_000;
const SNAPSHOT_EVERY = 25_000;

function setupGcObserver(): { stop: () => GcSummary } {
  const summary: GcSummary = {
    count: 0,
    totalDurationMs: 0,
    byKind: {},
  };
  const obs = new PerformanceObserver((items) => {
    for (const entry of items.getEntries()) {
      // Node 22+: GC entry kind is in `entry.detail.kind`, not the
      // top-level `entry.kind` (deprecated DEP0152 since Node 16).
      // V8 GC kinds: 1=Scavenge, 2=Minor (incremental marking),
      // 4=Major, 8=Process weak callbacks.
      summary.count++;
      summary.totalDurationMs += entry.duration;
      const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
      const kind = detail?.kind ?? 0;
      const bucket = summary.byKind[kind] ?? { count: 0, totalDurationMs: 0 };
      bucket.count++;
      bucket.totalDurationMs += entry.duration;
      summary.byKind[kind] = bucket;
    }
  });
  obs.observe({ entryTypes: ["gc"] });
  return {
    stop: () => {
      obs.disconnect();
      return summary;
    },
  };
}

function snapshot(records: number, ms: number): MemorySnapshot {
  const m = process.memoryUsage();
  return {
    records,
    ms,
    heapUsedBytes: m.heapUsed,
    arrayBuffersBytes: m.arrayBuffers,
    rssBytes: m.rss,
  };
}

function tryGc(): void {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

function runOne(corpus: Corpus, variant: PolicyVariant): SustainedRunResult {
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const lineCount = lines.length;
  if (lineCount === 0) throw new Error(`empty corpus ${corpus.name}`);

  const policy = variant.build();
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy,
    rowsPerChunk: 4096,
  });
  const resource = buildResource(corpus.name);

  // GC + snapshot setup. Force a GC so the baseline is steady-state.
  tryGc();
  const gc = setupGcObserver();
  const snapshots: MemorySnapshot[] = [];
  let peakRss = 0;
  let peakArrayBuffers = 0;
  let peakHeap = 0;

  const t0 = performance.now();
  snapshots.push(snapshot(0, 0));

  // Append loop. Cycle through the corpus lines as needed.
  for (let i = 0; i < TARGET_RECORDS; i++) {
    const line = lines[i % lineCount] as string;
    const record: LogRecord = {
      timeUnixNano: BigInt(i) * 1_000_000_000n,
      severityNumber: 9,
      severityText: "INFO",
      body: line,
      attributes: [],
    };
    store.append(resource, SCOPE, record);

    if ((i + 1) % SNAPSHOT_EVERY === 0) {
      const ms = performance.now() - t0;
      const snap = snapshot(i + 1, ms);
      snapshots.push(snap);
      if (snap.rssBytes > peakRss) peakRss = snap.rssBytes;
      if (snap.arrayBuffersBytes > peakArrayBuffers) peakArrayBuffers = snap.arrayBuffersBytes;
      if (snap.heapUsedBytes > peakHeap) peakHeap = snap.heapUsedBytes;
    }
  }
  store.flush();
  const t1 = performance.now();
  const durationMs = t1 - t0;

  const gcSummary = gc.stop();
  const stats = store.stats();
  const drainTemplateCount =
    policy instanceof TypedColumnarDrainPolicy || policy instanceof ColumnarDrainPolicy
      ? policy.drain.templateCount()
      : 0;

  // Record the final post-flush memory.
  const finalSnap = snapshot(TARGET_RECORDS, durationMs);
  snapshots.push(finalSnap);
  if (finalSnap.rssBytes > peakRss) peakRss = finalSnap.rssBytes;
  if (finalSnap.arrayBuffersBytes > peakArrayBuffers)
    peakArrayBuffers = finalSnap.arrayBuffersBytes;
  if (finalSnap.heapUsedBytes > peakHeap) peakHeap = finalSnap.heapUsedBytes;

  // Force a GC and snapshot again. The delta between this and the
  // pre-flush snapshot is "live retained memory" — what we'd
  // actually need at steady state. The pre-flush max is "peak
  // including garbage."
  tryGc();
  const postGcSnap = snapshot(TARGET_RECORDS, performance.now() - t0);
  snapshots.push(postGcSnap);

  // Stderr: terse time-series for quick eyeballing.
  process.stderr.write(
    `\n  ${corpus.name} / ${variant.name}: ${TARGET_RECORDS.toLocaleString()} records in ${durationMs.toFixed(0)} ms ` +
      `(${(TARGET_RECORDS / (durationMs / 1000)).toFixed(0)} rec/s, ${drainTemplateCount} templates, ${stats.chunks} chunks)\n`
  );
  process.stderr.write(
    `    GC: ${gcSummary.count} events, ${gcSummary.totalDurationMs.toFixed(1)} ms total pause\n`
  );
  process.stderr.write(`    records  ms     heapMB  arrBufMB  rssMB\n`);
  for (const s of snapshots) {
    process.stderr.write(
      `    ${s.records.toString().padStart(7)} ${s.ms.toFixed(0).padStart(6)} ${(s.heapUsedBytes / 1_000_000).toFixed(1).padStart(7)} ${(s.arrayBuffersBytes / 1_000_000).toFixed(1).padStart(9)} ${(s.rssBytes / 1_000_000).toFixed(1).padStart(6)}\n`
    );
  }

  return {
    corpus: corpus.name,
    policy: variant.name,
    bodyCodec: variant.bodyCodec,
    totalRecords: TARGET_RECORDS,
    totalChunks: stats.chunks,
    totalChunkBytes: stats.totalChunkBytes,
    bytesPerLog: stats.totalChunkBytes / TARGET_RECORDS,
    durationMs,
    throughput: TARGET_RECORDS / (durationMs / 1000),
    drainTemplateCount,
    peakRssBytes: peakRss,
    peakArrayBuffersBytes: peakArrayBuffers,
    peakHeapBytes: peakHeap,
    gc: gcSummary,
    snapshots,
  };
}

export default async function run(): Promise<SustainedReport> {
  const corpora = loadAllAvailable("2k");
  if (corpora.length === 0) throw new Error("No corpora present at bench/corpora/loghub-2k/.");
  // Run sustained ingest on a representative subset: smallest (Apache),
  // medium (HDFS), largest (OpenStack). Skipping every corpus saves
  // ~6 minutes of bench wallclock; the cross-corpus pattern shows up
  // in the first three.
  const targets = ["Apache", "HDFS", "OpenStack"]
    .map((n) => corpora.find((c) => c.name === n))
    .filter((c): c is Corpus => !!c);
  const results: SustainedRunResult[] = [];
  for (const corpus of targets) {
    for (const variant of VARIANTS) {
      results.push(runOne(corpus, variant));
    }
  }
  return {
    module: "sustained-ingest",
    timestamp: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? null,
    node: process.version,
    results,
  };
}
