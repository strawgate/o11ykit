#!/usr/bin/env node

/**
 * cpuprofile-query — capture a CPU profile of the query path on a
 * 500K-record store, isolating where decode time goes.
 *
 * Companion to cpuprofile-typed.mjs (which profiles ingest). This
 * script profiles a single full-decode query (warn_or_higher on
 * Apache @ z19, the cheapest-per-byte case) and the most expensive
 * full-decode (warn_or_higher on OpenStack @ z19) to see whether
 * the hot frames differ.
 *
 * Usage:
 *   node bench/cpuprofile-query.mjs
 */

import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RESULTS_DIR = join(HERE, "results");

const { loadAllAvailable } = await import("../dist-bench/corpora.js");
const { LogStore, TypedColumnarDrainPolicy, defaultRegistry, GzipCodec, ZstdCodec, query } =
  await import(join(ROOT, "dist", "index.js"));

const TARGET_RECORDS = 500_000;

function buildResource(corpusName) {
  return {
    attributes: [
      { key: "service.name", value: corpusName.toLowerCase() },
      { key: "service.instance.id", value: `${corpusName.toLowerCase()}-0` },
    ],
  };
}

function recordFromLine(line, idx) {
  let severityNumber = 9;
  let severityText = "INFO";
  const m = idx % 16;
  if (m === 7) {
    severityNumber = 13;
    severityText = "WARN";
  } else if (m === 13) {
    severityNumber = 17;
    severityText = "ERROR";
  }
  return {
    timeUnixNano: BigInt(idx) * 1_000_000_000n,
    severityNumber,
    severityText,
    body: line,
    attributes: [],
  };
}

function buildStore(corpus) {
  const store = new LogStore({
    registry: defaultRegistry()
      .register(new GzipCodec(6))
      .register(new ZstdCodec(3))
      .register(new ZstdCodec(9))
      .register(new ZstdCodec(19)),
    policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
    rowsPerChunk: 4096,
  });
  const lines = corpus.text
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const lineCount = lines.length;
  const resource = buildResource(corpus.name);
  for (let i = 0; i < TARGET_RECORDS; i++) {
    store.append(resource, { name: "o11ylogsdb-bench" }, recordFromLine(lines[i % lineCount], i));
  }
  store.flush();
  return store;
}

async function profileQuery(name, store, spec) {
  // Warmup so V8 hits steady-state code.
  for (let i = 0; i < 3; i++) query(store, spec);

  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 100 });
  await session.post("Profiler.start");

  const t0 = process.hrtime.bigint();
  const N = 10;
  let totalRecords = 0;
  for (let i = 0; i < N; i++) totalRecords += query(store, spec).records.length;
  const t1 = process.hrtime.bigint();

  const stopResult = await session.post("Profiler.stop");
  const profile = stopResult.profile;
  session.disconnect();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(RESULTS_DIR, `query-${name}-${stamp}.cpuprofile`);
  writeFileSync(outPath, JSON.stringify(profile));

  const elapsedMs = Number(t1 - t0) / 1_000_000;
  console.log(`\n=== ${name} ===`);
  console.log(
    `${N} iterations: ${elapsedMs.toFixed(0)} ms total = ${(elapsedMs / N).toFixed(1)} ms/run`
  );
  console.log(`avg records emitted: ${(totalRecords / N).toFixed(0)}`);
  console.log(`profile: ${outPath}`);

  // Self-time tally (each sample's leaf node).
  const samplesPerNode = new Map();
  for (const sid of profile.samples) {
    samplesPerNode.set(sid, (samplesPerNode.get(sid) ?? 0) + 1);
  }
  const nodeById = new Map();
  for (const node of profile.nodes) nodeById.set(node.id, node);
  const selfByFn = new Map();
  for (const [nodeId, count] of samplesPerNode) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const fn = node.callFrame.functionName || "(anonymous)";
    const url = (node.callFrame.url || "<native>").split("/").slice(-2).join("/");
    const key = `${fn}  @  ${url}:${node.callFrame.lineNumber + 1}`;
    selfByFn.set(key, (selfByFn.get(key) ?? 0) + count);
  }
  const totalSamples = profile.samples.length || 1;
  // Filter writeSync (inspector RPC noise) for the inline summary.
  const top = [...selfByFn.entries()]
    .filter(([k]) => !k.includes("writeSync"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  const writeSyncShare =
    [...selfByFn.entries()]
      .filter(([k]) => k.includes("writeSync"))
      .reduce((acc, [, n]) => acc + n, 0) / totalSamples;
  console.log(
    `(inspector writeSync overhead: ${(writeSyncShare * 100).toFixed(1)}% — excluded from list)`
  );
  for (const [key, count] of top) {
    const pct = (count / (totalSamples - totalSamples * writeSyncShare)) * 100;
    console.log(`  ${pct.toFixed(1).padStart(5)}%  ${key}`);
  }
}

const corpora = loadAllAvailable("2k");
const apache = corpora.find((c) => c.name === "Apache");
const openstack = corpora.find((c) => c.name === "OpenStack");
if (!apache || !openstack) {
  console.error("Required corpora missing");
  process.exit(1);
}

console.log(`Building Apache store (${TARGET_RECORDS.toLocaleString()} records)…`);
const apacheStore = buildStore(apache);
console.log(
  `  ${apacheStore.stats().chunks} chunks, ${apacheStore.stats().totalChunkBytes.toLocaleString()} bytes`
);

console.log(`\nBuilding OpenStack store (${TARGET_RECORDS.toLocaleString()} records)…`);
const openstackStore = buildStore(openstack);
console.log(
  `  ${openstackStore.stats().chunks} chunks, ${openstackStore.stats().totalChunkBytes.toLocaleString()} bytes`
);

await profileQuery("apache_warn_or_higher", apacheStore, { severityGte: 13 });
await profileQuery("openstack_warn_or_higher", openstackStore, { severityGte: 13 });
await profileQuery("apache_body_contains", apacheStore, { bodyContains: "[Sun" });
