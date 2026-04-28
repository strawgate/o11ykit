/**
 * Scale benchmark: 500K records per corpus (~50MB working set)
 * Compares engine size vs raw ZSTD(NDJSON) and measures query latency at scale.
 */
import {
  defaultRegistry,
  GzipCodec,
  LogStore,
  TypedColumnarDrainPolicy,
  ZstdCodec,
  query,
} from "../dist/index.js";
import {
  CORPUS_GENERATORS,
} from "../dist-bench/synthetic-corpora.js";
import { zstdCompressSync } from "node:zlib";
import * as zlib from "node:zlib";

const enc = new TextEncoder();
const COUNT = 500_000;
const CORPUS_TYPES = ["syslog", "structured", "high-cardinality", "cloud-native", "mixed"];

function zstdCompress(data, level) {
  return zstdCompressSync(data, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
  });
}

console.log(`\n═══ LogsDB Scale Benchmark: ${(COUNT/1000).toFixed(0)}K records per corpus ═══\n`);
console.log(`${"Corpus".padEnd(18)} ${"NDJSON".padEnd(10)} ${"ZS-3".padEnd(9)} ${"ZS-19".padEnd(9)} ${"Engine".padEnd(9)} ${"B/log".padEnd(7)} ${"vs ZS3".padEnd(8)} ${"vs ZS19".padEnd(9)} ${"Ingest/s".padEnd(10)} ${"Query ms".padEnd(10)} ${"Hits"}`);
console.log("─".repeat(115));

for (const corpusType of CORPUS_TYPES) {
  const records = CORPUS_GENERATORS[corpusType](COUNT);
  
  // Raw NDJSON size
  const ndjsonLines = [];
  for (const r of records) ndjsonLines.push(JSON.stringify(r, (_, v) => typeof v === "bigint" ? v.toString() : v));
  const ndjsonBytes = enc.encode(ndjsonLines.join("\n"));
  const ndjsonSize = ndjsonBytes.length;
  
  // ZSTD baselines
  const zstd3 = zstdCompress(ndjsonBytes, 3);
  const zstd19 = zstdCompress(ndjsonBytes, 19);

  // Engine ingest
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 1024,
  });

  const t0 = performance.now();
  const resource = { attributes: [{ key: "service.name", value: `bench-${corpusType}` }] };
  const scope = { name: "bench", version: "0.0.0" };
  for (const record of records) {
    store.append(resource, scope, record);
  }
  store.flush();
  const ingestMs = performance.now() - t0;
  
  const stats = store.stats();
  const engineSize = stats.totalChunkBytes;
  const bPerLog = engineSize / COUNT;
  const recsPerSec = Math.round(COUNT / (ingestMs / 1000));

  // Query: bodyContains "error" (CORRECT 2-arg API)
  const t1 = performance.now();
  const results = query(store, { bodyContains: "error" });
  const queryMs = performance.now() - t1;

  const mb = (b) => (b/1024/1024).toFixed(1) + "M";
  console.log(
    `${corpusType.padEnd(18)} ${mb(ndjsonSize).padStart(7)}  ${mb(zstd3.length).padStart(7)} ${mb(zstd19.length).padStart(7)}  ${mb(engineSize).padStart(7)} ${bPerLog.toFixed(1).padStart(6)}  ${(zstd3.length/engineSize).toFixed(2).padStart(6)}× ${(zstd19.length/engineSize).toFixed(2).padStart(7)}×  ${(recsPerSec/1000).toFixed(0).padStart(5)}K  ${queryMs.toFixed(0).padStart(7)}ms  ${results.records.length}`
  );
  
  ndjsonLines.length = 0;
}

console.log(`\n'vs ZS3/ZS19' > 1.0 = engine SMALLER than zstd(ndjson). < 1.0 = raw zstd wins.\n`);

// Query battery at scale on syslog
console.log(`═══ Query Performance at 500K (syslog) ═══\n`);
{
  const records = CORPUS_GENERATORS["syslog"](COUNT);
  const store = new LogStore({
    registry: defaultRegistry().register(new GzipCodec(6)).register(new ZstdCodec(3)).register(new ZstdCodec(9)).register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 1024,
  });
  const resource = { attributes: [{ key: "service.name", value: "bench-syslog" }] };
  const scope = { name: "bench", version: "0.0.0" };
  for (const r of records) store.append(resource, scope, r);
  store.flush();
  console.log(`Store: ${store.stats().chunks} chunks, ${(store.stats().totalChunkBytes/1024/1024).toFixed(1)}MB\n`);

  const queries = [
    { name: "full_scan (no filter)", spec: {} },
    { name: "bodyContains 'ssh'", spec: { bodyContains: "ssh" } },
    { name: "bodyContains 'error'", spec: { bodyContains: "error" } },
    { name: "bodyContains 'kernel'", spec: { bodyContains: "kernel" } },
    { name: "severity >= WARN", spec: { severityGte: 13 } },
    { name: "severity >= ERROR", spec: { severityGte: 17 } },
    { name: "time first 10%", spec: { range: { from: records[0].timeUnixNano, to: records[Math.floor(COUNT*0.1)].timeUnixNano } } },
    { name: "time+sev+body", spec: { severityGte: 13, bodyContains: "ssh", range: { from: records[0].timeUnixNano, to: records[Math.floor(COUNT*0.5)].timeUnixNano } } },
  ];
  
  console.log(`${"Query".padEnd(30)} ${"Latency".padEnd(10)} ${"Hits".padEnd(10)} ${"Scanned".padEnd(10)} ${"Pruned"}`);
  console.log("─".repeat(75));
  
  for (const q of queries) {
    query(store, q.spec); // warmup
    const t0 = performance.now();
    const res = query(store, q.spec);
    const ms = performance.now() - t0;
    console.log(`${q.name.padEnd(30)} ${(ms.toFixed(0)+"ms").padStart(7)}   ${String(res.records.length).padStart(7)}   ${res.stats.chunksScanned.toString().padStart(5)}    ${res.stats.chunksPruned}/${store.stats().chunks}`);
  }
}

// Decode breakdown
console.log(`\n═══ Decode Cost Breakdown (per 1024-record chunk) ═══\n`);
{
  const records = CORPUS_GENERATORS["syslog"](1024);
  const store = new LogStore({
    registry: defaultRegistry().register(new GzipCodec(6)).register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 1024,
  });
  const resource = { attributes: [{ key: "service.name", value: "bench-syslog" }] };
  const scope = { name: "bench", version: "0.0.0" };
  for (const r of records) store.append(resource, scope, r);
  store.flush();

  const iters = 200;
  // Full scan = full decode
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) query(store, {});
  const fullMs = (performance.now() - t0) / iters;
  
  // Body-only (no-match needle triggers body-only fast path)
  const t1 = performance.now();
  for (let i = 0; i < iters; i++) query(store, { bodyContains: "zzz_no_match_ever" });
  const bodyOnlyMs = (performance.now() - t1) / iters;

  console.log(`Full decode:      ${fullMs.toFixed(3)}ms / chunk`);
  console.log(`Body-only decode: ${bodyOnlyMs.toFixed(3)}ms / chunk`);
  console.log(`Sidecar savings:  ${(fullMs - bodyOnlyMs).toFixed(3)}ms (${((1 - bodyOnlyMs/fullMs)*100).toFixed(0)}% of time is sidecar)`);
  console.log(`Per-record:       full=${(fullMs/1024*1000).toFixed(1)}µs, body-only=${(bodyOnlyMs/1024*1000).toFixed(1)}µs`);
}
