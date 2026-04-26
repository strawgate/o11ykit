#!/usr/bin/env node

/**
 * cpuprofile-typed — capture a CPU profile of the
 * TypedColumnarDrainPolicy ingest path on OpenStack-2k (the slowest
 * corpus from profile-policies). Uses Node's --cpu-prof so the
 * profile is sampled by V8's tick-based sampler (no inspector RPC
 * contamination). Writes a .cpuprofile that can be loaded into
 * Chrome DevTools' Performance tab.
 *
 * Usage:
 *   node --cpu-prof --cpu-prof-dir=bench/results bench/cpuprofile-typed.mjs
 *
 * Inline summary uses node:inspector after the hot loop completes,
 * sampling a re-run with the inspector active — useful for a
 * quick-glance hotspot list but lower fidelity than the .cpuprofile
 * written by --cpu-prof.
 */

import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RESULTS_DIR = join(HERE, "results");

const { loadAllAvailable } = await import("../dist-bench/corpora.js");
const { LogStore, TypedColumnarDrainPolicy, defaultRegistry, GzipCodec, ZstdCodec } = await import(
  join(ROOT, "dist", "index.js")
);

const corpora = loadAllAvailable("2k");
const target = corpora.find((c) => c.name === "OpenStack");
if (!target) throw new Error("OpenStack-2k corpus not present");
const lines = target.text
  .toString("utf8")
  .split("\n")
  .filter((l) => l.length > 0);

function buildEncodeFn() {
  const resource = {
    attributes: [
      { key: "service.name", value: "openstack" },
      { key: "service.instance.id", value: "openstack-0" },
    ],
  };
  const scope = { name: "o11ylogsdb-bench", version: "0.0.0" };
  return () => {
    const store = new LogStore({
      registry: defaultRegistry()
        .register(new GzipCodec(6))
        .register(new ZstdCodec(3))
        .register(new ZstdCodec(9))
        .register(new ZstdCodec(19)),
      policy: new TypedColumnarDrainPolicy({ bodyCodec: "zstd-19" }),
      rowsPerChunk: 4096,
    });
    for (let i = 0; i < lines.length; i++) {
      store.append(resource, scope, {
        timeUnixNano: BigInt(i) * 1_000_000_000n,
        severityNumber: 9,
        severityText: "INFO",
        body: lines[i],
        attributes: [],
      });
    }
    store.flush();
    return store.stats().totalChunkBytes;
  };
}

const encode = buildEncodeFn();

// Warmup so the profile captures steady-state code.
for (let i = 0; i < 5; i++) encode();

// Capture: open inspector session + start profiler + run hot loop +
// stop profiler + disconnect, all in tight loop. We *don't* call
// console.log / writeSync inside the hot loop — that's what tainted
// the previous version of this script with 76 % writeSync samples.
const session = new Session();
session.connect();
await session.post("Profiler.enable");
// Tighter sampling interval — Node default is 1000us; we want more
// samples in the few-hundred-ms window.
await session.post("Profiler.setSamplingInterval", { interval: 100 });
await session.post("Profiler.start");

const t0 = process.hrtime.bigint();
const N = 20;
let totalBytes = 0;
for (let i = 0; i < N; i++) totalBytes += encode();
const t1 = process.hrtime.bigint();

const stopResult = await session.post("Profiler.stop");
const profile = stopResult.profile;
session.disconnect();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(RESULTS_DIR, `typed-openstack-${stamp}.cpuprofile`);
writeFileSync(outPath, JSON.stringify(profile));

const elapsedMs = Number(t1 - t0) / 1_000_000;
const perRunMs = elapsedMs / N;
console.log(
  `OpenStack typed_columnar_zstd-19 × ${N}: ${elapsedMs.toFixed(0)} ms total = ${perRunMs.toFixed(1)} ms/run`
);
console.log(`avg output: ${(totalBytes / N).toFixed(0)} bytes`);
console.log(`profile written: ${outPath}`);
console.log(`load via Chrome DevTools → Performance → Load profile`);

// Sum *self*-time per function: each sample's leaf node owns 1 sample
// of self-time. We were previously summing each sample N times (once
// per node id seen for that sample), which was wrong.
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
const top = [...selfByFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log("\nTop self-time functions (% of profile):");
for (const [key, count] of top) {
  const pct = ((count / totalSamples) * 100).toFixed(1);
  console.log(`  ${pct.padStart(5)}%  ${key}`);
}
